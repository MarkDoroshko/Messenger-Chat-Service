import Redis from 'ioredis'

const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
})

const ONLINE_TTL_SEC = 60

export async function setOnline(userId: string, instanceId: string) {
    await redis.set(`online:${userId}`, instanceId, 'EX', ONLINE_TTL_SEC)
}

export async function refreshOnline(userId: string) {
    await redis.expire(`online:${userId}`, ONLINE_TTL_SEC)
}

export async function setOffline(userId: string) {
    await redis.del(`online:${userId}`)
    await redis.set(`last_seen:${userId}`, new Date().toISOString())
}

export interface UserPresence {
    status: 'online' | 'offline'
    lastSeen: string | null
    instanceId: string | null
}

export async function getPresence(userId: string): Promise<UserPresence> {
    const online = await redis.get(`online:${userId}`)
    const lastSeen = await redis.get(`last_seen:${userId}`)
    if (online == null) {
        return { status: 'offline', lastSeen, instanceId: null }
    }
    return { status: 'online', lastSeen, instanceId: online }
}

export async function getPresenceBatch(userIds: string[]): Promise<Record<string, UserPresence>> {
    const out: Record<string, UserPresence> = {}
    await Promise.all(userIds.map(async (id) => {
        out[id] = await getPresence(id)
    }))
    return out
}
