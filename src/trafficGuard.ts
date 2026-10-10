import { appendActionLog } from './actionsLog.js'
import type { Config } from './config.js'
import { logger } from './logger.js'
import { RemnawaveClient, type RemnawaveUser } from './remnawaveClient.js'
import { StateStore } from './stateStore.js'
import { TelegramNotifier } from './telegramNotifier.js'

const STALE_USER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // не видели в выгрузке 7 дней — забываем историю

const formatGb = (bytes: number): string => `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`

interface Candidate {
	user: RemnawaveUser
	incrementBytes: number
}

/** Результат расчёта прироста трафика пользователя за окно. */
type GrowthResult =
	| { kind: 'ok'; incrementBytes: number }
	| { kind: 'insufficient-history' }
	| { kind: 'counter-reset' }

const evaluateGrowth = (store: StateStore, userId: number, windowMs: number): GrowthResult => {
	const samples = store.getSamples(userId)
	if (samples.length < 2) return { kind: 'insufficient-history' }

	const oldest = samples[0]!
	const latest = samples[samples.length - 1]!
	const cutoff = latest.t - windowMs

	// Самая старая точка в истории всё ещё внутри окна — значит, процесс не
	// работал достаточно долго (или пользователь только появился), чтобы
	// покрыть полное окно. Копим данные дальше, не оцениваем.
	if (oldest.t > cutoff) return { kind: 'insufficient-history' }

	const delta = latest.b - oldest.b
	if (delta < 0) return { kind: 'counter-reset' }

	return { kind: 'ok', incrementBytes: delta }
}

export class TrafficGuard {
	private readonly client: RemnawaveClient
	private readonly store: StateStore
	private readonly notifier: TelegramNotifier

	constructor(private readonly config: Config) {
		this.client = new RemnawaveClient(config)
		this.store = new StateStore(config.stateFilePath)
		this.notifier = new TelegramNotifier(config)
	}

	start(): void {
		this.store.load()
		logger.info('remnawave-traffic-guard запущен', {
			limit: formatGb(this.config.trafficLimitBytes),
			windowMinutes: this.config.windowMs / 60_000,
			pollIntervalSeconds: this.config.pollIntervalMs / 1000,
		})

		void this.runCycle() // первый прогон сразу, не дожидаясь первого интервала
		this.timer = setInterval(() => void this.runCycle(), this.config.pollIntervalMs)
	}

	private timer: NodeJS.Timeout | undefined

	stop(): void {
		if (this.timer) clearInterval(this.timer)
	}

	async runCycle(): Promise<void> {
		const now = Date.now()
		const candidates: Candidate[] = []
		let scannedActive = 0
		let scannedTotal = 0

		try {
			for await (const page of this.client.iterateAllUsers(this.config.pageSize)) {
				for (const user of page) {
					scannedTotal++
					const bytes = user.userTraffic.lifetimeUsedTrafficBytes

					this.store.recordSample(user.id, { t: now, b: bytes }, this.config.windowMs)
					const growth = evaluateGrowth(this.store, user.id, this.config.windowMs)

					if (growth.kind === 'counter-reset') {
						logger.info('Обнаружен сброс накопительного счётчика трафика, перезапускаю историю', {
							userId: user.id,
							username: user.username,
						})
						this.store.resetUser(user.id, { t: now, b: bytes })
						continue
					}

					if (growth.kind === 'insufficient-history') continue
					if (user.status !== 'ACTIVE') continue

					scannedActive++

					if (growth.incrementBytes >= this.config.trafficLimitBytes) {
						candidates.push({ user, incrementBytes: growth.incrementBytes })
					}
				}
			}
		} catch (error) {
			logger.error('Прогон остановлен из-за ошибки запроса к Remnawave, попробую в следующий раз', {
				error: String(error),
			})
			return // не трогаем state.persist() с частично собранными данными этого прогона
		}

		this.store.pruneStaleUsers(STALE_USER_MAX_AGE_MS, now)
		this.store.persist()

		logger.info('Прогон завершён', {
			scannedTotal,
			scannedActive,
			candidates: candidates.length,
		})

		if (candidates.length === 0) return

		if (this.isCircuitBreakerTripped(candidates.length, scannedActive)) {
			await this.handleCircuitBreaker(candidates, scannedActive)
			return
		}

		await this.handleCandidates(candidates)
	}

