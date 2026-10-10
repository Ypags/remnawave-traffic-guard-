# remnawave-traffic-guard

Сторонний сервис для панели [Remnawave](https://remna.st): автоматически
отключает пользователей, которые потребили больше лимита трафика за
скользящее окно времени (по умолчанию **100 ГБ за час**; лимит и окно
настраиваются).

Работает отдельным процессом или контейнером: обращается к панели только по
HTTP API, не зависит от других сервисов и не трогает их код и БД.

Пути API и формат ответов сверены с исходниками `remnawave/backend` (ветка
`main`, на момент написания — версия **3.4.5**): `libs/contract/api/routes.ts`,
`libs/contract/models/extended-users.schema.ts`,
`libs/contract/models/user-traffic.schema.ts`. Если вы используете панель
другой major-версии — проверьте по тем же файлам, что пути не изменились.

## Как это работает

1. Раз в `POLL_INTERVAL_SECONDS` (по умолчанию 5 минут) сервис выгружает всех
   пользователей через `GET /api/users` (постранично, без фильтров — панель
   сама предупреждает в Swagger, что фильтры там на `LIKE` и дорогие).
2. У каждого пользователя берётся `userTraffic.lifetimeUsedTrafficBytes` —
   это накопительный счётчик **за всё время**, который не затрагивается
   периодическим сбросом по `trafficLimitStrategy` (в отличие от
   `userTraffic.usedTrafficBytes`, который сбрасывается). Именно поэтому для
   расчёта скользящего окна используется он.
3. Каждое значение складывается в локальную историю на диске
   (`data/state.json`) с таймстампом. Храним только то, что нужно: все точки
   внутри окна + одна точка "до" окна (якорь) — остальное не копится, так что
   файл не растёт бесконечно даже на тысячах пользователей.
4. Прирост = `последнее_значение − значение_на_начало_окна`. Если прирост
   `>= TRAFFIC_LIMIT_GB`, пользователь — кандидат на отключение.
5. **Предохранитель**: если кандидатов за один проход больше
   `CIRCUIT_BREAKER_MAX_USERS` **или** больше `CIRCUIT_BREAKER_MAX_PERCENT`%
   от просканированных активных пользователей — никого не отключаем, пишем в
   лог и шлём алерт в Telegram ("вероятно, что-то сломалось": сброс счётчиков
   в панели, баг правила, аномалия у всех сразу и т.п.).
6. Если предохранитель не сработал — отключаем кандидатов через
   `POST /api/users/{id}/actions/disable` и шлём один сводный алерт в Telegram.
7. Все действия (отключение/срабатывание предохранителя/ручной возврат)
   пишутся в `data/actions.jsonl` — построчный JSON-журнал для аудита.
8. История окна лежит на диске и переживает перезапуск контейнера/процесса.

## Структура проекта

```
src/
  config.ts          — чтение и валидация .env
  env.ts             — мини-загрузчик .env (без зависимости от dotenv)
  remnawaveClient.ts — HTTP-клиент панели (fetch, без axios)
  stateStore.ts       — скользящее окно на диске
  trafficGuard.ts     — основной цикл: опрос → расчёт → предохранитель → действие
  telegramNotifier.ts — алерты напрямую в Telegram Bot API
  actionsLog.ts       — JSONL-журнал действий
  tools/unblockUser.ts — CLI для возврата пользователя
  index.ts            — точка входа, планировщик, graceful shutdown
```

Зависимости: **0 runtime** (используется встроенный в Node 20 `fetch`), в
dev — только `typescript` и `@types/node`.

## 1. Создание API-токена в Remnawave

Отдельный `REMNAWAVE_API_TOKEN` для этого сервиса — **не** используйте
Admin JWT и не переиспользуйте токены других сервисов, чтобы в случае
утечки/компрометации область действий была минимальной.

1. Зайдите в веб-панель Remnawave под админом.
2. Откройте **Settings → карточка "API Tokens"**.
3. **Create** → укажите имя (например `remnawave-traffic-guard`).
4. **Expiration (days)** — минимум 1 день, "бессрочных" токенов в Remnawave
   нет. Поставьте большой срок (например `365`) и держите в курсе, что токен
   придётся пересоздать до истечения — иначе сервис начнёт получать `401` и
   перестанет видеть новых кандидатов (но не упадёт, просто будет писать
   ошибку в лог каждый цикл).
5. В списке ресурсов (scopes) найдите **`users`** и включите **Read** и
   **Write** (нужны: Read — для списка пользователей и трафика, Write — для
   `actions/disable` и `actions/enable`). Больше ничего не включайте.
6. Скопируйте значение токена — панель показывает его **один раз**.
7. Если панель закрыта Cloudflare Zero Trust Access — заведите Service Token
   в Cloudflare Dashboard → Zero Trust → Access → Service Tokens и впишите
   в `CF_CLIENT_ID` / `CF_CLIENT_SECRET`.

## 2. Настройка .env

```bash
cp .env.example .env
```

Ключевые переменные (полный список с комментариями — в `.env.example`):

| Переменная | По умолчанию | Что это |
|---|---|---|
| `REMNAWAVE_URL` | — | URL панели, например `https://panel.example.com` |
| `REMNAWAVE_API_TOKEN` | — | токен из шага 1 |
| `CF_CLIENT_ID`, `CF_CLIENT_SECRET` | — | только если панель за Cloudflare Access |
| `TRAFFIC_LIMIT_GB` | `100` | лимит трафика за окно |
| `WINDOW_MINUTES` | `60` | размер скользящего окна |
| `POLL_INTERVAL_SECONDS` | `300` | как часто опрашивать панель |
| `CIRCUIT_BREAKER_MAX_USERS` | `5` | предохранитель: абсолютное число кандидатов |
| `CIRCUIT_BREAKER_MAX_PERCENT` | `10` | предохранитель: % от активных пользователей |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | куда слать алерты (см. ниже) |

### Алерты в Telegram

Задайте токен любого Telegram-бота и `TELEGRAM_CHAT_ID` — личный `chat_id`
или id группы админов (узнать свой `chat_id` можно, написав
[@userinfobot](https://t.me/userinfobot)). Сервис только шлёт `sendMessage`.
Если не задать — алерты будут только в лог контейнера.

## 3. Деплой

Сервис рассчитан на отдельный контейнер с лимитами CPU/RAM.

```bash
git clone <url-репозитория> remnawave-traffic-guard
cd remnawave-traffic-guard
cp .env.example .env
nano .env   # заполнить REMNAWAVE_URL / REMNAWAVE_API_TOKEN / TELEGRAM_*

docker compose up -d --build
```

`docker-compose.yml` уже содержит лимиты:

```yaml
deploy:
  resources:
    limits:
      cpus: '0.3'
      memory: 150M
```

Это Compose v2 — работает с обычным `docker compose up` без режима swarm. Если
у вас старый `docker-compose` (v1, бинарник на Python) — он секцию `deploy`
игнорирует, раскомментируйте в файле `mem_limit: 150m` / `cpus: 0.3` (это
эквивалент для старого формата).

Том `./data` монтируется в контейнер, чтобы история окна и журнал действий
переживали `docker compose restart`/обновление образа.

**Альтернатива — добавить как сервис в существующий `docker-compose.yml`:**

```yaml
  remnawave-traffic-guard:
    build: ./remnawave-traffic-guard
    container_name: remnawave-traffic-guard
    env_file:
      - ./remnawave-traffic-guard/.env
    volumes:
      - ./remnawave-traffic-guard/data:/app/data
    restart: unless-stopped
    deploy:
      resources:
        limits:
          cpus: '0.3'
          memory: 150M
```

**Альтернатива без Docker** (systemd): собрать `npm ci && npm run build`,
запускать `node dist/index.js` юнитом с ограничением ресурсов через cgroups:

```ini
# /etc/systemd/system/remnawave-traffic-guard.service
[Unit]
Description=remnawave-traffic-guard
After=network.target

[Service]
WorkingDirectory=/opt/remnawave-traffic-guard
EnvironmentFile=/opt/remnawave-traffic-guard/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
MemoryMax=150M
CPUQuota=30%
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now remnawave-traffic-guard
```

## 4. Проверка после запуска

```bash
docker compose logs -f remnawave-traffic-guard
```

Что смотреть:
- `Прогон завершён` с `scannedTotal/scannedActive/candidates` — должно расти
  `scannedTotal` на размер базы пользователей, `candidates` в норме — 0 или
  около того.
- `Пользователь отключён за превышение трафика` — если появляется для реально
  "тяжёлых" пользователей (можно сверить вручную в панели по
  `userId`/`username`), логика работает верно.
- Если задан Telegram — отключения продублируются туда же одним сообщением
  за проход.
- Файл `data/actions.jsonl` — построчный журнал всех `disable`.

Имейте в виду: **полный час истории набирается не сразу**. Если контейнер
только запущен, сервису нужно собрать точки, покрывающие весь
`WINDOW_MINUTES` (по умолчанию 12 опросов по 5 минут ≈ час), прежде чем он
начнёт оценивать прирост — это нормально, не баг.

Рекомендация: первое время держите `CIRCUIT_BREAKER_MAX_USERS` небольшим
(5 по умолчанию) — лучше лишний раз получить алерт "предохранитель сработал,
проверь руками", чем массово отключить пользователей из-за, например,
временного сбоя подсчёта трафика в самой панели.

## 5. Как вернуть пользователя, если отключили по ошибке

Самый быстрый способ — встроенная утилита (использует тот же API-клиент, что
и основной сервис):

```bash
docker compose exec remnawave-traffic-guard node dist/tools/unblockUser.js <userId>
# или если без Docker:
npm run unblock -- <userId>
```

`<userId>` — числовой id пользователя Remnawave (не Telegram id!). Его можно
найти:
- в `data/actions.jsonl` — в записи с `"action":"disable"` для этого
  пользователя (там же есть `telegramId`, чтобы сопоставить с человеком);
- в самой панели — карточка пользователя.

Утилита выведет статус до/после и допишет запись `"action":"enable"` в
`actions.jsonl`.

Без утилиты — то же самое напрямую через API панели:

```bash
curl -X POST "$REMNAWAVE_URL/api/users/<userId>/actions/enable" \
  -H "Authorization: Bearer $REMNAWAVE_API_TOKEN"
```

(добавьте `-H "CF-Access-Client-Id: ..."` и `-H "CF-Access-Client-Secret: ..."`,
если панель закрыта Cloudflare Access).

## Безопасность токена

`REMNAWAVE_API_TOKEN` даёт доступ на чтение списка/трафика пользователей и
на их отключение/включение — храните `.env` с правами `600` и не кладите в
git (`.gitignore` уже это учитывает). Токен ограничен scope `users:read` +
`users:write` (шаг 1), так что даже при утечке он не даст доступа к нодам,
другим настройкам панели или созданию новых админ-токенов.
