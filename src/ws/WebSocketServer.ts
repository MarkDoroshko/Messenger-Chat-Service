import { WebSocketServer, WebSocket } from 'ws'
import { clearInterval } from 'node:timers'
import { IncomingMessage, Server as HttpServer } from 'node:http'
import { v4 as uuid } from 'uuid'
import {
    saveMessage, getMessage, editMessage, deleteMessage, SavedMessage,
} from '../db/messages'
import {
    isMember, getMemberIds, markChatRead,
} from '../db/chats'
import { pinMessage, unpinMessage } from '../db/pins'

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

function sendTo(userId: string, payload: object) {
    const set = userConnections.get(userId)
    if (!set) return
    const data = JSON.stringify(payload)
    for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(data)
    }
}

async function broadcastToChat(chatId: string, payload: object) {
    const members = await getMemberIds(chatId)
    for (const uid of members) sendTo(uid, payload)
}

function msgPayload(saved: SavedMessage) {
    return {
        type: 'message',
        id: saved.id,
        chatId: saved.chatId,
        senderId: saved.senderId,
        content: saved.content,
        replyToId: saved.replyToId,
        createdAt: saved.createdAt,
        editedAt: saved.editedAt,
        deleted: saved.deleted,
    }
}

export function attachWebSocket(server: HttpServer) {
    const wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (request: IncomingMessage, socket, head) => {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request)
        })
    })

    if (!GATEWAY_SECRET) console.warn('[chat-service] WARNING: GATEWAY_SECRET is empty')
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
                        ws.send(JSON.stringify({ type: 'pong' })); return
                    case 'message':
                        await handleSendMessage(ws, userId, parsed); return
                    case 'mark_read':
                        await handleMarkRead(userId, parsed); return
                    case 'edit_message':
                        await handleEditMessage(ws, userId, parsed); return
                    case 'delete_message':
                        await handleDeleteMessage(ws, userId, parsed); return
                    case 'pin_message':
                        await handlePin(ws, userId, parsed); return
                    case 'unpin_message':
                        await handleUnpin(ws, userId, parsed); return
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
        })
        ws.on('pong', () => { isAlive = true })
    })
}

// ───────────── handlers ─────────────

async function handleSendMessage(ws: WebSocket, userId: string, parsed: any) {
    const chatId = parsed.chatId
    const content = typeof parsed.content === 'string' ? parsed.content.trim() : ''
    if (typeof chatId !== 'string' || content.length === 0) {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_message_payload' })); return
    }
    if (!(await isMember(chatId, userId))) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_a_member' })); return
    }
    const replyToId = typeof parsed.replyToId === 'string' ? parsed.replyToId : null
    const saved = await saveMessage({
        id: uuid(),
        chatId,
        senderId: userId,
        content,
        replyToId,
    })
    ws.send(JSON.stringify({
        type: 'ack',
        clientMessageId: parsed.clientMessageId,
        id: saved.id,
        chatId: saved.chatId,
        createdAt: saved.createdAt,
        accepted: true,
    }))
    await broadcastToChat(chatId, msgPayload(saved))
}

async function handleMarkRead(userId: string, parsed: any) {
    if (typeof parsed.chatId !== 'string') return
    if (!(await isMember(parsed.chatId, userId))) return
    const ts = await markChatRead(parsed.chatId, userId)
    await broadcastToChat(parsed.chatId, {
        type: 'messages_read',
        chatId: parsed.chatId,
        byUserId: userId,
        readAt: ts,
    })
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
    if (!existing) { ws.send(JSON.stringify({ type: 'error', error: 'not_found' })); return }
    if (existing.senderId !== userId) { ws.send(JSON.stringify({ type: 'error', error: 'forbidden' })); return }
    if (existing.deleted) { ws.send(JSON.stringify({ type: 'error', error: 'deleted' })); return }

    const updated = await editMessage(parsed.id, userId, content)
    if (!updated) { ws.send(JSON.stringify({ type: 'error', error: 'edit_failed' })); return }
    await broadcastToChat(updated.chatId, {
        type: 'message_edited',
        id: updated.id,
        chatId: updated.chatId,
        content: updated.content,
        editedAt: updated.editedAt,
    })
}

async function handleDeleteMessage(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.id !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_delete_payload' })); return
    }
    const existing = await getMessage(parsed.id)
    if (!existing) { ws.send(JSON.stringify({ type: 'error', error: 'not_found' })); return }
    if (existing.senderId !== userId) { ws.send(JSON.stringify({ type: 'error', error: 'forbidden' })); return }

    const updated = await deleteMessage(parsed.id, userId)
    if (!updated) { ws.send(JSON.stringify({ type: 'error', error: 'delete_failed' })); return }
    await broadcastToChat(updated.chatId, {
        type: 'message_deleted',
        id: updated.id,
        chatId: updated.chatId,
    })
}

async function handlePin(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.chatId !== 'string' || typeof parsed.messageId !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_pin_payload' })); return
    }
    if (!(await isMember(parsed.chatId, userId))) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_a_member' })); return
    }
    const msg = await getMessage(parsed.messageId)
    if (!msg || msg.chatId !== parsed.chatId) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_found' })); return
    }
    const pinned = await pinMessage(parsed.chatId, parsed.messageId, userId)
    if (!pinned) return
    await broadcastToChat(parsed.chatId, {
        type: 'message_pinned',
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        pinnedBy: userId,
        pinnedAt: pinned.pinnedAt,
    })
}

async function handleUnpin(ws: WebSocket, userId: string, parsed: any) {
    if (typeof parsed.chatId !== 'string' || typeof parsed.messageId !== 'string') {
        ws.send(JSON.stringify({ type: 'error', error: 'bad_unpin_payload' })); return
    }
    if (!(await isMember(parsed.chatId, userId))) {
        ws.send(JSON.stringify({ type: 'error', error: 'not_a_member' })); return
    }
    const ok = await unpinMessage(parsed.chatId, parsed.messageId)
    if (!ok) return
    await broadcastToChat(parsed.chatId, {
        type: 'message_unpinned',
        chatId: parsed.chatId,
        messageId: parsed.messageId,
    })
}
