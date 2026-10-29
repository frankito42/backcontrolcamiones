import { Server as SocketIOServer } from 'socket.io';
import { corsOriginCallback } from './cors-config.js';
import { pool } from './db.js';
import { authenticateChatToken } from './chat-auth.js';

let io;
let chatNamespace;
const chatSockets = new Map();
const chatLastSeen = new Map();

export function attachRealtime(server) {
  io = new SocketIOServer(server, {
    cors: {
      origin: corsOriginCallback,
      methods: ['GET', 'POST'],
    },
  });
  chatNamespace = io.of('/chat');
  chatNamespace.use(async (socket, next) => {
    try {
      const user = await authenticateChatToken(socket.handshake.auth?.token);
      if (!user) return next(new Error('unauthorized'));
      socket.data.chatUser = user;
      return next();
    } catch (error) {
      return next(error);
    }
  });
  chatNamespace.on('connection', (socket) => {
    void connectChatSocket(socket);
  });
  return io;
}

async function connectChatSocket(socket) {
  const userId = Number(socket.data.chatUser.id);
  const sockets = chatSockets.get(userId) || new Set();
  const wasOffline = sockets.size === 0;
  sockets.add(socket.id);
  chatSockets.set(userId, sockets);
  socket.join(`user:${userId}`);
  socket.emit('chat.presence.snapshot', { online_user_ids: [...chatSockets.keys()] });
  if (wasOffline) chatNamespace.emit('chat.presence.changed', { user_id: userId, online: true });

  socket.on('disconnect', () => {
    const active = chatSockets.get(userId);
    active?.delete(socket.id);
    if (active?.size) return;
    chatSockets.delete(userId);
    const lastSeen = new Date().toISOString();
    chatLastSeen.set(userId, lastSeen);
    chatNamespace.emit('chat.presence.changed', { user_id: userId, online: false, last_seen: lastSeen });
  });

  try {
    const delivered = await pool.query(
      `UPDATE chat_messages SET delivered_at = CURRENT_TIMESTAMP
       WHERE recipient_id = $1 AND delivered_at IS NULL
       RETURNING id, sender_id`,
      [userId],
    );
    const senders = new Map();
    for (const row of delivered.rows) {
      const senderId = Number(row.sender_id);
      const ids = senders.get(senderId) || [];
      ids.push(Number(row.id));
      senders.set(senderId, ids);
    }
    for (const [senderId, messageIds] of senders) {
      emitChatToUser(senderId, 'chat.delivered', { recipient_id: userId, message_ids: messageIds });
    }
  } catch (error) {
    console.error('[chat] No se pudieron marcar mensajes entregados:', error.message);
  }
}

export function isChatUserOnline(userId) {
  return (chatSockets.get(Number(userId))?.size || 0) > 0;
}

export function getChatOnlineUserIds() {
  return new Set(chatSockets.keys());
}

export function getChatLastSeen(userId) {
  return chatLastSeen.get(Number(userId)) || null;
}

export function emitChatToUser(userId, event, payload) {
  if (!chatNamespace || !isChatUserOnline(userId)) return false;
  chatNamespace.to(`user:${Number(userId)}`).emit(event, payload);
  return true;
}

export function emitTurnosChanged() {
  io?.emit('turnos.changed', { changed_at: new Date().toISOString() });
}

export function emitDefibaTurnosChanged(payload = {}) {
  io?.emit('turnos.defiba.changed', {
    changed_at: new Date().toISOString(),
    ...payload,
  });
}

export function emitAduanaTurnosChanged(payload = {}) {
  io?.emit('turnos.aduana.changed', {
    changed_at: new Date().toISOString(),
    ...payload,
  });
}

export function emitCargasEspecialesChanged() {
  io?.emit('cargas.especiales.changed', {
    changed_at: new Date().toISOString(),
  });
}

export function emitPaseLibreChanged(activo, destinoId) {
  io?.emit('pase.libre.changed', {
    activo: activo === true,
    destino_id: Number(destinoId),
    changed_at: new Date().toISOString(),
  });
}

export function emitQrScanned(zoneId) {
  io?.emit('qr.scanned', { zona_id: Number(zoneId) });
}

export function emitQrTurnoSolicitado({ zoneId, zoneName, number }) {
  io?.emit('qr.turno.solicitado', {
    zona_id: Number(zoneId),
    zona_nombre: String(zoneName || ''),
    numero: number,
    changed_at: new Date().toISOString(),
  });
}