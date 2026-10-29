import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerAccountRoutes } from '../src/account-routes.js';

function startApp(context) {
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app, { authenticate: async () => ({ id: 1, rol: 'admin' }) });
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('crea un usuario Operador de Pase con el destino asignado', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    if (sql.includes('SELECT id FROM destinos')) {
      assert.deepEqual(values, [6]);
      return { rows: [{ id: 6 }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO usuarios')) {
      assert.match(sql, /destino_id/);
      assert.equal(values[5], 6);
      assert.equal(values[7], 'pase');
      return { insertId: 31, rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nombre: 'Pase Norte',
      user: 'pase_norte',
      dni: '10006',
      pass: 'secret',
      rol: 'pase',
      destino_id: 6,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.data.id, 31);
});

test('actualiza el destino asignado a un usuario Operador de Pase', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    if (sql.includes('SELECT id FROM destinos')) {
      assert.deepEqual(values, [6]);
      return { rows: [{ id: 6 }], rowCount: 1 };
    }
    if (sql.includes('SELECT id, rol, zona FROM usuarios WHERE id')) {
      return { rows: [{ id: 31, rol: 'pase', zona: 'Ruta 86' }], rowCount: 1 };
    }
    if (sql.includes('SELECT id FROM usuarios WHERE `user`')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE usuarios SET nombre=')) {
      assert.match(sql, /destino_id=\$6/);
      assert.equal(values[5], 6);
      assert.equal(values[6], 'pase');
      assert.equal(values[7], 31);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 31,
      nombre: 'Pase Norte',
      user: 'pase_norte',
      dni: '10006',
      telefono: '',
      zona: 'Ruta 86',
      pass: '',
      rol: 'pase',
      destino_id: 6,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
});
