import Fastify from 'fastify'
import {
    listChats, createChat, getChatSummary,
    isMember, ensureFavoritesChat, ensureUserName,
    findPersonalChat,
} from '../db/chats'
import { getHistory, searchMessages, getReadersOfMessage } from '../db/messages'
import { listPinned } from '../db/pins'
import { fetchUser, fetchManyUsers } from '../users/UserClient'

export const fastify = Fastify({ logger: true })

function requireUserId(request: any, reply: any): string | null {
    const userId = request.headers['x-user-id']
    if (!userId || Array.isArray(userId)) {
        reply.code(401).send({ error: 'no user id' })
        return null
    }
    return userId
}

fastify.get('/health', async () => ({ status: 'ok' }))

// ============================================================
// Chats
// ============================================================

fastify.get('/chats', async (request, reply) => {
    const userId = requireUserId(request, reply)
    if (!userId) return

    // ensure favorites
    await ensureFavoritesChat(userId)
    // cache own display name
    try {
        const me = await fetchUser(userId)
        await ensureUserName(userId, me.displayName)
    } catch {}

    const items = await listChats(userId)
    return { items }
})

fastify.post<{ Body: { title?: string; memberIds?: string[]; peerId?: string } }>(
    '/chats',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return

        const peerId = request.body.peerId?.trim()
        const memberIds = (request.body.memberIds ?? []).filter(x => typeof x === 'string')

        // 1-на-1 personal-чат: если есть peerId — найдём или создадим
        if (peerId && memberIds.length === 0) {
            if (peerId === userId) {
                const favId = await ensureFavoritesChat(userId)
                const summary = await getChatSummary(favId, userId)
                return reply.code(200).send({ chat: summary })
            }
            const existing = await findPersonalChat(userId, peerId)
            if (existing) {
                const summary = await getChatSummary(existing, userId)
                return reply.code(200).send({ chat: summary })
            }
            let peer
            try { peer = await fetchUser(peerId) } catch (e: any) {
                if (e.message === 'not_found') return reply.code(404).send({ error: 'user not found' })
                return reply.code(502).send({ error: 'user service unreachable' })
            }
            try {
                const me = await fetchUser(userId)
                await ensureUserName(me.userId, me.displayName)
            } catch {}
            await ensureUserName(peer.userId, peer.displayName)

            const id = await createChat({
                title: peer.displayName,
                creatorId: userId,
                memberIds: [peer.userId],
                isPersonal: true,
            })
            const summary = await getChatSummary(id, userId)
            return reply.code(200).send({ chat: summary })
        }

        const title = (request.body.title ?? '').trim()
        if (!title) return reply.code(400).send({ error: 'title required' })
        if (memberIds.length === 0) return reply.code(400).send({ error: 'memberIds required' })

        // подтянем имена всех участников в кэш
        const allIds = Array.from(new Set([userId, ...memberIds]))
        const users = await fetchManyUsers(allIds)
        for (const u of users) await ensureUserName(u.userId, u.displayName)

        const id = await createChat({
            title,
            creatorId: userId,
            memberIds: memberIds.filter(x => x !== userId),
        })
        const summary = await getChatSummary(id, userId)
        return reply.code(200).send({ chat: summary })
    }
)

fastify.get<{ Params: { chatId: string } }>('/chats/:chatId', async (request, reply) => {
    const userId = requireUserId(request, reply)
    if (!userId) return
    if (!(await isMember(request.params.chatId, userId))) {
        return reply.code(403).send({ error: 'not a member' })
    }
    const summary = await getChatSummary(request.params.chatId, userId)
    if (!summary) return reply.code(404).send({ error: 'chat not found' })
    const pinned = await listPinned(request.params.chatId)
    return { chat: summary, pinnedMessageIds: pinned }
})

// ============================================================
// Messages
// ============================================================

fastify.get<{ Params: { chatId: string }; Querystring: { limit?: string } }>(
    '/chats/:chatId/messages',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return
        if (!(await isMember(request.params.chatId, userId))) {
            return reply.code(403).send({ error: 'not a member' })
        }
        const limit = Math.min(500, Number(request.query.limit ?? 200) || 200)
        const items = await getHistory(request.params.chatId, limit)
        const pinnedIds = await listPinned(request.params.chatId)
        // Соберём readers для своих сообщений (для UI «прочитавшие»).
        const enriched = await Promise.all(items.map(async m => {
            if (m.deleted) return { ...m, readers: [] as { userId: string, readAt: string }[] }
            const readers = await getReadersOfMessage(m.id)
            return { ...m, readers }
        }))
        return { items: enriched, pinnedMessageIds: pinnedIds }
    }
)

fastify.get<{ Params: { chatId: string }; Querystring: { q: string } }>(
    '/chats/:chatId/messages/search',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return
        if (!(await isMember(request.params.chatId, userId))) {
            return reply.code(403).send({ error: 'not a member' })
        }
        const q = (request.query.q ?? '').trim()
        if (q.length === 0) return { items: [] }
        const items = await searchMessages(request.params.chatId, q)
        return { items }
    }
)

// ============================================================
// Pins
// ============================================================

fastify.get<{ Params: { chatId: string } }>('/chats/:chatId/pins', async (request, reply) => {
    const userId = requireUserId(request, reply)
    if (!userId) return
    if (!(await isMember(request.params.chatId, userId))) {
        return reply.code(403).send({ error: 'not a member' })
    }
    const ids = await listPinned(request.params.chatId)
    return { messageIds: ids }
})
