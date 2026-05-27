import { pool } from './pool'
import { v4 as uuid } from 'uuid'

export interface ChatMember {
    userId: string
    displayName: string
    joinedAt: string
}

export interface ChatRow {
    id: string
    title: string
    isPersonal: boolean
    isFavorites: boolean
    createdBy: string
    createdAt: string
}

export interface ChatSummary extends ChatRow {
    members: ChatMember[]
    lastMessage: {
        id: string
        senderId: string
        content: string
        createdAt: string
        deleted: boolean
    } | null
    unreadCount: number
    pinnedCount: number
}

function mapChatRow(row: any): ChatRow {
    return {
        id: row.id,
        title: row.title,
        isPersonal: row.is_personal,
        isFavorites: row.is_favorites,
        createdBy: row.created_by,
        createdAt: row.created_at.toISOString(),
    }
}

export async function getChatById(chatId: string): Promise<ChatRow | null> {
    const r = await pool.query(`SELECT * FROM chats WHERE id = $1`, [chatId])
    return r.rows[0] ? mapChatRow(r.rows[0]) : null
}

export async function isMember(chatId: string, userId: string): Promise<boolean> {
    const r = await pool.query(
        `SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
        [chatId, userId]
    )
    return r.rowCount! > 0
}

export async function getMemberIds(chatId: string): Promise<string[]> {
    const r = await pool.query(
        `SELECT user_id FROM chat_members WHERE chat_id = $1`,
        [chatId]
    )
    return r.rows.map(x => x.user_id)
}

export async function getMembersWithNames(chatId: string): Promise<ChatMember[]> {
    const r = await pool.query(
        `SELECT cm.user_id, cm.joined_at, COALESCE(un.display_name, '') AS display_name
         FROM chat_members cm
         LEFT JOIN user_names un ON un.user_id = cm.user_id
         WHERE cm.chat_id = $1
         ORDER BY cm.joined_at ASC`,
        [chatId]
    )
    return r.rows.map(row => ({
        userId: row.user_id,
        displayName: row.display_name,
        joinedAt: row.joined_at.toISOString(),
    }))
}

/**
 * Кэш отображаемых имён, чтобы не дёргать user-service каждый раз.
 */
export async function ensureUserName(userId: string, displayName: string) {
    await pool.query(
        `INSERT INTO user_names (user_id, display_name)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [userId, displayName]
    )
}

export async function ensureUserNamesSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_names (
            user_id      UUID PRIMARY KEY,
            display_name TEXT NOT NULL
        );
    `)
}

/**
 * Создание чата с участниками. Возвращает id.
 */
export async function createChat(opts: {
    title: string
    creatorId: string
    memberIds: string[]
    isPersonal?: boolean
    isFavorites?: boolean
}): Promise<string> {
    const client = await pool.connect()
    try {
        await client.query('BEGIN')
        const id = uuid()
        await client.query(
            `INSERT INTO chats (id, title, is_personal, is_favorites, created_by)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, opts.title, !!opts.isPersonal, !!opts.isFavorites, opts.creatorId]
        )
        const allMembers = Array.from(new Set([opts.creatorId, ...opts.memberIds]))
        for (const uid of allMembers) {
            await client.query(
                `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)
                 ON CONFLICT DO NOTHING`,
                [id, uid]
            )
        }
        await client.query('COMMIT')
        return id
    } catch (e) {
        await client.query('ROLLBACK')
        throw e
    } finally {
        client.release()
    }
}

/**
 * Найти существующий 1-на-1 personal-чат между двумя пользователями (если есть).
 */
export async function findPersonalChat(userA: string, userB: string): Promise<string | null> {
    const r = await pool.query(
        `SELECT c.id
         FROM chats c
         JOIN chat_members m1 ON m1.chat_id = c.id AND m1.user_id = $1
         JOIN chat_members m2 ON m2.chat_id = c.id AND m2.user_id = $2
         WHERE c.is_personal = TRUE AND c.is_favorites = FALSE
         LIMIT 1`,
        [userA, userB]
    )
    return r.rows[0]?.id ?? null
}

