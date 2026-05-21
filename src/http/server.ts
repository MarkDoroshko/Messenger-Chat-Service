import Fastify from 'fastify'
import { getHistory } from '../db/messages'
import { getPresence, getPresenceBatch } from '../redis/RedisClient'

export const fastify = Fastify({ logger: true })

fastify.get('/health', async () => ({ status: 'ok' }))

fastify.get<{ Params: { userId: string } }>(
    '/presence/:userId',
    async (request) => {
        const userId = request.params.userId
        const p = await getPresence(userId)
        return { userId, ...p }
    }
)

const batchSchema = {
    body: {
        type: 'object',
        required: ['userIds'],
        properties: {
            userIds: { type: 'array', items: { type: 'string' } },
        },
    },
}

fastify.post<{ Body: { userIds: string[] } }>(
    '/presence/batch',
    { schema: batchSchema },
    async (request) => {
        return await getPresenceBatch(request.body.userIds)
    }
)

fastify.get<{ Params: { peerId: string }; Querystring: { limit?: string } }>(
    '/messages/with/:peerId',
    async (request, reply) => {
        const userId = request.headers['x-user-id']
        if (!userId || Array.isArray(userId)) {
            return reply.code(401).send({ error: 'no user id' })
        }
        const limit = Math.min(200, Number(request.query.limit ?? 50) || 50)
        const items = await getHistory(userId, request.params.peerId, limit)
        return { items }
    }
)
