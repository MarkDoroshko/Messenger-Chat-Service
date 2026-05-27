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
        CREATE TABLE IF NOT EXISTS chats (
            id           UUID PRIMARY KEY,
            title        TEXT NOT NULL,
            is_personal  BOOLEAN NOT NULL DEFAULT FALSE,
            is_favorites BOOLEAN NOT NULL DEFAULT FALSE,
            created_by   UUID NOT NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS chat_members (
            chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            user_id      UUID NOT NULL,
            joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_read_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
            PRIMARY KEY (chat_id, user_id)
        );
        CREATE INDEX IF NOT EXISTS idx_chat_members_user ON chat_members(user_id);

        CREATE TABLE IF NOT EXISTS messages (
            id          UUID PRIMARY KEY,
            chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            sender_id   UUID NOT NULL,
            content     TEXT NOT NULL,
            reply_to_id UUID NULL REFERENCES messages(id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            edited_at   TIMESTAMPTZ NULL,
            deleted_at  TIMESTAMPTZ NULL
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, created_at);

        CREATE TABLE IF NOT EXISTS pinned_messages (
            chat_id    UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
            message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
            pinned_by  UUID NOT NULL,
            pinned_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (chat_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pinned_chat ON pinned_messages(chat_id, pinned_at);
    `)
}
