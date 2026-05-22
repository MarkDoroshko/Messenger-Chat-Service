import { WebSocketServer, WebSocket } from 'ws'
import { clearInterval } from 'node:timers'
import { IncomingMessage, Server as HttpServer } from 'node:http'
import { v4 as uuid } from 'uuid'
import { deleteMessage, editMessage, getMessage, markAllRead, saveMessage } from '../db/messages'
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
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(data)
    }
    return true
}

async function ensureContactForRecipient(ownerId: string, peerId: string) {
    try {
        if (await hasContact(ownerId, peerId)) return
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
        console.warn('[chat-service] WARNING: GATEWAY_SECRET is empty')
    }
    console.log(`[chat-service] WebSocket attached, instance=${INSTANCE_ID}`)

    wss.on('connection', (ws, request) => {
        const gatewaySecret = request.headers['x-gateway-secret']
        const userIdHeader = request.headers['x-user-id']

        if (!GATEWAY_SECRET || gatewaySecret !== GATEWAY_SECRET) {
            ws.close(4401, 'unauthorized'); return
        }
        if (!userIdHeader || Array.isArray(userIdHeader)) {
            ws.close(4400, 'no user id'); return
        }
        const userId = userIdHeader

        let isAlive = true
        const pingInterval = setInterval(() => {
            if (!isAlive) { ws.terminate(); return }
            isAlive = false
            try { ws.ping() } catch {}
        }, 30_000)

        addConn(userId, ws)
        console.log(`[chat-service] user ${userId} connected`)

        ws.on('message', async (raw) => {
            let parsed: any
            try { parsed = JSON.parse(raw.toString()) } catch {
                ws.send(JSON.stringify({ type: 'error', error: 'invalid_json' })); return
            }

            try {
                switch (parsed?.type) {
                    case 'ping':
                        ws.send(JSON.stringify({ type: 'pong' }))
                        return

                    case 'message':
                        await handleSendMessage(ws, userId, parsed)
                        return

                    case 'mark_read':
                        await handleMarkRead(userId, parsed)
                        return

                    case 'edit_message':
                        await handleEditMessage(ws, userId, parsed)
                        return

                    case 'delete_message':
                        await handleDeleteMessage(ws, userId, parsed)
                        return

                    default:
                        ws.send(JSON.stringify({ type: 'error', error: 'unknown_type' }))
                }
            } catch (err) {
                console.error('[chat-service] WS handler error:', err)
                ws.send(JSON.stringify({ type: 'error', error: 'server_error' }))
            }
        })

        ws.on('close', () => {
            clearInterval(pingInterval)
            removeConn(userId, ws)
            console.log(`[chat-service] user ${userId} disconnected`)
        })

        ws.on('pong', () => { isAlive = true })
    })
}

// ───────────── handlers ─────────────

async function handleSendMessage(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.to !== 'string' || typeof parsed.content !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_message_payload' })); return
    }
    const content = parsed.content.trim()
    if (content.length === 0) {
        ws.send(JSON.stringify({ type: 'error', error: 'empty_content' })); return
    }

    const saved = await saveMessage({
        id: uuid(), from: userId, to: parsed.to, content,
    })

    ws.send(JSON.stringify({
        type: 'ack',
        clientMessageId: parsed.clientMessageId,
        id: saved.id,
        accepted: true,
    }))

    ensureContactForRecipient(saved.to, saved.from)

    deliverLocal(saved.to, msgPayload(saved))
}

async function handleMarkRead(userId: string, parsed: any) {
    if (typeof parsed.peerId !== 'string') return
    const updated = await markAllRead(userId, parsed.peerId)
    if (updated > 0) {
        // уведомляем отправителя: все его сообщения этому юзеру прочитаны
        deliverLocal(parsed.peerId, {
            type: 'messages_read',
            byUserId: userId,
        })
    }
}

async function handleEditMessage(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.id !== 'string' || typeof parsed.content !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_edit_payload' })); return
    }
    const content = parsed.content.trim()
    if (content.length === 0) {
        ws.send(JSON.stringify({ type: 'error', error: 'empty_content' })); return
    }

    const existing = await getMessage(parsed.id)
    if (!existing) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_found' })); return
    }
    if (existing.from !== userId) {
        ws.send(JSON.stringify({ type: 'error', error: 'forbidden' })); return
    }
    if (existing.deleted) {
        ws.send(JSON.stringify({ type: 'error', error: 'deleted' })); return
    }

    const updated = await editMessage(parsed.id, userId, content)
    if (!updated) {
        ws.send(JSON.stringify({ type: 'error', error: 'edit_failed' })); return
    }

    const event = {
        type: 'message_edited',
        id: updated.id,
        from: updated.from,
        to: updated.to,
        content: updated.content,
        editedAt: updated.editedAt,
    }
    deliverLocal(updated.from, event)
    deliverLocal(updated.to, event)
}

async function handleDeleteMessage(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.id !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_delete_payload' })); return
    }

    const existing = await getMessage(parsed.id)
    if (!existing) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_found' })); return
    }
    if (existing.from !== userId) {
        ws.send(JSON.stringify({ type: 'error', error: 'forbidden' })); return
    }

    const updated = await deleteMessage(parsed.id, userId)
    if (!updated) {
        ws.send(JSON.stringify({ type: 'error', error: 'delete_failed' })); return
    }

    const event = {
        type: 'message_deleted',
        id: updated.id,
        from: updated.from,
        to: updated.to,
    }
    deliverLocal(updated.from, event)
    deliverLocal(updated.to, event)
}

function msgPayload(saved: any) {
    return {
        type: 'message',
        id: saved.id,
        from: saved.from,
        to: saved.to,
        content: saved.content,
        status: saved.status,
        createdAt: saved.createdAt,
        editedAt: saved.editedAt,
        deleted: saved.deleted,
    }
}
