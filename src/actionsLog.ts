import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Аудит-лог предпринятых действий (JSON Lines, по одной записи на строку).
 * Нужен, чтобы быстро найти, кого и когда отключили (и вручную вернуть при
 * ошибке — см. README, раздел "как вернуть пользователя").
 */
export interface ActionLogEntry {
	t: string // ISO-время
	action: 'disable' | 'enable' | 'circuit-breaker'
	userId?: number
	username?: string
	telegramId?: number | null
	incrementBytes?: number
	reason?: string
}

export const appendActionLog = (filePath: string, entry: ActionLogEntry): void => {
	mkdirSync(dirname(filePath), { recursive: true })
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`)
}
