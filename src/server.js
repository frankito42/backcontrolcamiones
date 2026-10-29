import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBocinaPoller } from './bocina-poller.js';
import { corsOriginCallback } from './cors-config.js';
import { ensureCargasEspecialesSchema } from './cargas-especiales-routes.js';
import { ensureUsuarioSchema } from './account-routes.js';
import { ensurePaseLibreSchema } from './pase-libre-routes.js';
import { pool } from './db.js';
import { ensureChatSchema } from './chat-auth.js';
import { logError } from './helpers.js';
import { attachRealtime } from './realtime.js';
import { registerRoutes } from './routes.js';
import { ensureTurnoSchema } from './turno-routes.js';
import { ensurePushNotificationSchema } from './push-notifications.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const nodeLogosDir = path.resolve(currentDir, '../uploads/logos');
const nodeFondosDir = path.resolve(currentDir, '../uploads/fondos');
const legacyLogosDir = path.resolve(currentDir, '../../backend/uploads/logos');
const legacyFondosDir = path.resolve(currentDir, '../../backend/uploads/fondos');
const app = express();

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(cors({
  origin: corsOriginCallback,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ success: true, service: 'control-rutas-camiones-api', database: 'mysql' });
  } catch (error) {
    logError(error);
    res.status(503).json({ success: false, service: 'control-rutas-camiones-api', database: 'unavailable' });
  }
});

registerRoutes(app);
app.use('/uploads/logos', express.static(nodeLogosDir));
app.use('/uploads/fondos', express.static(nodeFondosDir));
app.use('/controlRutasCamiones/backend/uploads/logos', express.static(legacyLogosDir));
app.use('/controlRutasCamiones/backend/uploads/fondos', express.static(legacyFondosDir));

async function normalizeDefibaTurns() {
  try {
    const result = await pool.query(
      `UPDATE turnos t
       INNER JOIN zonas z ON z.id = t.zona_id
       SET t.origen = 'defiba', t.numero = NULL
       WHERE LOWER(BTRIM(z.nombre)) = 'defiba'
         AND (LOWER(BTRIM(COALESCE(t.origen, ''))) <> 'defiba' OR t.numero IS NOT NULL)`,
    );
    if (result.rowCount) console.log(`[defiba] ${result.rowCount} turno(s) normalizados.`);
  } catch (error) {
    logError(error);
  }
}

app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Ruta no encontrada.', data: null });
});

app.use((error, _req, res, _next) => {
  logError(error);
  if (res.headersSent) return;
  res.status(500).json({ success: false, message: 'Error interno del servidor.', data: null });
});

async function startServer() {
  await normalizeDefibaTurns();
  await ensureChatSchema();
  await ensureCargasEspecialesSchema();
  await ensureUsuarioSchema();
  await ensurePaseLibreSchema();
  await ensureTurnoSchema();
  await ensurePushNotificationSchema();

  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer(app);
  const realtime = attachRealtime(server);
  server.listen(port, host, () => {
    console.log(`Control Rutas Camiones Node API en http://${host}:${port}`);
  });

  const stopBocinaPoller = startBocinaPoller(pool);
  async function shutdown() {
    stopBocinaPoller();
    realtime.close(async () => {
      await pool.end();
      process.exit(0);
    });
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startServer().catch(async (error) => {
  logError(error);
  console.error('No se pudo iniciar el backend.');
  await pool.end();
  process.exitCode = 1;
});