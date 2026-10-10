# remnawave-traffic-guard

Сторонний сервис для панели [Remnawave](https://remna.st): автоматически
отключает пользователей, которые потребили больше лимита трафика за
скользящее окно времени (по умолчанию **100 ГБ за час**; лимит и окно
настраиваются).

Работает отдельным контейнером: обращается к панели только по HTTP API, не
зависит от других сервисов и не трогает их код и БД.

## Быстрый старт

1. В панели Remnawave создайте API-токен (**Settings → API Tokens**) со
   scope `users`: **Read** + **Write**. Не используйте Admin JWT.
2. На сервере:

```bash
git clone https://github.com/Ypags/remnawave-traffic-guard-.git remnawave-traffic-guard
cd remnawave-traffic-guard
cp .env.example .env
nano .env
```

Заполните минимум:

```env
REMNAWAVE_URL=https://panel.example.com
REMNAWAVE_API_TOKEN=ваш_токен
```

Если панель за Cloudflare Access — добавьте `CF_CLIENT_ID` /
`CF_CLIENT_SECRET`. Для алертов в Telegram — `TELEGRAM_BOT_TOKEN` и
`TELEGRAM_CHAT_ID`.

3. Запуск:

```bash
docker compose up -d --build
docker compose logs -f remnawave-traffic-guard
```

Ожидайте строку `Прогон завершён` с ненулевым `scannedTotal` — значит панель
доступна и токен рабочий. Полный час истории набирается не сразу: пока не
наберётся окно `WINDOW_MINUTES`, кандидатов на отключение почти не будет —
это нормально.

---

## Как это работает

1. Раз в `POLL_INTERVAL_SECONDS` (по умолчанию 5 минут) сервис выгружает всех
   пользователей через `GET /api/users` (постранично, без фильтров — панель
   сама предупреждает в Swagger, что фильтры там на `LIKE` и дорогие).
2. У каждого пользователя берётся `userTraffic.lifetimeUsedTrafficBytes` —
   накопительный счётчик **за всё время**, который не затрагивается
   периодическим сбросом по `trafficLimitStrategy` (в отличие от
   `userTraffic.usedTrafficBytes`). Именно поэтому для скользящего окна
   используется он.
3. Каждое значение складывается в локальную историю на диске
   (`data/state.json`) с таймстампом. Храним только точки внутри окна + одну
   точку «до» окна (якорь) — файл не растёт бесконечно.
4. Прирост = `последнее_значение − значение_на_начало_окна`. Если прирост
   `>= TRAFFIC_LIMIT_GB`, пользователь — кандидат на отключение.
5. **Предохранитель**: если кандидатов за один проход больше
   `CIRCUIT_BREAKER_MAX_USERS` **или** больше `CIRCUIT_BREAKER_MAX_PERCENT`%
   от активных — никого не отключаем, пишем в лог и шлём алерт в Telegram.
6. Иначе отключаем кандидатов через
   `POST /api/users/{id}/actions/disable` и шлём сводный алерт.
7. Все действия пишутся в `data/actions.jsonl` (аудит).
8. История окна лежит на диске и переживает перезапуск контейнера.

Пути API сверены с `remnawave/backend` (версия **3.4.5**). На другой
major-версии панели проверьте, что маршруты не изменились.

## Переменные окружения

Полный список с комментариями — в `.env.example`.

| Переменная | По умолчанию | Что это |
|---|---|---|
| `REMNAWAVE_URL` | — | URL панели, например `https://panel.example.com` |
| `REMNAWAVE_API_TOKEN` | — | токен из панели |
| `CF_CLIENT_ID`, `CF_CLIENT_SECRET` | — | если панель за Cloudflare Access |
| `TRAFFIC_LIMIT_GB` | `100` | лимит трафика за окно |
| `WINDOW_MINUTES` | `60` | размер скользящего окна |
| `POLL_INTERVAL_SECONDS` | `300` | как часто опрашивать панель |
| `CIRCUIT_BREAKER_MAX_USERS` | `5` | предохранитель: абсолютное число кандидатов |
| `CIRCUIT_BREAKER_MAX_PERCENT` | `10` | предохранитель: % от активных пользователей |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | — | алерты в Telegram |

### API-токен

1. Панель Remnawave → **Settings → API Tokens → Create**.
2. Имя любое, например `remnawave-traffic-guard`.
3. **Expiration (days)** — бессрочных токенов нет; поставьте большой срок
   (например `365`) и пересоздайте до истечения, иначе сервис начнёт получать
   `401` каждый цикл.
4. Scope **`users`**: Read + Write. Больше ничего не включайте.
5. Токен показывается **один раз** — сразу скопируйте в `.env`.

### Алерты в Telegram

Токен любого бота + `TELEGRAM_CHAT_ID` (личный или группы; узнать id можно у
[@userinfobot](https://t.me/userinfobot)). Сервис только шлёт `sendMessage`.
Если не задать — алерты только в лог контейнера.

## Деплой (подробнее)

`docker-compose.yml` ограничивает ресурсы, чтобы сервис не мешал соседним
процессам на хосте:

```yaml
deploy:
  resources:
    limits:
      cpus: '0.3'
      memory: 150M
```

Compose v2 понимает `deploy` без swarm. У старого `docker-compose` v1 секция
игнорируется — раскомментируйте в файле `mem_limit: 150m` / `cpus: 0.3`.

Том `./data` хранит историю окна и журнал действий между рестартами.

**Как второй сервис в чужом `docker-compose.yml`:**

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

## Проверка после запуска

```bash
docker compose logs -f remnawave-traffic-guard
```

- `Прогон завершён` с `scannedTotal/scannedActive/candidates` — панель
  отвечает; `candidates` в норме обычно `0`.
- `Пользователь отключён за превышение трафика` — срабатывание правила
  (сверьте `userId`/`username` в панели).
- Telegram — сводка за проход, если заданы токен и chat_id.
- `data/actions.jsonl` — журнал всех `disable`.

Первое время держите `CIRCUIT_BREAKER_MAX_USERS` небольшим (5 по умолчанию):
лучше лишний алерт «предохранитель», чем массовое отключение из‑за сбоя
счётчиков в панели.

## Вернуть пользователя

```bash
docker compose exec remnawave-traffic-guard node dist/tools/unblockUser.js <userId>
```

`<userId>` — числовой id Remnawave (не Telegram). Найти можно в
`data/actions.jsonl` (`"action":"disable"`) или в карточке пользователя в
панели.

Или напрямую через API:

```bash
curl -X POST "$REMNAWAVE_URL/api/users/<userId>/actions/enable" \
  -H "Authorization: Bearer $REMNAWAVE_API_TOKEN"
```

(при Cloudflare Access добавьте заголовки `CF-Access-Client-Id` и
`CF-Access-Client-Secret`).

## Безопасность токена

`REMNAWAVE_API_TOKEN` даёт чтение пользователей/трафика и
disable/enable. Храните `.env` с правами `600`, не коммитьте в git
(`.gitignore` уже исключает). Scope только `users:read` + `users:write` —
при утечке нет доступа к нодам и настройкам панели.

## Структура проекта

```
src/
  config.ts          — чтение и валидация .env
  env.ts             — мини-загрузчик .env
  remnawaveClient.ts — HTTP-клиент панели
  stateStore.ts       — скользящее окно на диске
  trafficGuard.ts     — основной цикл
  telegramNotifier.ts — алерты в Telegram
  actionsLog.ts       — JSONL-журнал действий
  tools/unblockUser.ts — CLI возврата пользователя
  index.ts            — точка входа
```

Runtime-зависимостей нет (Node 20 `fetch`). В dev — `typescript` и
`@types/node`.
