import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import express from 'express';
import { io as createClient } from 'socket.io-client';
import { registerChatRoutes } from '../src/chat-routes.js';
import { pool } from '../src/db.js';
import {
  attachRealtime,
  emitCargasEspecialesChanged,
  emitPaseLibreChanged,
  emitQrTurnoSolicitado,
  emitTurnosChanged,
  getChatOnlineUserIds,
} from '../src/realtime.js';

function waitForSocketEvent(client, event, matches = () => true) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, 2_000);
    const listener = (payload) => {
      if (!matches(payload)) return;
      clearTimeout(timeout);
      client.off(event, listener);
      resolve(payload);
    };
    client.on(event, listener);
  });
}

test('Socket.IO emite invalidación de turnos sin incluir datos de la fila', async (context) => {
  const server = createServer();
  const ioServer = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = createClient(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 2_000,
  });
  context.after(async () => {
    client.disconnect();
    await new Promise((resolve) => ioServer.close(resolve));
  });

  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  const changed = new Promise((resolve) => client.once('turnos.changed', resolve));
  emitTurnosChanged();
  const payload = await changed;

  assert.equal(typeof payload.changed_at, 'string');
  assert.deepEqual(Object.keys(payload), ['changed_at']);

  const cargasChanged = new Promise((resolve) => client.once('cargas.especiales.changed', resolve));
  emitCargasEspecialesChanged();
  const cargasPayload = await cargasChanged;
  assert.equal(typeof cargasPayload.changed_at, 'string');

  const paseLibreChanged = new Promise((resolve) => client.once('pase.libre.changed', resolve));
  emitPaseLibreChanged(true);
  const paseLibrePayload = await paseLibreChanged;
  assert.equal(paseLibrePayload.activo, true);
  assert.equal(typeof paseLibrePayload.changed_at, 'string');

  const qrTurnoSolicitado = new Promise((resolve) =>
    client.once('qr.turno.solicitado', resolve));
  emitQrTurnoSolicitado({
    zoneId: 7,
    zoneName: 'Ruta 11',
    number: 17,
  });
  const qrPayload = await qrTurnoSolicitado;
  assert.equal(qrPayload.zona_id, 7);
  assert.equal(qrPayload.zona_nombre, 'Ruta 11');
  assert.equal(qrPayload.numero, 17);
  assert.equal(typeof qrPayload.changed_at, 'string');
});

