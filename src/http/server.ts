import Fastify from 'fastify'
import { getHistory } from '../db/messages'
import { getPresence, getPresenceBatch } from '../redis/RedisClient'
import { addContact, deleteContact, listContactsWithLastMessage } from '../db/contacts'
import { fetchUser } from '../users/UserClient'

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

fastify.get<{ Params: { userId: string } }>(
    '/presence/:userId',
    async (request) => {
        const p = await getPresence(request.params.userId)
        return { userId: request.params.userId, ...p }
    }
)

fastify.post<{ Body: { userIds: string[] } }>(
    '/presence/batch',
    {
        schema: {
            body: {
                type: 'object',
                required: ['userIds'],
                properties: { userIds: { type: 'array', items: { type: 'string' } } },
            },
        },
    },
    async (request) => getPresenceBatch(request.body.userIds)
)

fastify.get<{ Params: { peerId: string }; Querystring: { limit?: string } }>(
    '/messages/with/:peerId',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return
        const limit = Math.min(200, Number(request.query.limit ?? 50) || 50)
        const items = await getHistory(userId, request.params.peerId, limit)
        return { items }
    }
)

// ============================================================
// Contacts
// ============================================================

fastify.get('/contacts', async (request, reply) => {
    const userId = requireUserId(request, reply)
    if (!userId) return

    const contacts = await listContactsWithLastMessage(userId)
    const peerIds = contacts.map(c => c.peerId)
    const presences = peerIds.length === 0 ? {} : await getPresenceBatch(peerIds)

    return {
        items: contacts.map(c => ({
            peerId: c.peerId,
            displayName: c.displayName,
            createdAt: c.createdAt,
            lastMessage: c.lastMessage,
            presence: presences[c.peerId] ?? { status: 'offline', lastSeen: null, instanceId: null },
        })),
    }
})

fastify.post<{ Body: { peer_id?: string; peerId?: string } }>(
    '/contacts',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return

        const peerId = (request.body.peer_id ?? request.body.peerId ?? '').trim()
        if (!peerId) return reply.code(400).send({ error: 'peer_id required' })
        if (peerId === userId) return reply.code(400).send({ error: 'cannot add self' })

        let user
        try {
            user = await fetchUser(peerId)
        } catch (e: any) {
            if (e.message === 'not_found') return reply.code(404).send({ error: 'user not found' })
            request.log.error(e)
            return reply.code(502).send({ error: 'user service unreachable' })
        }

        const inserted = await addContact(userId, peerId, user.displayName)
        if (!inserted) return reply.code(409).send({ error: 'already in contacts' })

        return reply.code(200).send({
            contact: {
                peerId: user.userId,
                displayName: user.displayName,
                createdAt: inserted.created_at.toISOString(),
            },
        })
    }
)

fastify.delete<{ Params: { peerId: string } }>(
    '/contacts/:peerId',
    async (request, reply) => {
        const userId = requireUserId(request, reply)
        if (!userId) return
        const removed = await deleteContact(userId, request.params.peerId)
        if (!removed) return reply.code(404).send({ error: 'not in contacts' })
        return reply.code(204).send()
    }
)
