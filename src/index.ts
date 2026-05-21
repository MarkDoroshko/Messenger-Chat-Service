import { initSchema } from './db/messages'
import { initContactsSchema } from './db/contacts'
import { fastify } from './http/server'
import { attachWebSocket } from './ws/WebSocketServer'

async function main() {
    await initSchema()
    await initContactsSchema()
    console.log('[chat-service] schema ready')

    const port = Number(process.env.PORT ?? 8080)
    await fastify.listen({ host: '0.0.0.0', port })

    // ws крепится к тому же HTTP-серверу fastify — один порт на всё
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
