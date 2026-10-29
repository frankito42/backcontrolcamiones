import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerTurnoRoutes } from '../src/turno-routes.js';

function startApp(context) {
  const app = express();
  app.use(express.json());
  registerTurnoRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('crea turnos guardando la mercadería y la devuelve en la respuesta', async (context) => {
  let insertValues;
  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT patente, telefono FROM camioneros')) {
        return { rows: [{ patente: 'AA123BB', telefono: '' }], rowCount: 1 };
      }
      if (sql.includes('SELECT nombre FROM zonas')) {
        return { rows: [{ nombre: 'Zona Norte' }], rowCount: 1 };
      }
      if (sql.includes('SELECT 1 FROM destinos')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes('SELECT id, patente FROM turnos')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM zonas ORDER BY id LIMIT 1 FOR UPDATE')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.includes('MAX(numero)')) return { rows: [{ numero: 88 }], rowCount: 1 };
      if (sql.includes('INSERT INTO turnos')) {
        assert.match(sql, /mercaderia/);
        insertValues = values;
        return { insertId: 41, rowCount: 1 };
      }
      if (sql.includes('SELECT id, numero, fecha_ingreso, hora_ingreso FROM turnos')) {
        return { rows: [{ id: 41, numero: 88, fecha_ingreso: '2026-10-08', hora_ingreso: '11:00:00' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO turno_historial')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'query', async (sql) => {
    if (sql.includes('SELECT rol, zona FROM usuarios')) {
      return { rows: [{ rol: 'operador', zona: 'Zona Norte' }], rowCount: 1 };
    }
    if (sql.includes('FROM turnos t')) {
      assert.match(sql, /t\.mercaderia/);
      assert.match(sql, /t\.mercaderia_vacia/);
      return { rows: [{ mercaderia: 'Granos y semillas', mercaderia_vacia: false }], rowCount: 1 };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  });
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      camionero_id: 22,
      patente: 'AA123BB',
      empresa: 'Empresa de prueba',
      mercaderia: 'Granos y semillas',
      destino_id: 7,
      usuario_id: 5,
      zona_id: 2,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(insertValues[4], 'Granos y semillas');
  assert.equal(insertValues[5], false);
  assert.equal(payload.data.mercaderia, 'Granos y semillas');
  assert.equal(payload.data.mercaderia_vacia, false);

  const listResponse = await fetch(`${baseUrl}/api/turnos`);
  const listPayload = await listResponse.json();

  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.data[0].mercaderia, 'Granos y semillas');
  assert.equal(listPayload.data[0].mercaderia_vacia, false);
});

test('guarda la mercadería como vacía y exige destino', async (context) => {
  let insertValues;
  const client = {
    async query(sql, values = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT patente, telefono FROM camioneros')) {
        return { rows: [{ patente: 'AA123BB', telefono: '' }], rowCount: 1 };
      }
      if (sql.includes('SELECT nombre FROM zonas')) {
        return { rows: [{ nombre: 'Zona Norte' }], rowCount: 1 };
      }
      if (sql.includes('SELECT 1 FROM destinos')) {
        return { rows: [{}], rowCount: 1 };
      }
      if (sql.includes('SELECT id, patente FROM turnos')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM zonas ORDER BY id LIMIT 1 FOR UPDATE')) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.includes('MAX(numero)')) return { rows: [{ numero: 88 }], rowCount: 1 };
      if (sql.includes('INSERT INTO turnos')) {
        insertValues = values;
        return { insertId: 42, rowCount: 1 };
      }
      if (sql.includes('SELECT id, numero, fecha_ingreso, hora_ingreso FROM turnos')) {
        return { rows: [{ id: 42, numero: 89, fecha_ingreso: '2026-10-08', hora_ingreso: '11:00:00' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO turno_historial')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'query', async (sql) => {
    if (sql.includes('SELECT rol, zona FROM usuarios')) {
      return { rows: [{ rol: 'operador', zona: 'Zona Norte' }], rowCount: 1 };
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  });
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      camionero_id: 22,
      patente: 'AA123BB',
      usuario_id: 5,
      zona_id: 2,
      destino_id: 7,
      mercaderia: 'debe ignorarse',
      mercaderia_vacia: true,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(insertValues[4], null);
  assert.equal(insertValues[5], true);
  assert.equal(payload.data.mercaderia, '');
  assert.equal(payload.data.mercaderia_vacia, true);

  const missingDestinationResponse = await fetch(`${baseUrl}/api/turnos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      camionero_id: 22,
      patente: 'AA123BB',
      usuario_id: 5,
      zona_id: 2,
    }),
  });
  const missingDestinationPayload = await missingDestinationResponse.json();

  assert.equal(missingDestinationResponse.status, 422);
  assert.match(missingDestinationPayload.message, /destino/i);
});

test('actualiza la mercadería al confirmar un turno reservado', async (context) => {
  const updates = [];
  context.mock.method(pool, 'query', async (sql) => {
    assert.match(sql, /SELECT t\.numero/);
    return {
      rows: [{
        numero: 88,
        zona_id: 2,
        estado: 'pendiente',
        origen: 'normal',
        zona_nombre: 'Zona Norte',
        aduana_confirmado: false,
        camionero_telefono: '',
        camionero_nombre: 'Chofer',
      }],
      rowCount: 1,
    };
  });
  const client = {
    async query(sql, values = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT u.rol, z.id')) {
        return { rows: [{ rol: 'operador', id: 2 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE turnos SET estado=')) {
        assert.match(sql, /mercaderia=CASE/);
        assert.match(sql, /WHERE id=\$9/);
        assert.equal(values[8], 41);
        updates.push({ sql, values });
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO turno_historial')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context);

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 41,
      estado: 'reservado',
      usuario_id: 5,
      empresa: 'Empresa de prueba',
      mercaderia: 'Carga de trigo',
      mercaderia_vacia: false,
      destino_id: 7,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.success, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].values[7], 'Carga de trigo');
  assert.equal(updates[0].values[9], false);

  const emptyResponse = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 41,
      estado: 'reservado',
      usuario_id: 5,
      destino_id: 7,
      mercaderia: '',
      mercaderia_vacia: true,
    }),
  });

  assert.equal(emptyResponse.status, 200);
  assert.equal(updates.length, 2);
  assert.equal(updates[1].values[7], '');
  assert.equal(updates[1].values[9], true);
});
