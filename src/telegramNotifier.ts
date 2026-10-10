import type { Config } from './config.js'
import { logger } from './logger.js'

/**
 * Отправка алертов напрямую через Telegram Bot API (без библиотек).
 */
export class TelegramNotifier {
	constructor(private readonly config: Config) {}

	get isConfigured(): boolean {
		return Boolean(this.config.telegramBotToken && this.config.telegramChatId)
	}

	async send(text: string): Promise<void> {
		if (!this.isConfigured) {
			logger.warn('TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID не заданы — алерт только в лог', { text })
			return
		}

		const url = `https://api.telegram.org/bot${this.config.telegramBotToken}/sendMessage`

		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					chat_id: this.config.telegramChatId,
					text,
					parse_mode: 'HTML',
					disable_web_page_preview: true,
				}),
			})

			if (!res.ok) {
				const body = await res.text()
				logger.error('Telegram API вернул ошибку при отправке алерта', {
					status: res.status,
					body: body.slice(0, 300),
				})
			}
		} catch (error) {
			logger.error('Не удалось отправить алерт в Telegram', { error: String(error) })
		}
	}
}
