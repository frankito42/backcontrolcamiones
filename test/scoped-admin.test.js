import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pool } from '../src/db.js';
import { registerAccountRoutes } from '../src/account-routes.js';
import { registerTurnoRoutes } from '../src/turno-routes.js';

function startApp(context, register) {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return new Promise((resolve) => {
    server.once('listening', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

test('el admin de Aduana solo recibe cuentas Aduana, sin contraseñas', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /u\.rol = \$1/);
    assert.doesNotMatch(sql, /u\.pass/);
    assert.deepEqual(values, ['aduana']);
    return {
      rows: [{
        id: 4,
        nombre: 'Aduana Falcon',
        rol: 'aduana',
        destino_id: 2,
      }],
      rowCount: 1,
    };
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async (token) => token === 'aduana-token'
      ? { id: 90, rol: 'admin_aduana' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    headers: { authorization: 'Bearer aduana-token' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.map((user) => user.rol), ['aduana']);
  assert.equal('pass' in payload.data[0], false);
});

test('el admin de Defiba no puede crear cuentas fuera de su área', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('No database query should be needed');
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async (token) => token === 'defiba-token'
      ? { id: 91, rol: 'admin_defiba' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer defiba-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      nombre: 'Aduana Norte',
      user: 'aduana_norte',
      dni: '123',
      pass: 'secret',
      rol: 'aduana',
      destino_id: 2,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 403);
  assert.match(payload.message, /área que administras/i);
  assert.equal(queryCalled, false);
});

test('el admin de Defiba crea sus usuarios únicamente en la zona Defiba', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /INSERT INTO usuarios/);
    assert.equal(values[4], 'Defiba');
    assert.equal(values[7], 'defiba');
    return { insertId: 123, rowCount: 1 };
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async (token) => token === 'defiba-token'
      ? { id: 91, rol: 'admin_defiba' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer defiba-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      nombre: 'Usuario Defiba',
      user: 'usuario_defiba',
      dni: '456',
      pass: 'secret',
      rol: 'defiba',
      zona: 'Falcon',
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
});

test('el admin de Tránsito solo lista operadores y pases de Ruta 11 y Ruta 86', async (context) => {
  context.mock.method(pool, 'query', async (sql) => {
    assert.match(sql, /LOWER\(TRIM\(u\.rol\)\) IN \('operador', 'pase'\)/);
    assert.match(sql, /LOWER\(TRIM\(COALESCE\(u\.zona, ''\)\)\) IN \('ruta 11', 'ruta 86'\)/);
    assert.doesNotMatch(sql, /u\.pass/);
    return {
      rows: [
        { id: 21, rol: 'operador', zona: 'Ruta 11' },
        { id: 22, rol: 'pase', zona: 'Ruta 86' },
      ],
      rowCount: 2,
    };
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async (token) => token === 'transito-token'
      ? { id: 92, rol: 'admin_transito' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    headers: { authorization: 'Bearer transito-token' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data.map((user) => user.rol), ['operador', 'pase']);
});

test('el admin de Tránsito solo crea usuarios en las zonas autorizadas', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    if (sql.includes('SELECT id FROM destinos')) return { rows: [{ id: 5 }], rowCount: 1 };
    assert.match(sql, /INSERT INTO usuarios/);
    assert.equal(values[4], 'Ruta 86');
    assert.equal(values[7], 'pase');
    return { insertId: 123, rowCount: 1 };
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async () => ({ id: 92, rol: 'admin_transito' }),
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer transito-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      nombre: 'Pase Ruta 86',
      user: 'pase_ruta86',
      dni: '789',
      pass: 'secret',
      rol: 'pase',
      zona: 'ruta 86',
      destino_id: 5,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 201);
  assert.equal(payload.success, true);
});

test('el usuario con datos asociados se desactiva y conserva sus datos', async (context) => {
  const statements = [];
  context.mock.method(pool, 'connect', async () => ({
    query: async (sql, values = []) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT id, rol, zona, activo FROM usuarios')) {
        assert.deepEqual(values, [45]);
        return { rows: [{ id: 45, rol: 'operador', zona: 'Ruta 11', activo: 1 }], rowCount: 1 };
      }
      if (sql.includes('has_related_data')) {
        assert.match(sql, /turno_historial/);
        assert.match(sql, /chat_messages/);
        assert.deepEqual(values, [45]);
        return { rows: [{ has_related_data: 1 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE usuarios SET activo = 0')) {
        assert.deepEqual(values, [45]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE chat_sessions SET revoked_at')) {
        assert.deepEqual(values, [45]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  }));
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async () => ({ id: 92, rol: 'admin_transito' }),
  }));

  const response = await fetch(`${baseUrl}/api/usuarios?id=45`, {
    method: 'DELETE',
    headers: { authorization: '******' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.deactivated, true);
  assert.match(payload.message, /fue desactivado/i);
  assert.equal(statements.some((sql) => sql.includes('DELETE FROM usuarios')), false);
  assert.ok(statements.includes('COMMIT'));
});

test('el usuario sin datos asociados se elimina definitivamente', async (context) => {
  const statements = [];
  context.mock.method(pool, 'connect', async () => ({
    query: async (sql, values = []) => {
      statements.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('SELECT id, rol, zona, activo FROM usuarios')) {
        assert.deepEqual(values, [45]);
        return { rows: [{ id: 45, rol: 'operador', zona: 'Ruta 11', activo: 1 }], rowCount: 1 };
      }
      if (sql.includes('has_related_data')) {
        return { rows: [{ has_related_data: 0 }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM usuarios')) {
        assert.deepEqual(values, [45]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  }));
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async () => ({ id: 92, rol: 'admin_transito' }),
  }));

  const response = await fetch(`${baseUrl}/api/usuarios?id=45`, {
    method: 'DELETE',
    headers: { authorization: '******' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data.deactivated, false);
  assert.match(payload.message, /eliminado/i);
  assert.ok(statements.some((sql) => sql.includes('DELETE FROM usuarios')));
});

test('el dashboard de Tránsito cuenta turnos Playa solo en Ruta 11 y Ruta 86', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /SELECT 'Ruta 11' AS nombre, 1 AS orden/);
    assert.match(sql, /SELECT 'Ruta 86' AS nombre, 2 AS orden/);
    assert.match(sql, /LOWER\(TRIM\(t\.estado\)\) = 'reservado'/);
    assert.match(sql, /t\.aduana_confirmado = FALSE/);
    assert.deepEqual(values, []);
    return {
      rows: [
        { zona_nombre: 'Ruta 11', cantidad: 3 },
        { zona_nombre: 'Ruta 86', cantidad: 2 },
      ],
      rowCount: 2,
    };
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'transito-token'
      ? { id: 92, rol: 'admin_transito' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/transito/dashboard`, {
    headers: { authorization: 'Bearer transito-token' },
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(payload.data, [
    { zona_nombre: 'Ruta 11', cantidad: 3 },
    { zona_nombre: 'Ruta 86', cantidad: 2 },
  ]);
});

test('el admin de Tránsito no puede consultar ni modificar turnos directamente', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('No database query should be needed');
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async () => ({ id: 92, rol: 'admin_transito' }),
  }));

  const [readResponse, updateResponse] = await Promise.all([
    fetch(`${baseUrl}/api/turnos`, {
      headers: { authorization: 'Bearer transito-token' },
    }),
    fetch(`${baseUrl}/api/turnos`, {
      method: 'PUT',
      headers: {
        authorization: 'Bearer transito-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ id: 1, estado: 'finalizado' }),
    }),
  ]);

  assert.equal(readResponse.status, 403);
  assert.equal(updateResponse.status, 403);
  assert.equal(queryCalled, false);
});

test('el admin de Tránsito no puede editar cuentas fuera de sus zonas y roles', async (context) => {
  let updateCalled = false;
  context.mock.method(pool, 'query', async (sql) => {
    if (sql.includes('SELECT id, rol, zona FROM usuarios')) {
      return {
        rows: [{ id: 6, rol: 'operador', zona: 'Ruta 6' }],
        rowCount: 1,
      };
    }
    updateCalled = true;
    throw new Error('No user outside the scope should be updated');
  });
  const baseUrl = await startApp(context, (app) => registerAccountRoutes(app, {
    authenticate: async () => ({ id: 92, rol: 'admin_transito' }),
  }));

  const response = await fetch(`${baseUrl}/api/usuarios`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer transito-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: 6,
      nombre: 'Operador',
      user: 'operador',
      dni: '6',
      rol: 'operador',
      zona: 'Ruta 11',
    }),
  });

  assert.equal(response.status, 403);
  assert.equal(updateCalled, false);
});

test('el dashboard de Tránsito rechaza usuarios de otros roles', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('Unauthorized dashboard query');
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async () => ({ id: 90, rol: 'operador' }),
  }));

  const response = await fetch(`${baseUrl}/api/transito/dashboard`, {
    headers: { authorization: 'Bearer transito-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(queryCalled, false);
});

test('el admin de Aduana obtiene turnos visibles sin limitarse a un destino', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /t\.estado/);
    assert.match(sql, /'pendiente', 'llegando', 'finalizado', 'anulado'/);
    assert.match(
      sql,
      /NOT IN \('pendiente', 'llegando', 'finalizado', 'anulado'\)\)\)\s+ORDER BY/,
    );
    assert.doesNotMatch(sql, /t\.destino_id =/);
    assert.deepEqual(values, []);
    return { rows: [] };
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'aduana-token'
      ? { id: 90, rol: 'admin_aduana' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/turnos`, {
    headers: { authorization: 'Bearer aduana-token' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, []);
});

test('el panel de finalizados consulta solo cierres de Aduana por destino y fechas', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /t\.estado = 'finalizado'/);
    assert.match(sql, /t\.aduana_confirmado = TRUE/);
    assert.doesNotMatch(sql, /LATERAL/);
    assert.match(sql, /h\.estado = 'finalizado'/);
    assert.doesNotMatch(sql, /h\.origen = 'aduana'/);
    assert.match(sql, /t\.destino_id = \$1/);
    assert.match(sql, /COALESCE\(\(SELECT MAX\(h\.registrado_en\)/);
    assert.match(sql, /TIMESTAMP\(t\.fecha_ingreso, t\.hora_ingreso\)\) >= \$2/);
    assert.match(sql, /TIMESTAMP\(t\.fecha_ingreso, t\.hora_ingreso\)\) < DATE_ADD\(\$3, INTERVAL 1 DAY\)/);
    assert.deepEqual(values, [9, '2026-10-01', '2026-10-20']);
    return {
      rows: [{
        id: 12,
        estado: 'finalizado',
        destino_id: 9,
        destino_nombre: 'Aduana Falcon',
        aduana_finalizado_en: '2026-10-13T10:30:00.000Z',
      }],
    };
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'aduana-token'
      ? { id: 90, rol: 'admin_aduana' }
      : null,
  }));

  const response = await fetch(
    `${baseUrl}/api/aduana/finalizados?destino_id=9&desde=2026-10-01&hasta=2026-10-20`,
    { headers: { authorization: 'Bearer aduana-token' } },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data[0].destino_nombre, 'Aduana Falcon');
  assert.equal(payload.data[0].aduana_finalizado_en, '2026-10-13T10:30:00.000Z');
});

test('el panel de finalizados solo admite admin de Aduana', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('No database query should be needed');
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async () => ({ id: 91, rol: 'admin_defiba' }),
  }));

  const response = await fetch(`${baseUrl}/api/aduana/finalizados`, {
    headers: { authorization: 'Bearer defiba-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(queryCalled, false);
});

test('el dashboard Defiba incluye todos los estados y filtra destino y fechas', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /LOWER\(TRIM\(COALESCE\(t\.origen, ''\)\)\) = 'defiba'/);
    assert.match(sql, /t\.destino_id = \$1/);
    assert.match(sql, /t\.fecha_ingreso >= \$2/);
    assert.match(sql, /t\.fecha_ingreso < DATE_ADD\(\$3, INTERVAL 1 DAY\)/);
    assert.doesNotMatch(sql, /t\.estado =/);
    assert.deepEqual(values, [8, '2026-10-01', '2026-10-20']);
    return {
      rows: [{
        id: 15,
        estado: 'en_curso',
        origen: 'defiba',
        zona_nombre: 'Defiba',
        destino_id: 8,
        destino_nombre: 'Destino Norte',
      }],
    };
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'defiba-token'
      ? { id: 91, rol: 'admin_defiba' }
      : null,
  }));

  const response = await fetch(
    `${baseUrl}/api/defiba/ingresos?destino_id=8&desde=2026-10-01&hasta=2026-10-20`,
    { headers: { authorization: 'Bearer defiba-token' } },
  );
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.data[0].destino_nombre, 'Destino Norte');
});

