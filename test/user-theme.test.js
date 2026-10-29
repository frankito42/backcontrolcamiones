import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerAccountRoutes } from '../src/account-routes.js';

function startApp(context) {
  const app = express();
  app.use(express.json());
  registerAccountRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('persiste el tema del usuario autenticado', async (context) => {
  const token = 't'.repeat(48);
  context.mock.method(pool, 'query', async (query, values = []) => {
    const sql = typeof query === 'string' ? query : query.text;
    if (sql.includes('FROM chat_sessions')) {
      assert.equal(values.length, 1);
      return { rows: [{ id: 27, nombre: 'Operador', rol: 'operador', zona: 'Ruta 11' }] };
    }
    if (sql.includes('UPDATE usuarios SET tema_preferido')) {
      assert.deepEqual(values, ['azul_marino', 27]);
      return { rowCount: 1 };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/usuarios/tema`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tema_preferido: 'azul_marino' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.tema_preferido, 'azul_marino');
});

test('rechaza temas desconocidos sin modificar la cuenta', async (context) => {
  const token = 't'.repeat(48);
  context.mock.method(pool, 'query', async (query) => {
    const sql = typeof query === 'string' ? query : query.text;
    assert.match(sql, /FROM chat_sessions/);
    return { rows: [{ id: 27, nombre: 'Operador', rol: 'operador', zona: 'Ruta 11' }] };
  });
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/usuarios/tema`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ tema_preferido: 'solarizado' }),
  });
  const payload = await response.json();

  assert.equal(response.status, 422);
  assert.match(payload.message, /tema seleccionado no es válido/i);
});
