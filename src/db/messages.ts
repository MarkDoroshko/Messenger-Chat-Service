import { pool } from './pool'

export interface SavedMessage {
    id: string
    chatId: string
    senderId: string
    content: string
    replyToId: string | null
    createdAt: string
    editedAt: string | null
    deleted: boolean
}

function rowToMessage(row: any): SavedMessage {
    return {
        id: row.id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        content: row.deleted_at != null ? '' : row.content,
        replyToId: row.reply_to_id ?? null,
        createdAt: row.created_at.toISOString(),
        editedAt: row.edited_at ? row.edited_at.toISOString() : null,
        deleted: row.deleted_at != null,
    }
}

export async function saveMessage(m: {
    id: string
    chatId: string
    senderId: string
    content: string
    replyToId?: string | null
}): Promise<SavedMessage> {
    const r = await pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, content, reply_to_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [m.id, m.chatId, m.senderId, m.content, m.replyToId ?? null]
    )
    return rowToMessage(r.rows[0])
}

export async function getMessage(id: string): Promise<SavedMessage | null> {
    const r = await pool.query(`SELECT * FROM messages WHERE id = $1`, [id])
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}

export async function getHistory(chatId: string, limit = 100): Promise<SavedMessage[]> {
    const r = await pool.query(
        `SELECT * FROM messages
         WHERE chat_id = $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [chatId, limit]
    )
    return r.rows.map(rowToMessage)
}

export async function searchMessages(chatId: string, query: string): Promise<SavedMessage[]> {
    const q = `%${query.replace(/[%_]/g, ch => '\\' + ch)}%`
    const r = await pool.query(
        `SELECT * FROM messages
         WHERE chat_id = $1 AND deleted_at IS NULL AND content ILIKE $2
         ORDER BY created_at ASC
         LIMIT 200`,
        [chatId, q]
    )
    return r.rows.map(rowToMessage)
}

export async function editMessage(
    id: string,
    ownerId: string,
    newContent: string
): Promise<SavedMessage | null> {
    const r = await pool.query(
        `UPDATE messages
         SET content = $3, edited_at = NOW()
         WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, ownerId, newContent]
    )
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}

export async function deleteMessage(id: string, ownerId: string): Promise<SavedMessage | null> {
    const r = await pool.query(
        `UPDATE messages
         SET deleted_at = NOW(), content = ''
         WHERE id = $1 AND sender_id = $2 AND deleted_at IS NULL
         RETURNING *`,
        [id, ownerId]
    )
    return r.rows[0] ? rowToMessage(r.rows[0]) : null
}

/**
 * Возвращает список user_id участников чата (кроме отправителя),
 * чьи last_read_at >= созданного сообщения.
 */
export async function getReadersOfMessage(messageId: string): Promise<{ userId: string, readAt: string }[]> {
    const r = await pool.query(
        `SELECT cm.user_id, cm.last_read_at
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id
         WHERE m.id = $1
           AND cm.user_id <> m.sender_id
           AND cm.last_read_at >= m.created_at`,
        [messageId]
    )
    return r.rows.map(row => ({
        userId: row.user_id,
        readAt: row.last_read_at.toISOString(),
    }))
}
