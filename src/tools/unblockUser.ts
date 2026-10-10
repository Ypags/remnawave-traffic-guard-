import { appendActionLog } from '../actionsLog.js'
import { loadConfig } from '../config.js'
import { logger } from '../logger.js'
import { RemnawaveClient } from '../remnawaveClient.js'

/**
 * Утилита для ручного возврата пользователя, если traffic-guard отключил его
 * по ошибке: npm run unblock -- <userId>
 *
 * userId — числовой id пользователя в Remnawave (его видно в панели или в
 * логах/аудите traffic-guard: data/actions.jsonl).
 */
const main = async (): Promise<void> => {
	const arg = process.argv[2]
	const userId = Number(arg)

	if (!arg || !Number.isInteger(userId)) {
		console.error('Использование: npm run unblock -- <userId>')
		console.error('userId — числовой id пользователя Remnawave (см. data/actions.jsonl или панель)')
		process.exit(1)
	}

	const config = loadConfig()
	const client = new RemnawaveClient(config)

	const before = await client.getUserById(userId)
	logger.info('Текущий статус пользователя', {
		userId: before.id,
		username: before.username,
		status: before.status,
	})

	if (before.status !== 'DISABLED') {
		logger.warn('Пользователь не в статусе DISABLED — всё равно отправляю enable', {
			status: before.status,
		})
	}

	const after = await client.enableUser(userId)
	logger.info('Пользователь включён обратно', {
		userId: after.id,
		username: after.username,
		status: after.status,
	})

	appendActionLog(config.actionsLogPath, {
		t: new Date().toISOString(),
		action: 'enable',
		userId: after.id,
		username: after.username,
		telegramId: after.telegramId,
		reason: 'manual unblock',
	})
}

main().catch((error) => {
	logger.error('Не удалось вернуть пользователя', { error: String(error) })
	process.exit(1)
})
