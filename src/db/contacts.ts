import { pool } from './messages'

export async function initContactsSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS contacts (
            owner_user_id   UUID NOT NULL,
            contact_user_id UUID NOT NULL,
            display_name    TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (owner_user_id, contact_user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_contacts_owner ON contacts(owner_user_id);
    `)
}

export interface ContactRow {
    peerId: string
    displayName: string
    createdAt: string
}

export async function addContact(ownerId: string, peerId: string, displayName: string) {
    const r = await pool.query(
        `INSERT INTO contacts (owner_user_id, contact_user_id, display_name)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_user_id, contact_user_id) DO NOTHING
         RETURNING contact_user_id, display_name, created_at`,
        [ownerId, peerId, displayName]
    )
    return r.rows[0] ?? null
}

export async function hasContact(ownerId: string, peerId: string): Promise<boolean> {
    const r = await pool.query(
        `SELECT 1 FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2`,
        [ownerId, peerId]
    )
    return r.rows.length > 0
}

export async function deleteContact(ownerId: string, peerId: string): Promise<boolean> {
    const r = await pool.query(
        `DELETE FROM contacts WHERE owner_user_id = $1 AND contact_user_id = $2`,
        [ownerId, peerId]
    )
    return (r.rowCount ?? 0) > 0
}

export interface ContactWithMessage {
    peerId: string
    displayName: string
    createdAt: string
    lastMessage: {
        content: string
        createdAt: string
        fromMe: boolean
    } | null
}

export async function listContactsWithLastMessage(ownerId: string): Promise<ContactWithMessage[]> {
    const r = await pool.query(
        `
        SELECT
          c.contact_user_id AS peer_id,
          c.display_name,
          c.created_at,
          m.content AS last_content,
          m.from_user AS last_from,
          m.created_at AS last_created
        FROM contacts c
        LEFT JOIN LATERAL (
          SELECT content, from_user, created_at
          FROM messages
          WHERE (from_user = c.owner_user_id AND to_user = c.contact_user_id)
             OR (from_user = c.contact_user_id AND to_user = c.owner_user_id)
          ORDER BY created_at DESC
          LIMIT 1
        ) m ON TRUE
        WHERE c.owner_user_id = $1
        ORDER BY m.created_at DESC NULLS LAST, c.created_at DESC
        `,
        [ownerId]
    )
    return r.rows.map((row: any) => ({
        peerId: row.peer_id,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
        lastMessage: row.last_content == null
            ? null
            : {
                content: row.last_content,
                createdAt: row.last_created.toISOString(),
                fromMe: row.last_from === ownerId,
            },
    }))
}
