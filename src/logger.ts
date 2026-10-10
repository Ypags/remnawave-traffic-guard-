/** Простой логгер в stdout/stderr с таймстампом — без зависимостей (docker logs всё соберёт). */

const timestamp = (): string => new Date().toISOString()

export const logger = {
	info: (message: string, meta?: Record<string, unknown>): void => {
		console.log(`[${timestamp()}] INFO  ${message}`, meta ? JSON.stringify(meta) : '')
	},
	warn: (message: string, meta?: Record<string, unknown>): void => {
		console.warn(`[${timestamp()}] WARN  ${message}`, meta ? JSON.stringify(meta) : '')
	},
	error: (message: string, meta?: Record<string, unknown>): void => {
		console.error(`[${timestamp()}] ERROR ${message}`, meta ? JSON.stringify(meta) : '')
	},
}
