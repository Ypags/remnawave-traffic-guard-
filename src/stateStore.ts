import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { logger } from './logger.js'

/** Одна точка истории: момент опроса (мс) и значение lifetimeUsedTrafficBytes на тот момент. */
export interface Sample {
	t: number
	b: number
}

interface StateFileV1 {
	version: 1
	users: Record<string, Sample[]>
}

const EMPTY_STATE: StateFileV1 = { version: 1, users: {} }

/**
 * Хранилище скользящего окна трафика на диске (JSON-файл).
 *
 * Храним на пользователя минимум точек, достаточный для расчёта прироста за
 * окно: все точки внутри окна + одна последняя точка ДО начала окна (якорь,
 * относительно которого считается прирост). Это держит файл маленьким даже
 * при тысячах пользователей и долгой работе процесса.
 *
 * Запись атомарна (tmp-файл + rename), чтобы не словить битый JSON при
 * падении процесса/контейнера посередине записи — история переживает рестарт.
 */
export class StateStore {
	private state: StateFileV1 = EMPTY_STATE

	constructor(private readonly filePath: string) {}

	load(): void {
		try {
			const raw = readFileSync(this.filePath, 'utf8')
			const parsed = JSON.parse(raw) as StateFileV1
			if (parsed.version === 1 && parsed.users) {
				this.state = parsed
				logger.info('Состояние окна загружено с диска', {
					file: this.filePath,
					users: Object.keys(parsed.users).length,
				})
				return
			}
			logger.warn('Файл состояния имеет неизвестный формат, начинаю с чистого листа', {
				file: this.filePath,
			})
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				logger.warn('Не удалось прочитать файл состояния, начинаю с чистого листа', {
					file: this.filePath,
					error: String(error),
				})
			}
		}
		this.state = { version: 1, users: {} }
	}

	getSamples(userId: number): Sample[] {
		return this.state.users[String(userId)] ?? []
	}

	/**
	 * Добавляет новую точку и обрезает историю: оставляет все точки внутри
	 * окна [now - windowMs, now] плюс одну последнюю точку старше этого окна
	 * (якорь для расчёта прироста).
	 */
	recordSample(userId: number, sample: Sample, windowMs: number): void {
		const key = String(userId)
		const samples = this.state.users[key] ?? []
		samples.push(sample)
		samples.sort((a, b) => a.t - b.t)

		const cutoff = sample.t - windowMs
		let anchorIndex = -1
		for (let i = 0; i < samples.length; i++) {
			if (samples[i]!.t <= cutoff) anchorIndex = i
			else break
		}

		this.state.users[key] = anchorIndex >= 0 ? samples.slice(anchorIndex) : samples
	}

	/** Полностью заменяет историю пользователя одной точкой (используется при обнаружении сброса счётчика). */
	resetUser(userId: number, sample: Sample): void {
		this.state.users[String(userId)] = [sample]
	}

	/** Удаляет пользователей, по которым нет точек свежее maxAgeMs (например, удалённые из панели). */
	pruneStaleUsers(maxAgeMs: number, now: number): void {
		for (const key of Object.keys(this.state.users)) {
			const samples = this.state.users[key]!
			const last = samples[samples.length - 1]
			if (!last || now - last.t > maxAgeMs) {
				delete this.state.users[key]
			}
		}
	}

	persist(): void {
		mkdirSync(dirname(this.filePath), { recursive: true })
		const tmpPath = `${this.filePath}.tmp`
		writeFileSync(tmpPath, JSON.stringify(this.state))
		renameSync(tmpPath, this.filePath)
	}
}
