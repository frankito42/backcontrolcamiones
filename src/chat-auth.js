import crypto from 'node:crypto';
import { pool } from './db.js';

const sessionDurationDays = 30;

export async function ensureChatSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      token_hash CHAR(64) PRIMARY KEY,
      usuario_id INT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      expires_at DATETIME(3) NOT NULL,
      revoked_at DATETIME(3) NULL,
      KEY idx_chat_sessions_user (usuario_id, expires_at),
      CONSTRAINT fk_chat_sessions_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    CREATE TABLE IF NOT EXISTS chat_messages (
      id BIGINT NOT NULL AUTO_INCREMENT,
      sender_id INT NOT NULL,
      recipient_id INT NOT NULL,
      content VARCHAR(2000) NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      delivered_at DATETIME(3) NULL,
      read_at DATETIME(3) NULL,
      PRIMARY KEY (id),
      KEY idx_chat_messages_conversation (sender_id, recipient_id, id DESC),
      KEY idx_chat_messages_unread (recipient_id, sender_id, read_at, id DESC),
      CONSTRAINT fk_chat_messages_sender FOREIGN KEY (sender_id)
        REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_chat_messages_recipient FOREIGN KEY (recipient_id)
        REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT chk_chat_messages_content CHECK (CHAR_LENGTH(TRIM(content)) > 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

export async function createChatSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    `INSERT INTO chat_sessions (token_hash, usuario_id, expires_at)
     VALUES ($1, $2, DATE_ADD(CURRENT_TIMESTAMP, INTERVAL $3 DAY))`,
    [tokenHash, userId, sessionDurationDays],
  );
  return token;
}

export async function authenticateChatToken(token) {
  if (typeof token !== 'string' || token.length < 40) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const result = await pool.query(
    `SELECT u.id, u.nombre, u.rol, u.zona
     FROM chat_sessions s INNER JOIN usuarios u ON u.id = s.usuario_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
     LIMIT 1`,
    [tokenHash],
  );
  return result.rows[0] || null;
}

export async function revokeChatToken(token) {
  if (typeof token !== 'string' || token.length < 40) return;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await pool.query(
    'UPDATE chat_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1 AND revoked_at IS NULL',
    [tokenHash],
  );
}