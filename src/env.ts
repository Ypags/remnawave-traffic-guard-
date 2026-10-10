import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Крошечный загрузчик .env без внешних зависимостей (вместо dotenv).
 * Поддерживает KEY=VALUE, пустые строки, комментарии (#) и значения в кавычках.
 * Переменные, уже заданные в process.env (например, через docker-compose
 * env_file/environment), имеют приоритет и не перезаписываются.
 */
export const loadEnvFile = (path = resolve(process.cwd(), '.env')): void => {
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch {
		return // .env необязателен — конфиг может прийти из окружения контейнера
	}

	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const eqIndex = trimmed.indexOf('=')
		if (eqIndex === -1) continue

		const key = trimmed.slice(0, eqIndex).trim()
		let value = trimmed.slice(eqIndex + 1).trim()

		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}

		if (process.env[key] === undefined) {
			process.env[key] = value
		}
	}
}
