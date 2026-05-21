const USER_SERVICE_URL = process.env.USER_SERVICE_URL ?? 'http://user-service:8080'
const INTERNAL_USERNAME = process.env.INTERNAL_SERVICE_USERNAME ?? ''
const INTERNAL_PASSWORD = process.env.INTERNAL_SERVICE_PASSWORD ?? ''

function basicAuth(): string {
    return 'Basic ' + Buffer.from(`${INTERNAL_USERNAME}:${INTERNAL_PASSWORD}`).toString('base64')
}

export interface UserBrief {
    userId: string
    displayName: string
    phone: string | null
    bio: string | null
}

/**
 * Кидает Error с message='not_found' если пользователь не найден.
 */
export async function fetchUser(userId: string): Promise<UserBrief> {
    const res = await fetch(`${USER_SERVICE_URL}/internal/users/${userId}`, {
        headers: { Authorization: basicAuth() },
    })
    if (res.status === 404) throw new Error('not_found')
    if (!res.ok) throw new Error(`user-service ${res.status}`)
    const body = await res.json() as any
    return {
        userId: body.user_id,
        displayName: body.display_name,
        phone: body.phone ?? null,
        bio: body.bio ?? null,
    }
}
