import { WebSocketServer, WebSocket } from 'ws'
import { clearInterval } from 'node:timers'
import { IncomingMessage, Server as HttpServer } from 'node:http'
import { v4 as uuid } from 'uuid'
import { getPresence, refreshOnline, setOffline, setOnline } from '../redis/RedisClient'
import { saveMessage } from '../db/messages'
import { cleanupSession, getWatchersOf, subscribe, unsubscribe } from '../presence/Subscriptions'

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

async function broadcastPresence(userId: string) {
    const observers = getWatchersOf(userId)
    if (!observers || observers.size === 0) return
    const presence = await getPresence(userId)
    const data = JSON.stringify({
        type: 'presence',
        userId,
        status: presence.status,
        lastSeen: presence.lastSeen,
        instanceId: presence.instanceId,
    })
    for (const ws of observers) {
        if (ws.readyState === ws.OPEN) ws.send(data)
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

    wss.on('connection', async (ws, request) => {
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

        let isAlive = true
        const pingInterval = setInterval(() => {
            if (!isAlive) {
                ws.terminate()
                return
            }
            isAlive = false
            try { ws.ping() } catch {}
        }, 30_000)

        try {
            await setOnline(userId, INSTANCE_ID)
            addConn(userId, ws)
            console.log(`[chat-service] user ${userId} online`)
            broadcastPresence(userId).catch(() => {})
        } catch (err) {
            console.error('Failed to set online:', err)
        }

        ws.on('message', async (raw) => {
            let parsed: any
            try {
                parsed = JSON.parse(raw.toString())
            } catch {
                ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' }))
                return
            }

            // ─── Presence subscription ───
            if (parsed?.type === 'subscribe_presence' && Array.isArray(parsed.userIds)) {
                const ids = parsed.userIds.filter((x: any) => typeof x === 'string')
                const added = subscribe(ws, ids)
                // моментально шлём текущий статус каждому добавленному id
                await Promise.all(added.map(async (id) => {
                    const p = await getPresence(id)
                    ws.send(JSON.stringify({
                        type: 'presence',
                        userId: id,
                        status: p.status,
                        lastSeen: p.lastSeen,
                        instanceId: p.instanceId,
                    }))
                }))
                return
            }

            if (parsed?.type === 'unsubscribe_presence' && Array.isArray(parsed.userIds)) {
                unsubscribe(ws, parsed.userIds.filter((x: any) => typeof x === 'string'))
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

        ws.on('close', async () => {
            clearInterval(pingInterval)
            removeConn(userId, ws)
            cleanupSession(ws)
            try {
                if (!userConnections.has(userId)) {
                    await setOffline(userId)
                    console.log(`[chat-service] user ${userId} offline`)
                    broadcastPresence(userId).catch(() => {})
                }
            } catch (err) {
                console.error('Failed to set offline:', err)
            }
        })

        ws.on('pong', async () => {
            isAlive = true
            try { await refreshOnline(userId) } catch {}
        })
    })
}
