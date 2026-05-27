import { pool } from './pool'

export interface PinnedRow {
    chatId: string
    messageId: string
    pinnedBy: string
    pinnedAt: string
}

export async function pinMessage(chatId: string, messageId: string, byUserId: string): Promise<PinnedRow | null> {
    const r = await pool.query(
        `INSERT INTO pinned_messages (chat_id, message_id, pinned_by)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [chatId, messageId, byUserId]
    )
    if (!r.rows[0]) return null
    return {
        chatId: r.rows[0].chat_id,
        messageId: r.rows[0].message_id,
        pinnedBy: r.rows[0].pinned_by,
        pinnedAt: r.rows[0].pinned_at.toISOString(),
    }
}

export async function unpinMessage(chatId: string, messageId: string): Promise<boolean> {
    const r = await pool.query(
        `DELETE FROM pinned_messages WHERE chat_id = $1 AND message_id = $2`,
        [chatId, messageId]
    )
    return (r.rowCount ?? 0) > 0
}

export async function listPinned(chatId: string): Promise<string[]> {
    const r = await pool.query(
        `SELECT message_id FROM pinned_messages
         WHERE chat_id = $1
         ORDER BY pinned_at ASC`,
        [chatId]
    )
    return r.rows.map(x => x.message_id)
}
