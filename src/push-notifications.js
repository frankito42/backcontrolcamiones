import crypto from 'node:crypto';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { pool } from './db.js';
import { authenticateChatToken } from './chat-auth.js';
import { fail, respond } from './helpers.js';

const firebaseAppName = 'control-rutas-camiones-push';
const maxDeviceTokenLength = 700;

export function parseFirebaseServiceAccountJson(value) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(value);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no contiene JSON válido.');
  }
  if (
    !serviceAccount
    || typeof serviceAccount !== 'object'
    || typeof serviceAccount.project_id !== 'string'
    || typeof serviceAccount.client_email !== 'string'
    || typeof serviceAccount.private_key !== 'string'
  ) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON debe incluir project_id, client_email y private_key.',
    );
  }
  return serviceAccount;
}

function bearerToken(req) {
  const authorization = req.headers.authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

function getFirebaseMessaging() {
  const existingApp = getApps().find((app) => app.name === firebaseAppName);
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim()) {
    credential = cert(
      parseFirebaseServiceAccountJson(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    );
  } else {
    credential = applicationDefault();
  }
  const app = existingApp || initializeApp({
    credential,
    ...(process.env.FIREBASE_PROJECT_ID
      ? { projectId: process.env.FIREBASE_PROJECT_ID }
      : {}),
  }, firebaseAppName);
  return getMessaging(app);
}

export async function ensurePushNotificationSchema(database = pool) {
  await database.query(`
    CREATE TABLE IF NOT EXISTS push_notification_devices (
      token VARCHAR(700) PRIMARY KEY,
      usuario_id INT NOT NULL,
      session_token_hash CHAR(64) NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_push_notification_devices_user (usuario_id, session_token_hash),
      CONSTRAINT fk_push_notification_devices_usuario FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_push_notification_devices_session FOREIGN KEY (session_token_hash)
        REFERENCES chat_sessions(token_hash) ON DELETE CASCADE ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ALTER TABLE push_notification_devices
      ADD COLUMN IF NOT EXISTS session_token_hash CHAR(64) NULL
  `);
  const index = await database.query(
    `SELECT 1 FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'push_notification_devices'
       AND index_name = 'idx_push_notification_devices_user' LIMIT 1`,
  );
  if (!index.rowCount) {
    await database.query(
      'CREATE INDEX idx_push_notification_devices_user ON push_notification_devices (usuario_id, session_token_hash)',
    );
  }
}

export function registerPushNotificationRoutes(app, {
  database = pool,
  authenticate = authenticateChatToken,
} = {}) {
  app.post('/api/notifications/device/register', async (req, res, next) => {
    try {
      const sessionToken = bearerToken(req);
      const user = await authenticate(sessionToken);
      if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      const role = String(user.rol).trim().toLowerCase();
      if (!['operador', 'defiba'].includes(role)) {
        return fail(res, 'Las notificaciones de pedidos están disponibles solo para operadores y Defiba.', 403);
      }
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (token.length < 20 || token.length > maxDeviceTokenLength) {
        return fail(res, 'El token del dispositivo no es válido.', 422);
      }
      await database.query(
        `INSERT INTO push_notification_devices
           (token, usuario_id, session_token_hash, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
             usuario_id = VALUES(usuario_id),
             session_token_hash = VALUES(session_token_hash),
             updated_at = CURRENT_TIMESTAMP`,
        [
          token,
          user.id,
          crypto.createHash('sha256').update(sessionToken).digest('hex'),
        ],
      );
      return respond(res, true, 'Dispositivo registrado para notificaciones.');
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/notifications/device/unregister', async (req, res, next) => {
    try {
      const user = await authenticate(bearerToken(req));
      if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
      if (token.length < 20 || token.length > maxDeviceTokenLength) {
        return fail(res, 'El token del dispositivo no es válido.', 422);
      }
      await database.query(
        'DELETE FROM push_notification_devices WHERE token = $1',
        [token],
      );
      return respond(res, true, 'Dispositivo quitado de las notificaciones.');
    } catch (error) {
      return next(error);
    }
  });
}

export function createAduanaPushNotifier(database = pool, {
  getMessaging: resolveMessaging = getFirebaseMessaging,
  logger = console,
} = {}) {
  return async function sendAduanaRequestPush(turns) {
    if (!turns.length) return;

    const messaging = resolveMessaging();
    const groups = new Map();
    for (const turn of turns) {
      const zoneId = Number(turn.zona_id);
      if (!Number.isSafeInteger(zoneId) || zoneId <= 0) continue;
      const isDefiba = String(turn.origen || '').trim().toLowerCase() === 'defiba'
        || String(turn.zona_nombre || '').trim().toLowerCase() === 'defiba';
      const key = `${zoneId}:${isDefiba}`;
      const group = groups.get(key) || { zoneId, isDefiba, turns: [] };
      group.turns.push(turn);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const devices = await database.query(
        `SELECT d.token FROM push_notification_devices d
         INNER JOIN usuarios u ON u.id = d.usuario_id
         INNER JOIN chat_sessions s ON s.token_hash = d.session_token_hash
         WHERE u.activo = 1 AND s.revoked_at IS NULL
           AND s.expires_at > CURRENT_TIMESTAMP
           AND (
             (LOWER(TRIM(u.rol)) = 'operador' AND EXISTS (
               SELECT 1 FROM zonas z
               WHERE z.id = $1
                 AND LOWER(TRIM(z.nombre)) = LOWER(TRIM(u.zona))
             ))
             OR (LOWER(TRIM(u.rol)) = 'defiba' AND $2 = TRUE)
           )`,
        [group.zoneId, group.isDefiba],
      );
      const tokens = devices.rows.map((row) => row.token);
      if (!tokens.length) continue;

      const first = group.turns[0];
      const number = first.numero == null ? '' : ` #${first.numero}`;
      const plate = first.patente ? ` (${first.patente})` : '';
      const body = group.turns.length === 1
        ? `Aduana solicitó el camión${number}${plate}.`
        : `Aduana solicitó ${group.turns.length} camiones.`;

      for (let offset = 0; offset < tokens.length; offset += 500) {
        const batch = tokens.slice(offset, offset + 500);
        const response = await messaging.sendEachForMulticast({
          tokens: batch,
          notification: {
            title: 'Nuevo pedido de Aduana',
            body,
          },
          data: {
            tipo: 'pedido_aduana',
            turno_ids: group.turns.map((turn) => String(turn.id)).join(','),
          },
          android: {
            priority: 'high',
            notification: {
              channelId: 'aduana_requests',
              sound: 'default',
            },
          },
        });
        const invalidTokens = response.responses.flatMap((result, index) => (
          result.error && [
            'messaging/invalid-registration-token',
            'messaging/registration-token-not-registered',
          ].includes(result.error.code)
            ? [batch[index]]
            : []
        ));
        if (invalidTokens.length) {
          const placeholders = invalidTokens.map((_, index) => `$${index + 1}`).join(', ');
          await database.query(
            `DELETE FROM push_notification_devices WHERE token IN (${placeholders})`,
            invalidTokens,
          );
        }
        if (response.failureCount) {
          logger.error(
            `[push] ${response.failureCount} de ${batch.length} notificación(es) no se pudieron enviar.`,
          );
        }
      }
    }
  };
}

export const sendAduanaRequestPush = createAduanaPushNotifier(pool);
