import test from 'node:test';
import assert from 'node:assert/strict';
import { createBocinaPoller } from '../src/bocina-poller.js';

test('el poller Node reclama, anuncia y limpia una bocina pendiente', async () => {
  const statements = [];
  const database = {
    async query(sql, values = []) {
      statements.push({ sql, values });
      if (sql.includes('SELECT id, numero, patente')) {
        return { rows: [{ id: 18, numero: 42, patente: 'ab-123 cd' }] };
      }
      return { rowCount: 1, rows: [] };
    },
  };
  const calls = [];
  const poller = createBocinaPoller(database, {
    fetchImpl: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
    logger: { info() {}, error() {} },
  });

  await poller.pollOnce();

  assert.deepEqual(calls, [{
    url: 'http://127.0.0.1:8000/llamar',
    body: { numero: 42, patente: 'AB123CD' },
  }]);
  assert.equal(statements.filter(({ sql }) => sql.includes('SET bocina_procesando=TRUE')).length, 1);
  assert.equal(statements.filter(({ sql }) => sql.includes('bocina_pendiente=FALSE')).length, 1);
});