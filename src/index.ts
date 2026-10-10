import { loadConfig } from './config.js'
import { logger } from './logger.js'
import { TrafficGuard } from './trafficGuard.js'

const main = (): void => {
	const config = loadConfig()
	const guard = new TrafficGuard(config)

	const shutdown = (signal: string): void => {
		logger.info(`Получен ${signal}, останавливаюсь`)
		guard.stop()
		process.exit(0)
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))
	process.on('unhandledRejection', (reason) => {
		logger.error('Необработанный rejection, продолжаю работу', { reason: String(reason) })
	})

	guard.start()
}

main()
