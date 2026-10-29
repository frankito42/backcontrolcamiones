const platePattern = /^[A-Z0-9]{4,10}$/;

export function createBocinaPoller(database, {
  serviceUrl = process.env.LLAMADOR_SERVICE_URL || 'http://127.0.0.1:8000/llamar',
  fetchImpl = fetch,
  logger = console,
  intervalMs = 2_000,
} = {}) {
  const inFlight = new Set();
  const retryAfter = new Map();
  let polling = false;

  async function announce(row) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || inFlight.has(id) || (retryAfter.get(id) || 0) > Date.now()) return;
    inFlight.add(id);
    try {
      const number = Number(row.numero);
      const plate = String(row.patente || '').trim().toUpperCase().replace(/[-\s]/g, '');
      if (!Number.isSafeInteger(number) || number <= 0 || !platePattern.test(plate)) {
        await database.query(
          `UPDATE turnos SET bocina_pendiente=FALSE, bocina_pendiente_en=NULL,
             bocina_procesando=FALSE, bocina_reclamada_en=NULL WHERE id=$1`, [id],
        );
        return;
      }

      const claim = await database.query(
        `UPDATE turnos SET bocina_procesando=TRUE, bocina_reclamada_en=CURRENT_TIMESTAMP
         WHERE id=$1 AND bocina_pendiente=TRUE AND bocina_procesando=FALSE`, [id],
      );
      if (!claim.rowCount) return;

      const response = await fetchImpl(serviceUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ numero: number, patente: plate }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        throw new Error(`Servicio de audio respondió HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`);
      }
      await database.query(
        `UPDATE turnos SET bocina_pendiente=FALSE, bocina_pendiente_en=NULL,
           bocina_procesando=FALSE, bocina_reclamada_en=NULL WHERE id=$1`, [id],
      );
      retryAfter.delete(id);
      logger.info(`[bocina] Turno ${number} | ${plate} anunciado.`);
    } catch (error) {
      retryAfter.set(id, Date.now() + 10_000);
      await database.query(
        `UPDATE turnos SET bocina_procesando=FALSE, bocina_reclamada_en=NULL
         WHERE id=$1 AND bocina_pendiente=TRUE`, [id],
      ).catch((releaseError) => logger.error('[bocina] No se pudo liberar el reclamo:', releaseError.message));
      logger.error(`[bocina] No se pudo anunciar turno ${id}:`, error.message);
    } finally {
      inFlight.delete(id);
    }
  }

  async function pollOnce() {
    if (polling) return;
    polling = true;
    try {
      await database.query(
        `UPDATE turnos SET bocina_procesando=FALSE, bocina_reclamada_en=NULL
         WHERE bocina_procesando=TRUE
           AND (bocina_reclamada_en IS NULL OR bocina_reclamada_en < DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE))`,
      );
      const result = await database.query(
        `SELECT id, numero, patente FROM turnos
         WHERE bocina_pendiente=TRUE AND bocina_procesando=FALSE AND aduana_confirmado=TRUE
           AND estado NOT IN ('finalizado','anulado')
         ORDER BY bocina_pendiente_en IS NULL, bocina_pendiente_en ASC, id ASC LIMIT 20`,
      );
      await Promise.all(result.rows.map(announce));
    } catch (error) {
      logger.error('[bocina] Error consultando la cola:', error.message);
    } finally {
      polling = false;
    }
  }

  return { pollOnce };
}

export function startBocinaPoller(database, options) {
  if (process.env.BOCINA_POLL_ENABLED === 'false') return () => {};
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_DATABASE) {
    console.warn('[bocina] Polling deshabilitado: falta configurar MySQL.');
    return () => {};
  }
  const poller = createBocinaPoller(database, options);
  const timer = setInterval(() => void poller.pollOnce(), options?.intervalMs || 2_000);
  timer.unref();
  void poller.pollOnce();
  return () => clearInterval(timer);
}