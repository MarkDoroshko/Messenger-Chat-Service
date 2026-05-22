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
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ NULL;
        ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_pair_ts
            ON messages(from_user, to_user, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_to_ts
            ON messages(to_user, created_at);
        CREATE INDEX IF NOT EXISTS idx_messages_unread
            ON messages(to_user, from_user) WHERE status = 'sent' AND deleted_at IS NULL;
    `)
}

export type MessageStatus = 'sent' | 'delivered' | 'read'

export interface SavedMessage {
    id: string
    from: string
    to: string
    content: string
    status: MessageStatus
    createdAt: string
    editedAt: string | null
    deleted: boolean
}

function rowToMessage(row: any): SavedMessage {
    return {
        id: row.id,
        from: row.from_user,
        to: row.to_user,
        content: row.deleted_at != null ? '' : row.content,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        editedAt: row.edited_at ? row.edited_at.toISOString() : null,
        deleted: row.deleted_at != null,
    }
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
         RETURNING *`,
        [m.id, m.from, m.to, m.content]
    )
    return rowToMessage(r.rows[0])
}

export async function getMessage(id: string): Promise<SavedMessage | null> {
    const r = await pool.query(`SELECT * FROM messages WHERE id = $1`, [id])
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}

export async function getHistory(
    userA: string,
    userB: string,
    limit = 50
): Promise<SavedMessage[]> {
    const r = await pool.query(
        `SELECT *
         FROM messages
         WHERE (from_user = $1 AND to_user = $2)
            OR (from_user = $2 AND to_user = $1)
         ORDER BY created_at DESC
         LIMIT $3`,
        [userA, userB, limit]
    )
    return r.rows.map(rowToMessage)
}

/**
 * Помечаем все непрочитанные от peer→me как 'read'. Возвращаем счётчик.
 */
export async function markAllRead(me: string, peerId: string): Promise<number> {
    const r = await pool.query(
        `UPDATE messages
         SET status = 'read'
         WHERE to_user = $1 AND from_user = $2 AND status <> 'read' AND deleted_at IS NULL`,
        [me, peerId]
    )
    return r.rowCount ?? 0
}

/**
 * Редактирование. Только владелец (from_user). Не редактируем удалённое.
 * Возвращаем обновлённое сообщение или null если нельзя.
 */
export async function editMessage(
    id: string,
    ownerId: string,
    newContent: string
): Promise<SavedMessage | null> {
    const r = await pool.query(
        `UPDATE messages
         SET content = $3, edited_at = NOW()
         WHERE id = $1 AND from_user = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, ownerId, newContent]
    )
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}

/** Soft-delete. Только владелец. */
export async function deleteMessage(id: string, ownerId: string): Promise<SavedMessage | null> {
    const r = await pool.query(
        `UPDATE messages
         SET deleted_at = NOW(), content = ''
         WHERE id = $1 AND from_user = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, ownerId]
    )
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}