test('presencia se limpia si el usuario se desconecta durante la sincronización de entregas', async (context) => {
  const targetToken = 'target-chat-token'.padEnd(48, 'x');
  const observerToken = 'observer-chat-token'.padEnd(48, 'y');
  const usersByTokenHash = new Map([
    [createHash('sha256').update(targetToken).digest('hex'), 51],
    [createHash('sha256').update(observerToken).digest('hex'), 52],
  ]);
  let releaseDeliveryLookup;
  const deliveryLookup = new Promise((resolve) => {
    releaseDeliveryLookup = resolve;
  });

  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('FROM chat_sessions')) {
      const id = usersByTokenHash.get(values[0]);
      return { rows: id ? [{ id, nombre: `User ${id}`, rol: 'admin', zona: '' }] : [] };
    }
    if (sql.includes('SELECT id, sender_id FROM chat_messages')) {
      return Number(values[0]) === 51 ? deliveryLookup : { rows: [] };
    }
    throw new Error(`Unexpected query in realtime test: ${sql}`);
  });

  const server = createServer();
  const ioServer = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/chat`;
  const observer = createClient(baseUrl, {
    auth: { token: observerToken },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: 2_000,
  });
  const target = createClient(baseUrl, {
    auth: { token: targetToken },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: 2_000,
  });

  context.after(async () => {
    releaseDeliveryLookup({ rows: [] });
    observer.disconnect();
    target.disconnect();
    await new Promise((resolve) => ioServer.close(resolve));
  });

  const observerConnected = waitForSocketEvent(observer, 'connect');
  observer.connect();
  await observerConnected;
  const wentOnline = waitForSocketEvent(
    observer,
    'chat.presence.changed',
    (event) => Number(event.user_id) === 51 && event.online === true,
  );
  const targetConnected = waitForSocketEvent(target, 'connect');
  target.connect();
  await targetConnected;
  await wentOnline;

  const wentOffline = waitForSocketEvent(
    observer,
    'chat.presence.changed',
    (event) => Number(event.user_id) === 51 && event.online === false,
  );
  target.disconnect();
  await wentOffline;
  assert.equal(getChatOnlineUserIds().has(51), false);

  releaseDeliveryLookup({ rows: [] });
});

test('mensajes y recibos de lectura se emiten en tiempo real entre usuarios conectados', async (context) => {
  const senderToken = 'sender-chat-token'.padEnd(48, 's');
  const recipientToken = 'recipient-chat-token'.padEnd(48, 'r');
  const usersByTokenHash = new Map([
    [createHash('sha256').update(senderToken).digest('hex'), 61],
    [createHash('sha256').update(recipientToken).digest('hex'), 62],
  ]);
  const deliveredAt = new Date().toISOString();
  const readAt = new Date(Date.now() + 1_000).toISOString();
  const message = {
    id: 901,
    sender_id: 61,
    recipient_id: 62,
    content: 'Llegué a la planta.',
    created_at: new Date().toISOString(),
    delivered_at: deliveredAt,
    read_at: readAt,
  };

  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('FROM chat_sessions')) {
      const id = usersByTokenHash.get(values[0]);
      return { rows: id ? [{ id, nombre: `User ${id}`, rol: 'admin', zona: '' }] : [] };
    }
    if (sql.includes('SELECT id, sender_id FROM chat_messages')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT id FROM chat_messages')) {
      return { rows: [{ id: message.id }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM usuarios')) {
      return { rows: [{ id: Number(values[0]) }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO chat_messages')) {
      return { insertId: message.id, rowCount: 1 };
    }
    if (sql.includes('SELECT id, sender_id, recipient_id, content') && sql.includes('WHERE id = $1')) {
      return { rows: [{ ...message, delivered_at: null, read_at: null }], rowCount: 1 };
    }
    if (sql.includes('SELECT id, sender_id, recipient_id, content')) {
      return { rows: [{ ...message, read_at: readAt }], rowCount: 1 };
    }
    if (sql.includes('SELECT delivered_at FROM chat_messages')) {
      return { rows: [{ delivered_at: deliveredAt }], rowCount: 1 };
    }
    if (sql.includes('SET delivered_at = COALESCE')) return { rows: [], rowCount: 1 };
    if (sql.includes('SET delivered_at = CURRENT_TIMESTAMP')) return { rows: [], rowCount: 1 };
    throw new Error(`Unexpected query in chat test: ${sql}`);
  });

  const app = express();
  app.use(express.json());
  registerChatRoutes(app);
  const server = createServer(app);
  const ioServer = attachRealtime(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sender = createClient(`${baseUrl}/chat`, {
    auth: { token: senderToken },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: 2_000,
  });
  const recipient = createClient(`${baseUrl}/chat`, {
    auth: { token: recipientToken },
    transports: ['websocket'],
    reconnection: false,
    autoConnect: false,
    timeout: 2_000,
  });

  context.after(async () => {
    sender.disconnect();
    recipient.disconnect();
    await new Promise((resolve) => ioServer.close(resolve));
  });

  const senderConnected = waitForSocketEvent(sender, 'connect');
  sender.connect();
  await senderConnected;
  const recipientConnected = waitForSocketEvent(recipient, 'connect');
  recipient.connect();
  await recipientConnected;

  const incomingMessage = waitForSocketEvent(recipient, 'chat.message');
  const sendResponse = await fetch(`${baseUrl}/api/chat/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${senderToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ recipient_id: 62, content: message.content }),
  });
  const sent = await sendResponse.json();
  const pushedMessage = await incomingMessage;

  assert.equal(sendResponse.status, 201);
  assert.equal(sent.data.content, message.content);
  assert.ok(sent.data.delivered_at);
  assert.equal(pushedMessage.id, message.id);

  const readReceipt = waitForSocketEvent(sender, 'chat.read');
  const readResponse = await fetch(`${baseUrl}/api/chat/messages/61`, {
    headers: { authorization: `Bearer ${recipientToken}` },
  });
  const conversation = await readResponse.json();
  const receipt = await readReceipt;

  assert.equal(readResponse.status, 200);
  assert.equal(conversation.data[0].read_at, readAt);
  assert.equal(receipt.reader_id, 62);
  assert.deepEqual(receipt.message_ids, [message.id]);
});