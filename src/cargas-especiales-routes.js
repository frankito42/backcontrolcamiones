import { pool } from './db.js';
import { emitCargasEspecialesChanged } from './realtime.js';
import { fail, positiveInt, respond } from './helpers.js';
import { authenticateChatToken } from './chat-auth.js';

const zonaCargasEspeciales = 'cargas especiales';

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function scopedAdmin(req) {
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) return null;
  const user = await authenticateChatToken(authorization.slice(7).trim());
  if (!user) return false;
  return ['admin_aduana', 'admin_defiba', 'admin_transito'].includes(user.rol)
    ? user
    : null;
}

export async function ensureCargasEspecialesSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cargas_especiales (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      patente VARCHAR(20) NOT NULL,
      zona_id INT NOT NULL,
      destino_id INT NOT NULL,
      estado VARCHAR(20) NOT NULL DEFAULT 'en_camino'
        CHECK (estado IN ('en_camino', 'finalizado')),
      usuario_id INT NULL,
      creada_en DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_cargas_especiales_zona_estado_fecha (zona_id, estado, creada_en),
      CONSTRAINT fk_cargas_especiales_zona FOREIGN KEY (zona_id)
        REFERENCES zonas(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT fk_cargas_especiales_destino FOREIGN KEY (destino_id)
        REFERENCES destinos(id) ON DELETE RESTRICT ON UPDATE CASCADE,
      CONSTRAINT fk_cargas_especiales_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id) ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

export function registerCargasEspecialesRoutes(app) {
  app.get('/api/cargas-especiales', async (req, res, next) => {
    try {
      const admin = await scopedAdmin(req);
      if (admin === false) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      if (admin && admin.rol !== 'admin_aduana') {
        return fail(res, 'No tienes permiso para consultar cargas de Aduana.', 403);
      }
      const destinoId = positiveInt(req.query.destino_id);
      const destinoFilter = !admin && destinoId ? 'AND ce.destino_id = $2' : '';
      const values = !admin && destinoId
        ? [zonaCargasEspeciales, destinoId]
        : [zonaCargasEspeciales];
      const result = await pool.query(
        `SELECT ce.id, ce.patente, ce.zona_id, z.nombre AS zona_nombre,
                ce.destino_id, d.nombre AS destino_nombre, ce.estado,
                ce.usuario_id, ce.creada_en
         FROM cargas_especiales ce
         INNER JOIN zonas z ON z.id = ce.zona_id
         INNER JOIN destinos d ON d.id = ce.destino_id
         WHERE LOWER(TRIM(z.nombre)) = $1 AND ce.estado = 'en_camino'
           ${destinoFilter}
         ORDER BY ce.creada_en ASC, ce.id ASC`,
        values,
      );
      return respond(res, true, 'Cargas especiales en camino.', result.rows);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/cargas-especiales', async (req, res, next) => {
    try {
      const admin = await scopedAdmin(req);
      if (admin === false) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      if (admin) return fail(res, 'No tienes permiso para crear cargas especiales.', 403);
      const patente = clean(req.body.patente).toUpperCase();
      const destinoId = positiveInt(req.body.destino_id);
      const usuarioId = positiveInt(req.body.usuario_id) || null;
      if (!patente || patente.length > 20 || !destinoId) {
        return fail(res, 'La patente y el destino son obligatorios.', 422);
      }

      const zone = await pool.query(
        'SELECT id FROM zonas WHERE LOWER(TRIM(nombre)) = $1 LIMIT 1',
        [zonaCargasEspeciales],
      );
      if (!zone.rowCount) {
        return fail(res, 'No existe la zona Cargas Especiales.', 409);
      }

      const destination = await pool.query(
        'SELECT id FROM destinos WHERE id = $1',
        [destinoId],
      );
      if (!destination.rowCount) return fail(res, 'Destino inválido.', 422);

      const result = await pool.query(
        `INSERT INTO cargas_especiales (patente, zona_id, destino_id, estado, usuario_id)
         VALUES ($1, $2, $3, 'en_camino', $4)`,
        [patente, Number(zone.rows[0].id), destinoId, usuarioId],
      );
      const saved = await pool.query(
        `SELECT id, patente, zona_id, destino_id, estado, usuario_id, creada_en
         FROM cargas_especiales WHERE id = $1`,
        [result.insertId],
      );
      emitCargasEspecialesChanged();
      return respond(res, true, 'Carga especial agregada en camino.', saved.rows[0], 201);
    } catch (error) {
      return next(error);
    }
  });

  app.put('/api/cargas-especiales/:id/finalizar', async (req, res, next) => {
    try {
      const admin = await scopedAdmin(req);
      if (admin === false) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      if (admin && admin.rol !== 'admin_aduana') {
        return fail(res, 'No tienes permiso para finalizar cargas de Aduana.', 403);
      }
      const id = positiveInt(req.params.id);
      if (!id) return fail(res, 'Carga especial inválida.', 422);

      const result = await pool.query(
        `UPDATE cargas_especiales SET estado = 'finalizado'
         WHERE id = $1 AND estado = 'en_camino'`,
        [id],
      );
      if (!result.rowCount) return fail(res, 'La carga ya no está en camino.', 404);
      const updated = await pool.query('SELECT id, estado FROM cargas_especiales WHERE id = $1', [id]);

      emitCargasEspecialesChanged();
      return respond(res, true, 'Carga especial finalizada.', updated.rows[0]);
    } catch (error) {
      return next(error);
    }
  });
}