export async function findFavoritesChat(userId: string): Promise<string | null> {
    const r = await pool.query(
        `SELECT c.id
         FROM chats c
         JOIN chat_members m ON m.chat_id = c.id AND m.user_id = $1
         WHERE c.is_favorites = TRUE
         LIMIT 1`,
        [userId]
    )
    return r.rows[0]?.id ?? null
}

export async function ensureFavoritesChat(userId: string): Promise<string> {
    const existing = await findFavoritesChat(userId)
    if (existing) return existing
    return createChat({
        title: 'Избранное',
        creatorId: userId,
        memberIds: [],
        isPersonal: true,
        isFavorites: true,
    })
}

/**
 * Список чатов пользователя с last message, unread и pinned-count.
 */
export async function listChats(userId: string): Promise<ChatSummary[]> {
    const r = await pool.query(
        `
        WITH my_chats AS (
            SELECT c.*, cm.last_read_at
            FROM chats c
            JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
        )
        SELECT
            mc.id, mc.title, mc.is_personal, mc.is_favorites, mc.created_by, mc.created_at,
            lm.id AS last_id, lm.sender_id AS last_sender, lm.content AS last_content,
            lm.created_at AS last_created, lm.deleted_at AS last_deleted,
            COALESCE(uc.cnt, 0)::int AS unread_count,
            COALESCE(pc.cnt, 0)::int AS pinned_count
        FROM my_chats mc
        LEFT JOIN LATERAL (
            SELECT id, sender_id, content, created_at, deleted_at
            FROM messages
            WHERE chat_id = mc.id
            ORDER BY created_at DESC
            LIMIT 1
        ) lm ON TRUE
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS cnt
            FROM messages
            WHERE chat_id = mc.id
              AND sender_id <> $1
              AND deleted_at IS NULL
              AND created_at > mc.last_read_at
        ) uc ON TRUE
        LEFT JOIN LATERAL (
            SELECT COUNT(*) AS cnt
            FROM pinned_messages
            WHERE chat_id = mc.id
        ) pc ON TRUE
        ORDER BY (lm.created_at IS NULL), lm.created_at DESC, mc.created_at DESC
        `,
        [userId]
    )

    const chats: ChatSummary[] = []
    for (const row of r.rows) {
        const base = mapChatRow(row)
        const members = await getMembersWithNames(base.id)
        chats.push({
            ...base,
            members,
            lastMessage: row.last_id
                ? {
                    id: row.last_id,
                    senderId: row.last_sender,
                    content: row.last_deleted ? '' : row.last_content,
                    createdAt: row.last_created.toISOString(),
                    deleted: row.last_deleted != null,
                }
                : null,
            unreadCount: row.unread_count,
            pinnedCount: row.pinned_count,
        })
    }
    return chats
}

export async function getChatSummary(chatId: string, userId: string): Promise<ChatSummary | null> {
    const base = await getChatById(chatId)
    if (!base) return null
    const members = await getMembersWithNames(chatId)
    const lm = await pool.query(
        `SELECT id, sender_id, content, created_at, deleted_at
         FROM messages WHERE chat_id = $1
         ORDER BY created_at DESC LIMIT 1`, [chatId])
    const lastRow = lm.rows[0]
    const uc = await pool.query(
        `SELECT COUNT(*)::int AS cnt
         FROM messages m
         JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = $2
         WHERE m.chat_id = $1 AND m.sender_id <> $2 AND m.deleted_at IS NULL
           AND m.created_at > cm.last_read_at`,
        [chatId, userId])
    const pc = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM pinned_messages WHERE chat_id = $1`, [chatId])
    return {
        ...base,
        members,
        lastMessage: lastRow ? {
            id: lastRow.id,
            senderId: lastRow.sender_id,
            content: lastRow.deleted_at ? '' : lastRow.content,
            createdAt: lastRow.created_at.toISOString(),
            deleted: lastRow.deleted_at != null,
        } : null,
        unreadCount: uc.rows[0].cnt,
        pinnedCount: pc.rows[0].cnt,
    }
}

export async function markChatRead(chatId: string, userId: string): Promise<string> {
    const r = await pool.query(
        `UPDATE chat_members
         SET last_read_at = NOW()
         WHERE chat_id = $1 AND user_id = $2
         RETURNING last_read_at`,
        [chatId, userId]
    )
    return r.rows[0]?.last_read_at?.toISOString() ?? new Date().toISOString()
}
