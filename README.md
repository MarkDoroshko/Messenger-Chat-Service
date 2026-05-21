# Messenger-Chat-Service

Единый сервис, отвечающий за чат-функциональность:

- **WebSocket** на `/` (через тот же HTTP-порт, путь `/ws` на gateway):
  - upgrade-handshake с заголовками `X-User-Id` + `X-Gateway-Secret` от Gateway
  - входящие фреймы вида `{type:"message", to, content, clientMessageId}`
  - исходящие — доставка сообщений от других пользователей
- **HTTP** на том же порту:
  - `GET /health`
  - `GET /presence/:userId`, `POST /presence/batch` — статус online/offline + lastSeen
  - `GET /messages/with/:peerId?limit=50` — история переписки с собеседником

Этот сервис заменяет три прежних: `connection-service`, `presence-service`, `message-service`.
RabbitMQ больше не используется — сохранение и доставка выполняются прямо здесь.

## Зависимости
- PostgreSQL (БД `chat_db`, см. `init-db.sql` в репозитории `Messenger`)
- Redis (presence, ключи `online:*` и `last_seen:*`)
