import { initSchema } from './db/pool'
import { ensureUserNamesSchema } from './db/chats'
import { fastify } from './http/server'
import { attachWebSocket } from './ws/WebSocketServer'

async function main() {
    await initSchema()
    await ensureUserNamesSchema()
    console.log('[chat-service] schema ready')

    const port = Number(process.env.PORT ?? 8080)
    await fastify.listen({ host: '0.0.0.0', port })

    attachWebSocket(fastify.server)

    const shutdown = async () => {
        console.log('[chat-service] shutting down')
        await fastify.close()
        process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
}

main().catch((err) => {
    console.error('[chat-service] fatal:', err)
    process.exit(1)
})
