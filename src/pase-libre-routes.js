import { pool } from './db.js';
import { emitPaseLibreChanged } from './realtime.js';
import { fail, positiveInt, respond } from './helpers.js';
import { authenticateChatToken } from './chat-auth.js';

export async function ensurePaseLibreSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pase_libre_destinos (
      destino_id INTEGER PRIMARY KEY REFERENCES destinos(id) ON DELETE CASCADE ON UPDATE CASCADE,
      activo BOOLEAN NOT NULL DEFAULT FALSE,
      actualizado_por INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
      actualizado_en TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

export function registerPaseLibreRoutes(app, { authenticate = authenticateChatToken } = {}) {
  app.get('/api/pase-libre', async (req, res, next) => {
    try {
      const token = bearerToken(req);
      const requester = token ? await authenticate(token) : null;
      if (token && !requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      if (requester?.rol === 'admin_defiba') {
        return fail(res, 'No tienes permiso para consultar Pase Libre.', 403);
      }
      const destinoId = positiveInt(req.query.destino_id);
      const result = destinoId
        ? await pool.query(
          'SELECT activo, actualizado_en FROM pase_libre_destinos WHERE destino_id = $1',
          [destinoId],
        )
        : await pool.query(
          `SELECT d.nombre
           FROM pase_libre_destinos p
           INNER JOIN destinos d ON d.id = p.destino_id
           WHERE p.activo = TRUE
           ORDER BY LOWER(d.nombre), d.id`,
        );
      if (!destinoId) {
        const destinos = result.rows.map((row) => row.nombre);
        return respond(res, true, 'Destinos con Pase Libre activo.', {
          activo: destinos.length > 0,
          destinos,
        });
      }
      const row = result.rows[0] || { activo: false, actualizado_en: null };
      return respond(res, true, 'Estado de Pase Libre.', {
        activo: row.activo === true,
        actualizado_en: row.actualizado_en,
        ...(destinoId ? { destino_id: destinoId } : {}),
      });
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/pase-libre', async (req, res, next) => {
    try {
      const token = bearerToken(req);
      const requester = token ? await authenticate(token) : null;
      if (token && !requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      if (requester?.rol === 'admin_defiba') {
        return fail(res, 'No tienes permiso para modificar Pase Libre.', 403);
      }
      if (requester?.rol === 'admin_transito') {
        return fail(res, 'El administrador de Tránsito solo puede consultar el dashboard.', 403);
      }
      if (typeof req.body.activo !== 'boolean') {
        return fail(res, 'El estado activo es obligatorio.', 422);
      }
      const destinoId = positiveInt(req.body.destino_id);
      if (!destinoId) return fail(res, 'El destino es obligatorio.', 422);
      const usuarioId = requester?.rol === 'admin_aduana'
        ? Number(requester.id)
        : positiveInt(req.body.usuario_id) || null;
      if (!usuarioId) return fail(res, 'El usuario es obligatorio.', 422);
      const destination = await pool.query('SELECT id FROM destinos WHERE id = $1', [destinoId]);
      if (!destination.rowCount) return fail(res, 'Destino inválido.', 422);
      const user = await pool.query(
        'SELECT rol, destino_id FROM usuarios WHERE id = $1',
        [usuarioId],
      );
      const isGlobalAduanaAdmin = requester?.rol === 'admin_aduana';
      if (!user.rowCount || (!isGlobalAduanaAdmin &&
          (String(user.rows[0].rol).trim().toLowerCase() !== 'aduana' ||
            Number(user.rows[0].destino_id) !== destinoId))) {
        return fail(res, 'Solo Aduana puede modificar Pase Libre para su destino asignado.', 403);
      }
      const result = await pool.query(
        `INSERT INTO pase_libre_destinos (destino_id, activo, actualizado_por, actualizado_en)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (destino_id) DO UPDATE
         SET activo = EXCLUDED.activo, actualizado_por = EXCLUDED.actualizado_por,
             actualizado_en = CURRENT_TIMESTAMP
         RETURNING activo, actualizado_en`,
        [destinoId, req.body.activo, usuarioId],
      );
      const state = {
        activo: result.rows[0].activo === true,
        actualizado_en: result.rows[0].actualizado_en,
        destino_id: destinoId,
      };
      emitPaseLibreChanged(state.activo, destinoId);
      return respond(res, true, 'Estado de Pase Libre actualizado.', state);
    } catch (error) {
      return next(error);
    }
  });
}