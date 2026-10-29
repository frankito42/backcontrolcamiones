import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {
  createAduanaPushNotifier,
  registerPushNotificationRoutes,
} from '../src/push-notifications.js';

const authorization = (token) => ['Bearer', token].join(' ');

test('solo operadores y Defiba pueden registrar dispositivos para notificaciones', async (context) => {
  const statements = [];
  const app = express();
  app.use(express.json());
  registerPushNotificationRoutes(app, {
    authenticate: async (token) => {
      if (token === 'operador-session') return { id: 14, rol: 'Operador' };
      if (token === 'defiba-session') return { id: 19, rol: 'Defiba' };
      if (token === 'aduana-session') return { id: 23, rol: 'aduana' };
      return null;
    },
    database: {
      async query(sql, values) {
        statements.push({ sql, values });
        return { rowCount: 1, rows: [] };
      },
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  }));
  const url = `http://127.0.0.1:${server.address().port}/api/notifications/device/register`;
  const token = 'firebase-device-token-123456789';

  const aduanaResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer aduana-session',
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(aduanaResponse.status, 403);
  assert.equal(statements.length, 0);

  const unauthorizedResponse = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(unauthorizedResponse.status, 401);
  assert.equal(statements.length, 0);

  const operatorResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer operador-session',
    },
    body: JSON.stringify({ token }),
  });
  assert.equal(operatorResponse.status, 200);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /ON DUPLICATE KEY UPDATE/);
  assert.deepEqual(statements[0].values, [
    token,
    14,
    crypto.createHash('sha256').update('operador-session').digest('hex'),
  ]);

  const defibaResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: authorization('defiba-session'),
    },
    body: JSON.stringify({ token: 'firebase-defiba-device-token-123456789' }),
  });
  assert.equal(defibaResponse.status, 200);
  assert.equal(statements.length, 2);
  assert.deepEqual(statements[1].values, [
    'firebase-defiba-device-token-123456789',
    19,
    crypto.createHash('sha256').update('defiba-session').digest('hex'),
  ]);
});

test('el pedido de Aduana se limita a la zona del operador e incluye Defiba para sus turnos', async () => {
  const statements = [];
  const messages = [];
  const database = {
    async query(sql, values) {
      statements.push({ sql, values });
      if (sql.includes('SELECT d.token')) {
        assert.match(sql, /LOWER\(TRIM\(z\.nombre\)\) = LOWER\(TRIM\(u\.zona\)\)/);
        assert.match(sql, /LOWER\(TRIM\(u\.rol\)\) = 'defiba'/);
        return values[1]
          ? { rows: [{ token: 'defiba-firebase-device-token' }] }
          : { rows: [{ token: 'ruta-11-operator-device-token' }] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const notify = createAduanaPushNotifier(database, {
    logger: { error() {} },
    getMessaging: () => ({
      async sendEachForMulticast(message) {
        messages.push(message);
        return {
          failureCount: 0,
          responses: message.tokens.map(() => ({ success: true })),
        };
      },
    }),
  });

  await notify([
    { id: 18, zona_id: 5, zona_nombre: 'Ruta 11', origen: 'normal', numero: 42, patente: 'AB123CD' },
    { id: 19, zona_id: 9, zona_nombre: 'Defiba', origen: 'defiba', numero: null, patente: 'DEF123' },
  ]);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0].notification, {
    title: 'Nuevo pedido de Aduana',
    body: 'Aduana solicitó el camión #42 (AB123CD).',
  });
  assert.equal(messages[0].android.notification.channelId, 'aduana_requests');
  assert.equal(messages[0].android.notification.sound, 'default');
  assert.deepEqual(messages[0].data, { tipo: 'pedido_aduana', turno_ids: '18' });
  assert.deepEqual(messages[0].tokens, ['ruta-11-operator-device-token']);
  assert.deepEqual(messages[1].notification, {
    title: 'Nuevo pedido de Aduana',
    body: 'Aduana solicitó el camión (DEF123).',
  });
  assert.deepEqual(messages[1].data, { tipo: 'pedido_aduana', turno_ids: '19' });
  assert.deepEqual(messages[1].tokens, ['defiba-firebase-device-token']);
  assert.deepEqual(statements.slice(0, 2).map((statement) => statement.values), [
    [5, false],
    [9, true],
  ]);
});
