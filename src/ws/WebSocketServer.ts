import { WebSocketServer, WebSocket } from 'ws'
import { clearInterval } from 'node:timers'
import { IncomingMessage, Server as HttpServer } from 'node:http'
import { v4 as uuid } from 'uuid'
import { saveMessage } from '../db/messages'
import { addContact, hasContact } from '../db/contacts'
import { fetchUser } from '../users/UserClient'

const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? ''
const INSTANCE_ID = process.env.INSTANCE_ID ?? `chat-${Math.random().toString(36).slice(2, 8)}`

const userConnections = new Map<string, Set<WebSocket>>()

function addConn(userId: string, ws: WebSocket) {
    let set = userConnections.get(userId)
    if (!set) { set = new Set(); userConnections.set(userId, set) }
    set.add(ws)
}

function removeConn(userId: string, ws: WebSocket) {
    const set = userConnections.get(userId)
    if (!set) return
    set.delete(ws)
    if (set.size === 0) userConnections.delete(userId)
}

function deliverLocal(userId: string, payload: object) {
    const set = userConnections.get(userId)
    if (!set || set.size === 0) return false
    const data = JSON.stringify(payload)
    let delivered = false
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) {
            ws.send(data)
            delivered = true
        }
    }
    return delivered
}

/**
 * Если у получателя ещё нет отправителя в контактах — добавляем (Telegram-like UX).
 * Любая ошибка тут не должна валить доставку.
 */
async function ensureContactForRecipient(ownerId: string, peerId: string) {
    try {
        const exists = await hasContact(ownerId, peerId)
        if (exists) return
        const user = await fetchUser(peerId)
        await addContact(ownerId, peerId, user.displayName)
    } catch (err) {
        console.warn('[chat-service] auto-add contact failed:', err)
    }
}

export function attachWebSocket(server: HttpServer) {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request)
        })
    })

    if (!GATEWAY_SECRET) {
        console.warn('[chat-service] WARNING: GATEWAY_SECRET is empty — connections will be rejected')
    }
    console.log(`[chat-service] WebSocket attached, instance=${INSTANCE_ID}`)

    wss.on('connection', (ws, request) => {
        const gatewaySecret = request.headers['x-gateway-secret']
        const userIdHeader = request.headers['x-user-id']

        if (!GATEWAY_SECRET || gatewaySecret !== GATEWAY_SECRET) {
            console.warn('[chat-service] rejected: bad X-Gateway-Secret')
            ws.close(4401, 'unauthorized')
            return
        }
        if (!userIdHeader || Array.isArray(userIdHeader)) {
            console.warn('[chat-service] rejected: missing X-User-Id')
            ws.close(4400, 'no user id')
            return
        }
        const userId = userIdHeader

        // keepalive ping/pong (только для здоровья соединения, никаких статусов)
        let isAlive = true
        const pingInterval = setInterval(() => {
            if (!isAlive) {
                ws.terminate()
                return
            }
            isAlive = false
            try { ws.ping() } catch {}
        }, 30_000)

        addConn(userId, ws)
        console.log(`[chat-service] user ${userId} connected`)

        ws.on('message', async (raw) => {
            let parsed: any
            try {
                parsed = JSON.parse(raw.toString())
            } catch {
                ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }))
                return
            }

            if (parsed?.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }))
                return
            }

            if (parsed?.type !== 'message' || typeof parsed.to !== 'string' || typeof parsed.content !== 'string') {
                ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }))
                return
            }

            try {
                const saved = await saveMessage({
                    id: uuid(),
                    from: userId,
                    to: parsed.to,
                    content: parsed.content,
                })

                ws.send(JSON.stringify({
                    type: 'ack',
                    clientMessageId: parsed.clientMessageId,
                    id: saved.id,
                    accepted: true,
                }))

                // Авто-добавление: получатель должен видеть отправителя в контактах
                ensureContactForRecipient(saved.to, saved.from)

                deliverLocal(saved.to, {
                    type: 'message',
                    id: saved.id,
                    from: saved.from,
                    to: saved.to,
                    content: saved.content,
                    createdAt: saved.createdAt,
                })
            } catch (err) {
                console.error('[chat-service] handle message failed:', err)
                ws.send(JSON.stringify({
                    type: 'ack',
                    clientMessageId: parsed.clientMessageId,
                    accepted: false,
                    error: 'server_error',
                }))
            }
        })

        ws.on('close', () => {
            clearInterval(pingInterval)
            removeConn(userId, ws)
            console.log(`[chat-service] user ${userId} disconnected`)
        })

        ws.on('pong', () => {
            isAlive = true
        })
    })
}
