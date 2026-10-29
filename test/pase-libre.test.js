import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerPaseLibreRoutes } from '../src/pase-libre-routes.js';

async function createServer(context, authenticate) {
  const app = express();
  app.use(express.json());
  registerPaseLibreRoutes(app, authenticate ? { authenticate } : undefined);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('Pase Libre se guarda y consulta de forma independiente por destino', async (context) => {
  const states = new Map();
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('SELECT activo, actualizado_en FROM pase_libre_destinos')) {
      const state = states.get(values[0]);
      return { rows: state ? [state] : [] };
    }
    if (sql.includes('FROM pase_libre_destinos p')) {
      return {
        rows: [...states.entries()]
          .filter(([, state]) => state.activo)
          .map(([destinoId]) => ({
            nombre: destinoId === 10 ? 'Ruta 11' : 'Ruta 86',
          })),
      };
    }
    if (sql.includes('SELECT id FROM destinos')) {
      return { rows: [{ id: values[0] }], rowCount: 1 };
    }
    if (sql.includes('SELECT rol, destino_id FROM usuarios')) {
      return {
        rows: [{ rol: 'aduana', destino_id: 10 }],
        rowCount: 1,
      };
    }
    if (sql.includes('INSERT INTO pase_libre_destinos')) {
      const [destinoId, activo] = values;
      const state = {
        activo,
        actualizado_en: '2026-10-02T12:01:00Z',
      };
      states.set(destinoId, state);
      return { rows: [state], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const baseUrl = await createServer(context);
  const updateResponse = await fetch(`${baseUrl}/api/pase-libre`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      activo: true,
      usuario_id: 7,
      destino_id: 10,
    }),
  });
  const updated = await updateResponse.json();
  assert.equal(updateResponse.status, 200);
  assert.equal(updated.data.activo, true);
  assert.equal(updated.data.destino_id, 10);

  const activeResponse = await fetch(
    `${baseUrl}/api/pase-libre?destino_id=10`,
  );
  assert.equal((await activeResponse.json()).data.activo, true);

  const otherDestinationResponse = await fetch(
    `${baseUrl}/api/pase-libre?destino_id=20`,
  );
  assert.equal((await otherDestinationResponse.json()).data.activo, false);

  const globalResponse = await fetch(`${baseUrl}/api/pase-libre`);
  const globalState = (await globalResponse.json()).data;
  assert.equal(globalState.activo, true);
  assert.deepEqual(globalState.destinos, ['Ruta 11']);
});

test('Pase Libre requiere un valor booleano y un destino', async (context) => {
  context.mock.method(pool, 'query', async (query) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('FROM pase_libre_destinos p')) return { rows: [] };
    throw new Error('No query expected for invalid request');
  });

  const baseUrl = await createServer(context);
  const invalidState = await fetch(`${baseUrl}/api/pase-libre`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activo: 'true', destino_id: 10 }),
  });
  assert.equal(invalidState.status, 422);

  const missingDestination = await fetch(`${baseUrl}/api/pase-libre`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ activo: true, usuario_id: 7 }),
  });
  assert.equal(missingDestination.status, 422);

  const globalRead = await fetch(`${baseUrl}/api/pase-libre`);
  assert.equal(globalRead.status, 200);
});

test('Aduana solo puede modificar Pase Libre de su destino asignado', async (context) => {
  context.mock.method(pool, 'query', async (query) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('SELECT id FROM destinos')) {
      return { rows: [{ id: 20 }], rowCount: 1 };
    }
    if (sql.includes('SELECT rol, destino_id FROM usuarios')) {
      return {
        rows: [{ rol: 'aduana', destino_id: 10 }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });

  const baseUrl = await createServer(context);
  const response = await fetch(`${baseUrl}/api/pase-libre`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      activo: true,
      usuario_id: 7,
      destino_id: 20,
    }),
  });
  assert.equal(response.status, 403);
});

test('el administrador de Aduana puede cambiar Pase Libre en cualquier destino', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('SELECT id FROM destinos')) {
      return { rows: [{ id: 20 }], rowCount: 1 };
    }
    if (sql.includes('SELECT rol, destino_id FROM usuarios')) {
      assert.deepEqual(values, [90]);
      return { rows: [{ rol: 'admin_aduana', destino_id: null }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO pase_libre_destinos')) {
      assert.deepEqual(values, [20, true, 90]);
      return {
        rows: [{ activo: true, actualizado_en: '2026-10-02T12:01:00Z' }],
        rowCount: 1,
      };
    }
    if (sql.includes('SELECT activo, actualizado_en FROM pase_libre_destinos')) {
      assert.deepEqual(values, [20]);
      return {
        rows: [{ activo: true, actualizado_en: '2026-10-02T12:01:00Z' }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await createServer(context, async (token) => token === 'aduana-token'
    ? { id: 90, rol: 'admin_aduana' }
    : null);

  const response = await fetch(`${baseUrl}/api/pase-libre`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer aduana-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      activo: true,
      usuario_id: 999,
      destino_id: 20,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.activo, true);
  assert.equal(payload.data.destino_id, 20);
});
