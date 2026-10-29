import { pool } from './db.js';
import { authenticateChatToken, revokeChatToken } from './chat-auth.js';
import { emitChatToUser, getChatOnlineUserIds, isChatUserOnline } from './realtime.js';
import { fail, positiveInt, respond } from './helpers.js';

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function requireChatUser(req, res, next) {
  authenticateChatToken(bearerToken(req))
    .then((user) => {
      if (!user) return fail(res, 'La sesión de chat expiró. Vuelve a iniciar sesión.', 401);
      req.chatUser = user;
      return next();
    })
    .catch(next);
}

export function registerChatRoutes(app) {
  app.get('/api/chat/contacts', requireChatUser, async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.nombre, u.rol, u.zona,
                COALESCE(unread.count, 0)::int AS unread_count,
                recent.id AS last_message_id, recent.sender_id AS last_sender_id,
                recent.content AS last_message, recent.created_at AS last_message_at,
                recent.delivered_at AS last_delivered_at, recent.read_at AS last_read_at
         FROM usuarios u
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS count FROM chat_messages m
           WHERE m.sender_id = u.id AND m.recipient_id = $1 AND m.read_at IS NULL
         ) unread ON TRUE
         LEFT JOIN LATERAL (
           SELECT m.id, m.sender_id, m.content, m.created_at, m.delivered_at, m.read_at
           FROM chat_messages m
           WHERE (m.sender_id = $1 AND m.recipient_id = u.id)
              OR (m.sender_id = u.id AND m.recipient_id = $1)
           ORDER BY m.id DESC LIMIT 1
         ) recent ON TRUE
         WHERE u.id <> $1 ORDER BY recent.id DESC NULLS LAST, u.nombre ASC`,
        [req.chatUser.id],
      );
      const onlineIds = getChatOnlineUserIds();
      return respond(res, true, 'Contactos de chat.', result.rows.map((contact) => ({
        ...contact,
        online: onlineIds.has(Number(contact.id)),
      })));
    } catch (error) {
      return next(error);
    }
  });

  app.get('/api/chat/messages/:userId', requireChatUser, async (req, res, next) => {
    try {
      const peerId = positiveInt(req.params.userId);
      const beforeId = positiveInt(req.query.before_id) || null;
      const limit = Math.min(100, positiveInt(req.query.limit) || 50);
      if (!peerId || peerId === Number(req.chatUser.id)) return fail(res, 'Contacto inválido.', 422);

      const read = await pool.query(
        `UPDATE chat_messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
           read_at = CURRENT_TIMESTAMP
         WHERE sender_id = $1 AND recipient_id = $2 AND read_at IS NULL RETURNING id`,
        [peerId, req.chatUser.id],
      );
      if (read.rowCount) {
        emitChatToUser(peerId, 'chat.read', {
          reader_id: req.chatUser.id,
          message_ids: read.rows.map((message) => Number(message.id)),
        });
      }

      const result = await pool.query(
        `SELECT id, sender_id, recipient_id, content, created_at, delivered_at, read_at
         FROM chat_messages
         WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
           AND ($3::bigint IS NULL OR id < $3)
         ORDER BY id DESC LIMIT $4`,
        [req.chatUser.id, peerId, beforeId, limit],
      );
      return respond(res, true, 'Mensajes de conversación.', result.rows.reverse());
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/chat/messages', requireChatUser, async (req, res, next) => {
    try {
      const recipientId = positiveInt(req.body.recipient_id);
      const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
      if (!recipientId || recipientId === Number(req.chatUser.id)) {
        return fail(res, 'Destinatario inválido.', 422);
      }
      if (!content || content.length > 2000) return fail(res, 'El mensaje debe tener entre 1 y 2000 caracteres.', 422);
      const recipient = await pool.query('SELECT id FROM usuarios WHERE id = $1', [recipientId]);
      if (!recipient.rowCount) return fail(res, 'Usuario no encontrado.', 404);

      const result = await pool.query(
        `INSERT INTO chat_messages (sender_id, recipient_id, content)
         VALUES ($1, $2, $3)
         RETURNING id, sender_id, recipient_id, content, created_at, delivered_at, read_at`,
        [req.chatUser.id, recipientId, content],
      );
      const message = result.rows[0];
      if (isChatUserOnline(recipientId)) {
        const delivered = await pool.query(
          `UPDATE chat_messages SET delivered_at = CURRENT_TIMESTAMP
           WHERE id = $1 AND delivered_at IS NULL
           RETURNING delivered_at`,
          [message.id],
        );
        message.delivered_at = delivered.rows[0]?.delivered_at ?? message.delivered_at;
        emitChatToUser(recipientId, 'chat.message', message);
      }
      return respond(res, true, 'Mensaje enviado.', message, 201);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/chat/logout', requireChatUser, async (req, res, next) => {
    try {
      await revokeChatToken(bearerToken(req));
      return respond(res, true, 'Sesión de chat cerrada.');
    } catch (error) {
      return next(error);
    }
  });
}