test('el dashboard Defiba rechaza roles de otras áreas', async (context) => {
  let queryCalled = false;
  context.mock.method(pool, 'query', async () => {
    queryCalled = true;
    throw new Error('No database query should be needed');
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async () => ({ id: 90, rol: 'admin_aduana' }),
  }));

  const response = await fetch(`${baseUrl}/api/defiba/ingresos`, {
    headers: { authorization: 'Bearer aduana-token' },
  });

  assert.equal(response.status, 403);
  assert.equal(queryCalled, false);
});

test('el admin de Defiba solo recibe turnos del flujo Defiba', async (context) => {
  context.mock.method(pool, 'query', async (sql, values = []) => {
    assert.match(sql, /LOWER\(TRIM\(COALESCE\(t\.origen, ''\)\)\) = 'defiba'/);
    assert.deepEqual(values, []);
    return { rows: [] };
  });
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'defiba-token'
      ? { id: 91, rol: 'admin_defiba' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/turnos`, {
    headers: { authorization: 'Bearer defiba-token' },
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, []);
});

test('el admin de Aduana puede gestionar turnos de ambos destinos', async (context) => {
  let historyValues;
  const client = {
    async query(sql, values = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT u.rol, u.destino_id')) {
        return {
          rows: [{
            rol: 'admin_aduana',
            usuario_destino_id: null,
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
        historyValues = values;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  context.mock.method(pool, 'connect', async () => client);
  const baseUrl = await startApp(context, (app) => registerTurnoRoutes(app, {
    authenticate: async (token) => token === 'aduana-token'
      ? { id: 90, rol: 'admin_aduana' }
      : null,
  }));

  const response = await fetch(`${baseUrl}/api/turnos`, {
    method: 'PUT',
    headers: {
      authorization: 'Bearer aduana-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      accion: 'quitar_solicitud_aduana',
      turno_id: 44,
      usuario_id: 999,
    }),
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(historyValues[4], 90);
  assert.match(payload.message, /quitado de la lista/i);
});