	private isCircuitBreakerTripped(candidatesCount: number, scannedActive: number): boolean {
		if (candidatesCount > this.config.circuitBreakerMaxUsers) return true
		if (scannedActive === 0) return false
		const percent = (candidatesCount / scannedActive) * 100
		return percent > this.config.circuitBreakerMaxPercent
	}

	private async handleCircuitBreaker(candidates: Candidate[], scannedActive: number): Promise<void> {
		const percent = scannedActive > 0 ? ((candidates.length / scannedActive) * 100).toFixed(1) : 'н/д'

		logger.error('ПРЕДОХРАНИТЕЛЬ: слишком много кандидатов на отключение за один проход, никого не трогаю', {
			candidates: candidates.length,
			scannedActive,
			percent,
		})

		appendActionLog(this.config.actionsLogPath, {
			t: new Date().toISOString(),
			action: 'circuit-breaker',
			reason: `${candidates.length} кандидатов из ${scannedActive} активных (${percent}%)`,
		})

		const list = candidates
			.slice(0, 20)
			.map((c) => `• ${this.describeUser(c.user)} — +${formatGb(c.incrementBytes)}`)
			.join('\n')
		const more = candidates.length > 20 ? `\n…и ещё ${candidates.length - 20}` : ''

		await this.notifier.send(
			'🛑 <b>remnawave-traffic-guard: предохранитель сработал</b>\n\n' +
				`Под отключение попало <b>${candidates.length}</b> из ${scannedActive} активных пользователей (${percent}%).\n` +
				`Это больше лимита (абсолютный: ${this.config.circuitBreakerMaxUsers}, процентный: ${this.config.circuitBreakerMaxPercent}%).\n` +
				'Никого не отключаю — похоже, что-то сломалось (сброс счётчиков в панели, баг в правиле, аномальный трафик у всех и т.п.). Проверь вручную.\n\n' +
				`${list}${more}`,
		)
	}

	private async handleCandidates(candidates: Candidate[]): Promise<void> {
		const disabled: Candidate[] = []
		const failed: { candidate: Candidate; error: string }[] = []

		for (const candidate of candidates) {
			const { user, incrementBytes } = candidate

			try {
				await this.client.disableUser(user.id)
				logger.warn('Пользователь отключён за превышение трафика', {
					userId: user.id,
					username: user.username,
					telegramId: user.telegramId,
					incrementGb: formatGb(incrementBytes),
				})
				appendActionLog(this.config.actionsLogPath, {
					t: new Date().toISOString(),
					action: 'disable',
					userId: user.id,
					username: user.username,
					telegramId: user.telegramId,
					incrementBytes,
				})
				disabled.push(candidate)
			} catch (error) {
				logger.error('Не удалось отключить пользователя', {
					userId: user.id,
					username: user.username,
					error: String(error),
				})
				failed.push({ candidate, error: String(error) })
			}
		}

		await this.sendSummary(disabled, failed)
	}

	private async sendSummary(
		disabled: Candidate[],
		failed: { candidate: Candidate; error: string }[],
	): Promise<void> {
		if (disabled.length === 0 && failed.length === 0) return

		const lines: string[] = ['⚠️ <b>remnawave-traffic-guard</b>', '']
		if (disabled.length > 0) {
			lines.push(
				`Отключил ${disabled.length} пользователь(ей) за превышение ${formatGb(this.config.trafficLimitBytes)} / ${this.config.windowMs / 60_000} мин:`,
			)
			for (const c of disabled) {
				lines.push(`• ${this.describeUser(c.user)} — +${formatGb(c.incrementBytes)}`)
			}
		}
		if (failed.length > 0) {
			lines.push('', `Не удалось отключить (${failed.length}):`)
			for (const f of failed) {
				lines.push(`• ${this.describeUser(f.candidate.user)} — ${f.error}`)
			}
		}

		await this.notifier.send(lines.join('\n'))
	}

	private describeUser(user: RemnawaveUser): string {
		const parts = [`id=${user.id}`, user.username]
		if (user.telegramId) parts.push(`tg=${user.telegramId}`)
		return parts.join(' ')
	}
}
