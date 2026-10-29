import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerCargasEspecialesRoutes } from '../src/cargas-especiales-routes.js';

async function startApp(context) {
  const app = express();
  app.use(express.json());
  registerCargasEspecialesRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('la carga especial se guarda sin turno y empieza en camino', async (context) => {
  const statements = [];
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    statements.push(sql);
    if (sql.includes('FROM zonas')) return { rows: [{ id: 8 }], rowCount: 1 };
    if (sql.includes('FROM destinos')) return { rows: [{ id: 4 }], rowCount: 1 };
    if (sql.includes('INSERT INTO cargas_especiales')) {
      assert.deepEqual(values, ['ABC123', 8, 4, 21]);
      return { insertId: 33, rowCount: 1 };
    }
    if (sql.includes('FROM cargas_especiales WHERE id = $1')) {
      return {
        rows: [{ id: 33, patente: 'ABC123', zona_id: 8, destino_id: 4, estado: 'en_camino', usuario_id: 21 }],
        rowCount: 1,
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/cargas-especiales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patente: ' abc123 ', destino_id: 4, usuario_id: 21 }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.estado, 'en_camino');
  assert.equal(payload.data.numero, undefined);
  assert.ok(statements.some((sql) => sql.includes('INSERT INTO cargas_especiales')));
  assert.equal(statements.some((sql) => sql.includes('INSERT INTO turnos')), false);
});

test('el listado de cargas especiales limita al destino y solo trae las que siguen en camino', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    assert.match(sql, /ce\.estado = 'en_camino'/);
    assert.match(sql, /FROM cargas_especiales/);
    assert.match(sql, /ce\.destino_id = \$2/);
    assert.deepEqual(values, ['cargas especiales', 9]);
    return { rows: [{ id: 33, patente: 'ABC123', estado: 'en_camino' }] };
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/cargas-especiales?destino_id=9`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.length, 1);
  assert.equal(payload.data[0].estado, 'en_camino');
});

test('finalizar cambia el estado de la carga especial', async (context) => {
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    assert.deepEqual(values, [33]);
    if (sql.includes("SET estado = 'finalizado'")) return { rows: [], rowCount: 1 };
    if (sql.includes('SELECT id, estado FROM cargas_especiales')) {
      return { rows: [{ id: 33, estado: 'finalizado' }], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/cargas-especiales/33/finalizar`, {
    method: 'PUT',
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.estado, 'finalizado');
});