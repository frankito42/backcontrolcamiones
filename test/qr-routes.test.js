import test from 'node:test';
import assert from 'node:assert/strict';
import { claimQrToken } from '../src/qr-routes.js';

test('el primer escaneo reclama el token y un segundo escaneo recibe conflicto', async () => {
  const now = 1_800_000_000;
  let alreadyClaimed = false;
  const database = {
    async query(sql) {
      if (sql.includes('UPDATE qr_tokens')) {
        if (alreadyClaimed) return { rowCount: 0, rows: [] };
        alreadyClaimed = true;
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('SELECT zona_id FROM qr_tokens')) {
        return { rowCount: 1, rows: [{ zona_id: 7 }] };
      }
      return {
        rowCount: 1,
        rows: [{ zona_id: 7, expires_at: now + 300, claimed_at: new Date(), used: false }],
      };
    },
  };

  assert.deepEqual(await claimQrToken('token-1', database, now), { zoneId: 7 });
  assert.deepEqual(await claimQrToken('token-1', database, now), {
    error: 'Este QR ya fue escaneado. Usa el nuevo QR de la pantalla.',
    status: 409,
  });
});

test('un token vencido no puede reclamarse', async () => {
  const now = 1_800_000_000;
  const database = {
    async query(sql) {
      if (sql.includes('UPDATE qr_tokens')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ zona_id: 7, expires_at: now - 1, claimed_at: null, used: false }] };
    },
  };

  assert.deepEqual(await claimQrToken('expired', database, now), {
    error: 'Este QR expiró.',
    status: 410,
  });
});
