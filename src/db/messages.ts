import { Pool } from 'pg'

export const pool = new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
})

export async function initSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS messages (
            id UUID PRIMARY KEY,
            from_user UUID NOT NULL,
            to_user UUID NOT NULL,
            content TEXT NOT NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'sent',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_messages_pair_ts
            ON messages(from_user, to_user, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_to_ts
            ON messages(to_user, created_at);
    `)
}

export interface SavedMessage {
    id: string
    from: string
    to: string
    content: string
    status: 'sent' | 'delivered' | 'read'
    createdAt: string
}

export async function saveMessage(m: {
    id: string
    from: string
    to: string
    content: string
}): Promise<SavedMessage> {
    const r = await pool.query(
        `INSERT INTO messages (id, from_user, to_user, content)
         VALUES ($1, $2, $3, $4)
         RETURNING id, from_user, to_user, content, status, created_at`,
        [m.id, m.from, m.to, m.content]
    )
    const row = r.rows[0]
    return {
        id: row.id,
        from: row.from_user,
        to: row.to_user,
        content: row.content,
        status: row.status,
        createdAt: row.created_at.toISOString(),
    }
}

export async function getHistory(
    userA: string,
    userB: string,
    limit = 50
): Promise<SavedMessage[]> {
    const r = await pool.query(
        `SELECT id, from_user, to_user, content, status, created_at
         FROM messages
         WHERE (from_user = $1 AND to_user = $2)
            OR (from_user = $2 AND to_user = $1)
         ORDER BY created_at DESC
         LIMIT $3`,
        [userA, userB, limit]
    )
    return r.rows.map((row: any) => ({
        id: row.id,
        from: row.from_user,
        to: row.to_user,
        content: row.content,
        status: row.status,
        createdAt: row.created_at.toISOString(),
    }))
}
