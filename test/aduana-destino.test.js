import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerAccountRoutes } from '../src/account-routes.js';
import { registerTurnoRoutes } from '../src/turno-routes.js';

function startApp(context, register) {
  const app = express();
  app.use(express.json());
  if (register === registerAccountRoutes) {
    register(app, { authenticate: async () => ({ id: 1, rol: 'admin' }) });
  } else {
    register(app);
  }
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('no permite crear una cuenta Aduana sin destino asignado', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('No database query should be needed');
  });
  const baseUrl = await startApp(context, registerAccountRoutes);

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nombre: 'Aduana Norte',
      user: 'aduana_norte',
      dni: '10001',
      pass: 'secret',
      rol: 'aduana',
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.match(payload.message, /destino asignado/i);
  assert.equal(queryCalled, false);
});

test('persiste el destino elegido al crear una cuenta Aduana', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('SELECT id FROM destinos')) {
      assert.deepEqual(values, [9]);
      return { rows: [{ id: 9 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO usuarios')) {
      assert.match(sql, /destino_id/);
      assert.deepEqual(values, [
        'Aduana Norte',
        'aduana_norte',
        '10001',
        null,
        null,
        9,
        'secret',
        'aduana',
      ]);
      return { rows: [{ id: 31 }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context, registerAccountRoutes);

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nombre: 'Aduana Norte',
      user: 'aduana_norte',
      dni: '10001',
      pass: 'secret',
      rol: 'aduana',
      destino_id: 9,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.id, 31);
});

test('el listado de Aduana limita turnos al destino solicitado', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    assert.match(sql, /t\.destino_id = \$1/);
    assert.match(sql, /'pendiente', 'llegando', 'finalizado', 'anulado'/);
    assert.deepEqual(values, [9]);
    return { rows: [] };
  });
  const baseUrl = await startApp(context, registerTurnoRoutes);

  const response = await fetch(`${baseUrl}/api/turnos?aduana_visible=1&destino_id=9`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, []);
});

test('el listado de turnos admite filtrar por destino fuera de la vista de Aduana', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    assert.match(sql, /t\.destino_id = \$1/);
    assert.deepEqual(values, [6]);
    return { rows: [] };
  });
  const baseUrl = await startApp(context, registerTurnoRoutes);

  const response = await fetch(`${baseUrl}/api/turnos?destino_id=6`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, []);
});

test('Aduana puede quitar un turno confirmado de su lista', async (context) => {
  const queries = [];
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT u.rol, u.destino_id')) {
        return {
          rows: [{
            rol: 'aduana',
            usuario_destino_id: 9,
            id: 44,
            destino_id: 9,
            estado: 'reservado',
            zona_id: 3,
            origen: 'normal',
            aduana_confirmado: true,
            zona_nombre: 'Ruta 11',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE turnos')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO turno_historial')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context, registerTurnoRoutes);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accion: 'quitar_solicitud_aduana',
      turno_id: 44,
      usuario_id: 21,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.message, /quitado de la lista/i);
  const update = queries.find(({ sql }) => sql.includes('UPDATE turnos'));
  assert.match(update.sql, /aduana_confirmado = FALSE/);
  assert.match(update.sql, /estado_aduana = NULL/);
  const historyInsert = queries.find(({ sql }) => sql.includes('INSERT INTO turno_historial'));
  assert.equal(historyInsert.values[3], 'quitar_lista_aduana');
});

test('Aduana solo puede modificar turnos de su destino asignado', async (context) => {
  let turnoUpdated = false;
  const client = {
    async query(sql) {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT u.rol, u.destino_id')) {
        return {
          rows: [{
            rol: 'aduana',
            usuario_destino_id: 9,
            id: 44,
            destino_id: 12,
            estado: 'reservado',
            zona_id: 3,
            origen: 'normal',
            aduana_confirmado: true,
            zona_nombre: 'Ruta 11',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE turnos')) turnoUpdated = true;
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context, registerTurnoRoutes);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accion: 'quitar_solicitud_aduana',
      turno_id: 44,
      usuario_id: 21,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.message, /no tienes permiso/i);
  assert.equal(turnoUpdated, false);
});

test('Aduana puede finalizar un turno solicitado aunque aun no este en curso', async (context) => {
  let finalized = false;
  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT u.rol, u.destino_id')) {
        return {
          rows: [{
            rol: 'aduana',
            usuario_destino_id: 9,
            id: 44,
            destino_id: 9,
            estado: 'reservado',
            zona_id: 3,
            origen: 'normal',
            aduana_confirmado: true,
            zona_nombre: 'Ruta 11',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("SET estado = 'finalizado'")) {
        finalized = true;
        assert.deepEqual(values, [44]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO turno_historial')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context, registerTurnoRoutes);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      accion: 'finalizar_turno_aduana',
      turno_id: 44,
      usuario_id: 21,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(payload.message, /marcado como finalizado/i);
  assert.equal(finalized, true);
});