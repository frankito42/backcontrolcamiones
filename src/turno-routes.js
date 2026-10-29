import crypto from 'node:crypto';
import { pool, withTransaction } from './db.js';
import { fail, methodNotAllowed, positiveInt, respond } from './helpers.js';
import {
  emitAduanaTurnosChanged,
  emitDefibaTurnosChanged,
  emitTurnosChanged,
} from './realtime.js';
import { sendAduanaRequestPush } from './push-notifications.js';
import { authenticateChatToken } from './chat-auth.js';

const activeStates = ['reservado', 'pendiente', 'en_curso'];
const validStates = ['reservado', 'pendiente', 'en_curso', 'listo_para_salir', 'finalizado', 'anulado'];
const validPriorities = ['baja', 'media', 'alta'];
const defibaTurnSql = "(LOWER(BTRIM(COALESCE(t.origen, ''))) = 'defiba' OR LOWER(BTRIM(z.nombre)) = 'defiba')";
const turnSelect = `
  SELECT t.id, t.numero, t.origen, t.numero_operacion, t.prioridad, t.zona_id, t.destino_id,
         t.aduana_confirmado, t.aduana_confirmado_en, t.estado_aduana,
         t.defiba_aviso_confirmado, t.operador_aduana_aviso_confirmado,
         t.camionero_id, t.patente, t.empresa, t.mercaderia, t.mercaderia_vacia, t.fecha_ingreso, t.hora_ingreso,
         t.estado, t.usuario_id, t.usuario_pase_id,
         c.nombre AS camionero_nombre, c.dni AS camionero_dni,
         c.patente AS camionero_patente, c.telefono AS camionero_telefono,
         u.nombre AS operador_nombre, u.zona AS operador_zona,
         z.nombre AS zona_nombre, up.nombre AS pase_nombre, up.zona AS pase_zona
  FROM turnos t
  INNER JOIN camioneros c ON c.id = t.camionero_id
  INNER JOIN zonas z ON z.id = t.zona_id
  LEFT JOIN usuarios u ON u.id = t.usuario_id
  LEFT JOIN usuarios up ON up.id = t.usuario_pase_id`;

function isAduanaVisible(turn) {
  const state = String(turn.estado || '').trim().toLowerCase();
  if (['pendiente', 'llegando', 'finalizado', 'anulado'].includes(state)) {
    return false;
  }
  const isDefiba = String(turn.origen || '').trim().toLowerCase() === 'defiba'
    || String(turn.zona_nombre || '').trim().toLowerCase() === 'defiba';
  if (!isDefiba) return true;
  return state === 'listo_para_salir'
    || (state === 'en_curso' && turn.aduana_confirmado === true);
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isDefibaRole(role) {
  return ['defiba', 'admin_defiba'].includes(String(role || '').trim().toLowerCase());
}

function idList(value) {
  return Array.isArray(value) ? value.map((id) => positiveInt(id)).filter(Boolean) : [];
}

function normalizeBooleanRows(rows, fields) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    fields.includes(key) && value !== null ? Boolean(value) : value,
  ])));
}

async function history(client, turnoId, zonaId, estado, usuarioId = null, origen = 'sistema', evento = 'estado') {
  await client.query(
    `INSERT INTO turno_historial (turno_id, zona_id, estado, evento, usuario_id, origen)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [turnoId, zonaId, estado, evento, usuarioId, origen],
  );
}

async function notifyTts(name) {
  if (process.env.TTS_ENABLED !== 'true' || !name) return;
  try {
    await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/sound/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: name }),
      signal: AbortSignal.timeout(2_000),
    });
  } catch (error) {
    console.warn('No se pudo enviar el aviso TTS:', error.message);
  }
}

function whatsappNumber(phone) {
  let number = String(phone || '').trim().replace(/[^0-9+]/g, '');
  if (!number) return null;
  if (!number.startsWith('+')) {
    number = `${process.env.TWILIO_DEFAULT_COUNTRY_CODE || '+54'}${number.replace(/^0+/, '')}`;
  }
  return `whatsapp:${number}`;
}

async function notifyWhatsApp(turno) {
  const { TWILIO_ENABLED, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM } = process.env;
  const to = whatsappNumber(turno.camionero_telefono || turno.telefono);
  if (TWILIO_ENABLED !== 'true' || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_WHATSAPP_FROM || !to) return;
  try {
    const trackingUrl = process.env.TRACKING_BASE_URL || process.env.PUBLIC_BASE_URL;
    if (!trackingUrl) throw new Error('Falta TRACKING_BASE_URL para crear el enlace de seguimiento.');
    const baseUrl = new URL(trackingUrl).origin;
    const url = `${baseUrl}/tracking?zona_id=${turno.zona_id}&numero=${turno.numero}`;
    const body = new URLSearchParams({ From: TWILIO_WHATSAPP_FROM, To: to });
    if (process.env.TWILIO_WHATSAPP_TEMPLATE_SID) {
      const ahead = await pool.query(
        `SELECT COUNT(*)::int AS cantidad FROM turnos
         WHERE estado IN ('pendiente', 'en_curso') AND numero < $1`,
        [turno.numero],
      );
      body.set('ContentSid', process.env.TWILIO_WHATSAPP_TEMPLATE_SID);
      body.set('ContentVariables', JSON.stringify({ '1': turno.numero, '2': ahead.rows[0].cantidad, '3': url }));
    } else {
      body.set('Body', `Turno número ${turno.numero} confirmado.\nSeguí tu turno acá: ${url}`);
    }
    const credentials = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { authorization: `Basic ${credentials}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) console.error('Twilio respondió', response.status, await response.text());
  } catch (error) {
    console.error('No se pudo enviar WhatsApp:', error.message);
  }
}

async function listTurns(req, res) {
  const conditions = [];
  const values = [];
  const add = (sql, value) => {
    values.push(value);
    conditions.push(sql.replace('?', `$${values.length}`));
  };
  if (clean(req.query.estado)) {
    if (req.query.estado === 'reservado' && req.query.incluir_listo_para_salir === '1') {
      conditions.push("(t.estado = 'reservado' OR t.estado = 'listo_para_salir')");
    } else {
      add('t.estado = ?', clean(req.query.estado));
      if (req.query.estado === 'reservado') conditions.push('t.aduana_confirmado = FALSE');
    }
  }
  if (positiveInt(req.query.zona_id)) add('t.zona_id = ?', positiveInt(req.query.zona_id));
  if (clean(req.query.zona)) {
    add('LOWER(BTRIM(z.nombre)) = ?', clean(req.query.zona).toLowerCase());
  }
  if (req.query.aduana_confirmado === '1') {
    conditions.push("t.aduana_confirmado = TRUE AND t.estado NOT IN ('finalizado', 'anulado')");
  }
  if (positiveInt(req.query.destino_id)) {
    add('t.destino_id = ?', positiveInt(req.query.destino_id));
  }
  const origin = clean(req.query.origen).toLowerCase();
  if (origin === 'defiba') {
    conditions.push("(LOWER(BTRIM(t.origen)) = 'defiba' OR LOWER(BTRIM(z.nombre)) = 'defiba')");
  } else if (origin) {
    add('LOWER(BTRIM(t.origen)) = ?', origin);
  }
  if (req.query.aduana_visible === '1') {
    conditions.push(
      `((${defibaTurnSql} AND (t.estado = 'listo_para_salir' OR (t.estado = 'en_curso' AND t.aduana_confirmado = TRUE)))
        OR (NOT ${defibaTurnSql} AND LOWER(BTRIM(t.estado)) NOT IN ('pendiente', 'llegando', 'finalizado', 'anulado')))`,
    );
  }
  if (req.scopedAdmin?.rol === 'admin_aduana') {
    conditions.push(
      `((${defibaTurnSql} AND (t.estado = 'listo_para_salir'
          OR (t.estado = 'en_curso' AND t.aduana_confirmado = TRUE)))
        OR (NOT ${defibaTurnSql}
          AND LOWER(BTRIM(t.estado)) NOT IN ('pendiente', 'llegando', 'finalizado', 'anulado')))`,
    );
  }
  if (req.scopedAdmin?.rol === 'admin_defiba') {
    conditions.push(`(${defibaTurnSql})`);
  }
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(`${turnSelect}${where} ORDER BY t.fecha_ingreso ASC, t.hora_ingreso ASC`, values);
  return respond(res, true, 'Listado de turnos.', normalizeBooleanRows(result.rows, [
    'aduana_confirmado', 'defiba_aviso_confirmado', 'operador_aduana_aviso_confirmado', 'mercaderia_vacia',
  ]));
}

async function createTurn(req, res) {
  const body = req.body;
  const userId = positiveInt(body.usuario_id) || null;
  let driverId = positiveInt(body.camionero_id);
  let zoneId = positiveInt(body.zona_id);
  const destinationId = positiveInt(body.destino_id) || null;
  const company = clean(body.empresa);
  const merchandiseEmpty = body.mercaderia_vacia === true;
  const merchandise = merchandiseEmpty ? '' : clean(body.mercaderia);
  let plate = clean(body.patente).toUpperCase();
  let phone = clean(body.telefono);
  const priority = clean(body.prioridad).toLowerCase() || null;

  const user = userId
    ? await pool.query('SELECT rol, zona FROM usuarios WHERE id = $1', [userId])
    : { rows: [] };
  const isDefiba = isDefibaRole(user.rows[0]?.rol);

  try {
    const created = await withTransaction(async (client) => {
      if (!driverId) {
        const name = clean(body.nombre);
        let dni = clean(body.dni);
        if (!plate) throw Object.assign(new Error('El dominio del camión es obligatorio.'), { httpStatus: 422 });
        const driverName = name || 'Pendiente de completar';
        if (!dni) {
          const dniPrefix = isDefiba ? 'DEF' : 'TMP';
          dni = `${dniPrefix}${crypto.createHash('sha256').update(crypto.randomUUID()).digest('hex').slice(0, 17).toUpperCase()}`;
        }
        const existing = await client.query('SELECT id, telefono FROM camioneros WHERE dni = $1 LIMIT 1', [dni]);
        if (existing.rowCount) {
          driverId = existing.rows[0].id;
          phone ||= existing.rows[0].telefono || '';
        } else {
          const inserted = await client.query(
            `INSERT INTO camioneros (nombre, dni, patente, telefono) VALUES ($1, $2, $3, $4) RETURNING id`,
            [driverName, dni, plate, phone || null],
          );
          driverId = inserted.rows[0].id;
        }
      } else {
        const driver = await client.query('SELECT patente, telefono FROM camioneros WHERE id = $1', [driverId]);
        if (!driver.rowCount) throw Object.assign(new Error('El camionero indicado no existe.'), { httpStatus: 404 });
        phone ||= driver.rows[0].telefono || '';
        plate ||= driver.rows[0].patente.toUpperCase();
      }
      if (!plate) throw Object.assign(new Error('La patente del turno es obligatoria.'), { httpStatus: 422 });

      if (!zoneId && user.rows[0]?.zona) {
        const zone = await client.query(
          'SELECT id FROM zonas WHERE LOWER(BTRIM(nombre)) = LOWER(BTRIM($1)) ORDER BY id LIMIT 1',
          [user.rows[0].zona],
        );
        zoneId = zone.rows[0]?.id || 0;
      }
      if (!zoneId && isDefibaRole(user.rows[0]?.rol)) {
        const defibaZone = await client.query(
          "SELECT id FROM zonas WHERE LOWER(BTRIM(nombre)) = 'defiba' ORDER BY id LIMIT 1",
        );
        zoneId = defibaZone.rows[0]?.id || 0;
      }
      if (!zoneId) throw Object.assign(new Error('La zona del turno es obligatoria.'), { httpStatus: 422 });
      const zone = await client.query('SELECT nombre FROM zonas WHERE id = $1', [zoneId]);
      if (!zone.rowCount) {
        throw Object.assign(new Error('Zona inválida.'), { httpStatus: 422 });
      }
      const isDefibaZone = String(zone.rows[0].nombre).trim().toLowerCase() === 'defiba';
      if (!destinationId) throw Object.assign(new Error('El destino del turno es obligatorio.'), { httpStatus: 422 });
      if (destinationId && !(await client.query('SELECT 1 FROM destinos WHERE id = $1', [destinationId])).rowCount) {
        throw Object.assign(new Error('Destino inválido.'), { httpStatus: 422 });
      }
      if (priority && !validPriorities.includes(priority)) throw Object.assign(new Error('Prioridad inválida.'), { httpStatus: 422 });

      const active = await client.query(
        'SELECT id, patente FROM turnos WHERE camionero_id = $1 AND estado = ANY($2::varchar[])',
        [driverId, activeStates],
      );
      const conflicting = active.rows.find((row) => row.patente.toUpperCase() !== plate);
      if (conflicting) {
        throw Object.assign(
          new Error(`El camionero ya tiene un turno activo con la patente ${conflicting.patente}. No puede tener turnos activos con patentes diferentes.`),
          { httpStatus: 409, responseData: { turno_id: conflicting.id, patente: conflicting.patente } },
        );
      }

      const origin = isDefiba || isDefibaZone ? 'defiba' : 'normal';
      const initialState = isDefiba ? 'reservado' : 'pendiente';
      let number = null;
      if (origin !== 'defiba') {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('turnos-global-number'))");
        const latest = await client.query('SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM turnos');
        number = latest.rows[0].numero;
      }
      const result = await client.query(
        `INSERT INTO turnos
          (numero, camionero_id, patente, empresa, mercaderia, mercaderia_vacia, fecha_ingreso, hora_ingreso, estado, origen,
           usuario_id, zona_id, destino_id, prioridad)
         VALUES ($1, $2, $3, $4, $5, $6, CURRENT_DATE, LOCALTIME, $7, $8, $9, $10, $11, $12)
         RETURNING id, numero, fecha_ingreso, hora_ingreso`,
        [number, driverId, plate, company || null, merchandise || null, merchandiseEmpty, initialState, origin, userId, zoneId, destinationId, priority],
      );
      const turn = result.rows[0];
      await history(client, turn.id, zoneId, initialState, userId, 'app');
      return {
        ...turn,
        origin,
        initialState,
        zoneId,
        destinationId,
        priority,
        driverId,
        plate,
        company,
        merchandise,
        merchandiseEmpty,
        phone,
      };
    });

    emitTurnosChanged();
    if (created.origin === 'defiba') {
      emitDefibaTurnosChanged({ turno_id: created.id, zona_id: created.zoneId });
    }
    if (created.origin !== 'defiba') void notifyWhatsApp({ ...created, zona_id: created.zoneId, telefono: created.phone });
    return respond(res, true, `Turno creado en estado ${created.initialState}.`, {
      id: created.id, numero: created.numero, origen: created.origin, zona_id: created.zoneId,
      destino_id: created.destinationId, prioridad: created.priority, camionero_id: created.driverId,
      patente: created.plate, estado: created.initialState, empresa: created.company,
      mercaderia: created.merchandise, mercaderia_vacia: created.merchandiseEmpty,
      fecha_ingreso: created.fecha_ingreso, hora_ingreso: created.hora_ingreso,
    }, 201);
  } catch (error) {
    if (error.httpStatus) return fail(res, error.message, error.httpStatus, error.responseData || null);
    if (error.code === '23505') return fail(res, 'Ya existe un turno con ese número en esta zona.', 409);
    console.error(error);
    return fail(res, 'No se pudo crear el turno.', 500);
  }
}

async function confirmAduana(ids, userId) {
  return withTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE turnos SET aduana_confirmado = TRUE, aduana_confirmado_en = CURRENT_TIMESTAMP,
         estado_aduana = 'solicitando', defiba_aviso_confirmado = FALSE,
         operador_aduana_aviso_confirmado = FALSE
       WHERE id = ANY($1::int[]) AND estado NOT IN ('finalizado', 'anulado')
       RETURNING id, zona_id, estado, numero, patente`,
      [ids],
    );
    let added = 0;
    for (const turn of updated.rows) {
      const existing = await client.query(
        "SELECT 1 FROM turno_historial WHERE turno_id = $1 AND evento = 'lista_aduana' LIMIT 1",
        [turn.id],
      );
      if (!existing.rowCount) {
        await history(client, turn.id, turn.zona_id, turn.estado, userId, 'aduana', 'lista_aduana');
        added += 1;
      }
    }
    const defibaRows = updated.rowCount
      ? await client.query(
        `SELECT t.id FROM turnos t INNER JOIN zonas z ON z.id = t.zona_id
         WHERE t.id = ANY($1::int[])
           AND (LOWER(BTRIM(t.origen)) = 'defiba' OR LOWER(BTRIM(z.nombre)) = 'defiba')`,
        [updated.rows.map((turn) => turn.id)],
      )
      : { rows: [] };
    const notificationTurns = updated.rowCount
      ? await client.query(
        `SELECT t.id, t.zona_id, t.numero, t.patente, t.origen, z.nombre AS zona_nombre
         FROM turnos t INNER JOIN zonas z ON z.id = t.zona_id
         WHERE t.id = ANY($1::int[])`,
        [updated.rows.map((turn) => turn.id)],
      )
      : { rows: [] };
    return {
      count: updated.rowCount,
      turnos: notificationTurns.rows,
      defibaIds: defibaRows.rows.map((turn) => turn.id),
    };
  });
}

async function updateBatchAction(action, ids) {
  const idsSql = '$1::int[]';
  if (action === 'confirmar_aviso_defiba') {
    const result = await pool.query(
      `UPDATE turnos t SET defiba_aviso_confirmado = TRUE,
         estado_aduana = CASE WHEN t.estado_aduana = 'en_camino' THEN 'en_camino' ELSE 'recibido' END
       FROM zonas z WHERE z.id = t.zona_id AND t.id = ANY(${idsSql})
         AND (LOWER(BTRIM(t.origen)) = 'defiba' OR LOWER(BTRIM(z.nombre)) = 'defiba')
         AND t.aduana_confirmado = TRUE`, [ids],
    );
    return ['Pedido de Aduana recibido.', result.rowCount];
  }
  if (action === 'confirmar_aviso_operador_aduana') {
    const result = await pool.query(
      `UPDATE turnos t SET operador_aduana_aviso_confirmado = TRUE,
         estado_aduana = CASE WHEN t.estado_aduana = 'en_camino' THEN 'en_camino' ELSE 'recibido' END
       FROM zonas z WHERE z.id = t.zona_id AND t.id = ANY(${idsSql})
         AND t.aduana_confirmado = TRUE AND LOWER(TRIM(z.nombre)) IN ('ruta 11', 'ruta 86')`, [ids],
    );
    return ['Aviso de Aduana confirmado.', result.rowCount];
  }
  if (action === 'marcar_bocina_aduana') {
    const result = await pool.query(
      `UPDATE turnos SET bocina_pendiente = TRUE, bocina_pendiente_en = CURRENT_TIMESTAMP,
        bocina_procesando = FALSE, bocina_reclamada_en = NULL
       WHERE id = ANY(${idsSql}) AND aduana_confirmado = TRUE
         AND estado NOT IN ('finalizado', 'anulado')`, [ids],
    );
    return ['Bocina registrada para los turnos seleccionados.', result.rowCount];
  }
  return null;
}

async function manageAduanaRequest(action, turnId, userId) {
  return withTransaction(async (client) => {
    const selected = await client.query(
      `SELECT u.rol, u.destino_id AS usuario_destino_id, t.id, t.estado, t.destino_id,
              t.zona_id, t.origen, t.aduana_confirmado, z.nombre AS zona_nombre
       FROM usuarios u
       INNER JOIN turnos t ON t.id = $2
       INNER JOIN zonas z ON z.id = t.zona_id
       WHERE u.id = $1
       FOR UPDATE OF t`,
      [userId, turnId],
    );
    if (!selected.rowCount) {
      throw Object.assign(new Error('No se encontró el turno o el usuario.'), { httpStatus: 404 });
    }

    const turn = selected.rows[0];
    const isGlobalAduanaAdmin = String(turn.rol).trim().toLowerCase() === 'admin_aduana';
    if (!isGlobalAduanaAdmin
      && (String(turn.rol).trim().toLowerCase() !== 'aduana'
        || !turn.usuario_destino_id
        || Number(turn.usuario_destino_id) !== Number(turn.destino_id))) {
      throw Object.assign(new Error('No tienes permiso para modificar este turno.'), { httpStatus: 403 });
    }
    if (!turn.aduana_confirmado) {
      throw Object.assign(new Error('El turno ya no está solicitado por Aduana.'), { httpStatus: 409 });
    }

    if (action === 'quitar_solicitud_aduana') {
      if (['en_curso', 'finalizado', 'anulado'].includes(turn.estado)) {
        throw Object.assign(new Error('No se puede quitar un turno que ya está en curso o finalizado.'), { httpStatus: 409 });
      }
      const result = await client.query(
        `UPDATE turnos
         SET aduana_confirmado = FALSE, aduana_confirmado_en = NULL,
             estado_aduana = NULL, defiba_aviso_confirmado = FALSE,
             operador_aduana_aviso_confirmado = FALSE
         WHERE id = $1 AND aduana_confirmado = TRUE`,
        [turnId],
      );
      if (!result.rowCount) {
        throw Object.assign(new Error('El turno ya no está solicitado por Aduana.'), { httpStatus: 409 });
      }
      await history(
        client,
        turnId,
        turn.zona_id,
        turn.estado,
        userId,
        'aduana',
        'quitar_lista_aduana',
      );
    } else {
      if (['finalizado', 'anulado'].includes(turn.estado)) {
        throw Object.assign(new Error('El turno ya está finalizado o anulado.'), { httpStatus: 409 });
      }
      const result = await client.query(
        `UPDATE turnos SET estado = 'finalizado'
         WHERE id = $1 AND estado NOT IN ('finalizado', 'anulado')`,
        [turnId],
      );
      if (!result.rowCount) {
        throw Object.assign(new Error('El turno ya está finalizado o anulado.'), { httpStatus: 409 });
      }
      await history(client, turnId, turn.zona_id, 'finalizado', userId, 'aduana');
    }

    return {
      zoneId: turn.zona_id,
      isDefiba: String(turn.origen || '').trim().toLowerCase() === 'defiba'
        || String(turn.zona_nombre || '').trim().toLowerCase() === 'defiba',
    };
  });
}

async function updateTurn(req, res) {
  const body = req.body;
  const action = clean(body.accion);
  const ids = idList(body.turno_ids);
  const scopedAdminUser = req.scopedAdmin;
  const userId = scopedAdminUser
    ? Number(scopedAdminUser.id)
    : positiveInt(body.usuario_id) || null;
  if (scopedAdminUser?.rol === 'admin_aduana'
    && ![
      'quitar_solicitud_aduana',
      'finalizar_turno_aduana',
      'confirmar_aduana',
      'confirmar_aviso_defiba',
      'confirmar_aviso_operador_aduana',
      'marcar_bocina_aduana',
    ].includes(action)) {
    return fail(res, 'No tienes permiso para esta operación de Aduana.', 403);
  }
  if (scopedAdminUser?.rol === 'admin_defiba'
    && action && action !== 'confirmar_aviso_defiba') {
    return fail(res, 'No tienes permiso para esta operación de Defiba.', 403);
  }
  if (['quitar_solicitud_aduana', 'finalizar_turno_aduana'].includes(action)) {
    const turnId = positiveInt(body.turno_id);
    if (!turnId || !userId) {
      return fail(res, 'Turno y usuario de Aduana son obligatorios.', 422);
    }
    let result;
    try {
      result = await manageAduanaRequest(action, turnId, userId);
    } catch (error) {
      if (error.httpStatus) return fail(res, error.message, error.httpStatus);
      throw error;
    }
    emitTurnosChanged();
    emitAduanaTurnosChanged({
      turno_id: turnId,
      usuario_id: userId,
      visible: false,
      refresh_main: true,
    });
    if (result.isDefiba) {
      emitDefibaTurnosChanged({ turno_id: turnId, zona_id: result.zoneId });
    }
    return respond(
      res,
      true,
      action === 'quitar_solicitud_aduana'
        ? 'Turno quitado de la lista de Aduana.'
        : 'Turno marcado como finalizado.',
      { id: turnId },
    );
  }
  if (action === 'confirmar_aduana') {
    if (!ids.length) return fail(res, 'Debe seleccionar al menos un turno.', 422);
    if (scopedAdminUser?.rol === 'admin_aduana') {
      const selected = await pool.query(
        `SELECT t.estado, t.origen, t.aduana_confirmado, z.nombre AS zona_nombre
         FROM turnos t INNER JOIN zonas z ON z.id = t.zona_id
         WHERE t.id = ANY($1::int[])`,
        [ids],
      );
      if (selected.rowCount !== new Set(ids).size
        || selected.rows.some((turn) => !isAduanaVisible(turn))) {
        return fail(res, 'Solo puedes confirmar turnos visibles para el área de Aduana.', 403);
      }
    }
    const confirmed = await confirmAduana(ids, userId);
    if (confirmed.count > 0) {
      emitTurnosChanged();
      emitAduanaTurnosChanged({
        turno_ids: ids,
        usuario_id: userId,
        refresh_main: true,
      });
      if (confirmed.defibaIds.length) {
        emitDefibaTurnosChanged({ turno_ids: confirmed.defibaIds });
      }
      try {
        await sendAduanaRequestPush(confirmed.turnos);
      } catch (error) {
        console.error('[push] No se pudo notificar el pedido de Aduana:', error.message);
      }
    }
    return respond(res, true, 'Turnos confirmados para operadores.', { cantidad: confirmed.count });
  }
  if (['confirmar_aviso_defiba', 'confirmar_aviso_operador_aduana', 'marcar_bocina_aduana'].includes(action)) {
    if (!ids.length) return fail(res, action === 'marcar_bocina_aduana' ? 'No hay turnos para anunciar por bocina.' : 'No hay turnos para confirmar.', 422);
    const [message, count] = await updateBatchAction(action, ids);
    if (count > 0) {
      emitTurnosChanged();
      if (action !== 'marcar_bocina_aduana') {
        emitAduanaTurnosChanged({ turno_ids: ids });
      }
      if (action === 'confirmar_aviso_defiba') {
        emitDefibaTurnosChanged({ turno_ids: ids });
      }
    }
    return respond(res, true, message, { cantidad: count });
  }

  const id = positiveInt(body.id);
  const state = clean(body.estado);
  const company = clean(body.empresa);
  const merchandise = clean(body.mercaderia);
  const merchandiseEmpty = typeof body.mercaderia_vacia === 'boolean'
    ? body.mercaderia_vacia
    : null;
  const destinationId = positiveInt(body.destino_id) || null;
  const operationNumber = clean(body.numero_operacion);
  const priority = clean(body.prioridad).toLowerCase();
  if (state === 'listo_para_salir' && !validPriorities.includes(priority)) {
    return fail(res, 'Debe seleccionar una prioridad: baja, media o alta.', 422);
  }
  if (!id || !validStates.includes(state)) return fail(res, 'ID de turno y estado válido son obligatorios.', 422);

  const pre = await pool.query(
    `SELECT t.numero, t.zona_id, t.estado, t.origen, z.nombre AS zona_nombre,
            t.aduana_confirmado, c.telefono AS camionero_telefono,
            c.nombre AS camionero_nombre
     FROM turnos t INNER JOIN camioneros c ON c.id = t.camionero_id
     INNER JOIN zonas z ON z.id = t.zona_id WHERE t.id = $1`, [id],
  );
  if (!pre.rowCount) return fail(res, 'Turno no encontrado.', 404);
  const turnBefore = pre.rows[0];
  const isDefibaTurn = String(turnBefore.origen || '').trim().toLowerCase() === 'defiba'
    || String(turnBefore.zona_nombre || '').trim().toLowerCase() === 'defiba';
  if (scopedAdminUser?.rol === 'admin_defiba' && !isDefibaTurn) {
    return fail(res, 'Solo puedes operar turnos del área Defiba.', 403);
  }
  if (scopedAdminUser?.rol === 'admin_aduana') {
    return fail(res, 'Usa las acciones disponibles en la sección Aduana.', 403);
  }
  if (isDefibaTurn && state === 'en_curso'
    && (turnBefore.estado !== 'listo_para_salir' || !turnBefore.aduana_confirmado)) {
    return fail(res, 'El turno Defiba debe estar listo para salir y confirmado por Aduana.', 422);
  }
  if (isDefibaTurn && state === 'listo_para_salir'
    && (turnBefore.estado !== 'reservado' || !operationNumber)) {
    return fail(res, 'Debe ingresar el número de operación para dejar el turno listo para salir.', 422);
  }

  const result = await withTransaction(async (client) => {
    let zoneId = null;
    let role = null;
    if (['reservado', 'en_curso', 'listo_para_salir'].includes(state) && userId) {
      const user = await client.query(
        `SELECT u.rol, z.id FROM usuarios u
         LEFT JOIN zonas z ON LOWER(BTRIM(z.nombre)) = LOWER(BTRIM(u.zona))
         WHERE u.id = $1 ORDER BY z.id LIMIT 1`, [userId],
      );
      zoneId = user.rows[0]?.id || null;
      role = user.rows[0]?.rol || null;
      if (!zoneId && isDefibaRole(role)) {
        const defiba = await client.query("SELECT id FROM zonas WHERE LOWER(BTRIM(nombre)) = 'defiba' ORDER BY id LIMIT 1");
        zoneId = defiba.rows[0]?.id || null;
      }
      if (!zoneId && !['admin', 'defiba', 'admin_defiba'].includes(role)) {
        throw Object.assign(new Error('El usuario que confirma debe tener una zona asignada.'), { httpStatus: 422 });
      }
    }

    let update;
    if (['reservado', 'en_curso', 'listo_para_salir'].includes(state)) {
      const values = [
        state,
        userId,
        state === 'en_curso',
        destinationId,
        company,
        operationNumber,
        priority || null,
        merchandise,
        id,
        merchandiseEmpty,
      ];
      if (zoneId) {
        values.push(zoneId);
        update = await client.query(
          `UPDATE turnos SET estado=$1, usuario_pase_id=$2,
             estado_aduana=CASE WHEN $3 AND aduana_confirmado THEN 'en_camino' ELSE estado_aduana END,
             destino_id=COALESCE($4,destino_id), empresa=COALESCE(NULLIF($5,''),empresa),
             numero_operacion=COALESCE(NULLIF($6,''),numero_operacion), prioridad=COALESCE(NULLIF($7,''),prioridad),
             mercaderia=CASE WHEN $10::boolean IS TRUE THEN NULL
               WHEN NULLIF($8,'') IS NOT NULL THEN $8 ELSE mercaderia END,
             mercaderia_vacia=COALESCE($10::boolean,mercaderia_vacia), zona_id=$11
           WHERE id=$9`, values,
        );
        turnBefore.zona_id = zoneId;
      } else {
        update = await client.query(
          `UPDATE turnos SET estado=$1, usuario_pase_id=$2,
             estado_aduana=CASE WHEN $3 AND aduana_confirmado THEN 'en_camino' ELSE estado_aduana END,
             destino_id=COALESCE($4,destino_id), empresa=COALESCE(NULLIF($5,''),empresa),
             numero_operacion=COALESCE(NULLIF($6,''),numero_operacion), prioridad=COALESCE(NULLIF($7,''),prioridad),
             mercaderia=CASE WHEN $10::boolean IS TRUE THEN NULL
               WHEN NULLIF($8,'') IS NOT NULL THEN $8 ELSE mercaderia END,
             mercaderia_vacia=COALESCE($10::boolean,mercaderia_vacia)
           WHERE id=$9`, values,
        );
      }
    } else {
      update = await client.query(
        `UPDATE turnos SET estado=$1,
           estado_aduana=CASE WHEN $2 AND aduana_confirmado THEN 'en_camino' ELSE estado_aduana END
         WHERE id=$3`, [state, state === 'en_curso', id],
      );
    }
    if (!update.rowCount) throw Object.assign(new Error('Turno no encontrado.'), { httpStatus: 404 });
    await history(client, id, turnBefore.zona_id, state, userId, 'app');
    return true;
  });

  emitTurnosChanged();
  if (isDefibaTurn) {
    emitDefibaTurnosChanged({ turno_id: id, zona_id: turnBefore.zona_id });
  }
  const aduanaVisibleBefore = isAduanaVisible(turnBefore);
  const aduanaVisibleAfter = isAduanaVisible({ ...turnBefore, estado: state });
  if (state !== 'pendiente' && (turnBefore.aduana_confirmado || aduanaVisibleBefore || aduanaVisibleAfter)) {
    emitAduanaTurnosChanged({
      turno_id: id,
      visible: aduanaVisibleAfter,
      aduana_confirmado: turnBefore.aduana_confirmado === true,
    });
  }
  if (turnBefore.estado === 'pendiente' && state === 'reservado') {
    void notifyWhatsApp({ ...turnBefore, camionero_telefono: turnBefore.camionero_telefono });
  }
  if (state === 'en_curso') void notifyTts(turnBefore.camionero_nombre);
  return respond(res, true, 'Estado del turno actualizado.', { id, estado: state });
}

async function turns(req, res, authenticate) {
  const method = req.method === 'POST' && String(req.query._method || '').toUpperCase() === 'PUT'
    ? 'PUT'
    : req.method;
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) {
    const user = await authenticate(authorization.slice(7).trim());
    if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
    if (user.rol === 'admin_transito') {
      return fail(res, 'Consulta los turnos desde el dashboard de Tránsito.', 403);
    }
    if (['admin_aduana', 'admin_defiba'].includes(user.rol)) {
      req.scopedAdmin = user;
      if (user.rol === 'admin_aduana' && method === 'POST') {
        return fail(res, 'El administrador de Aduana no puede crear turnos.', 403);
      }
      if (user.rol === 'admin_defiba' && method === 'POST') {
        req.body.usuario_id = user.id;
      }
    }
  }
  if (method === 'GET') return listTurns(req, res);
  if (method === 'POST') return createTurn(req, res);
  if (method === 'PUT') return updateTurn(req, res);
  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
}

async function transitoDashboard(req, res, authenticate) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    return fail(res, 'Debes iniciar sesión para consultar el dashboard de Tránsito.', 401);
  }
  const user = await authenticate(authorization.slice(7).trim());
  if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (user.rol !== 'admin_transito') {
    return fail(res, 'No tienes permiso para consultar el dashboard de Tránsito.', 403);
  }

  const result = await pool.query(
    `SELECT rutas.nombre AS zona_nombre, COUNT(t.id)::int AS cantidad
     FROM (VALUES ('Ruta 11', 1), ('Ruta 86', 2)) AS rutas(nombre, orden)
     LEFT JOIN zonas z ON LOWER(BTRIM(z.nombre)) = LOWER(rutas.nombre)
     LEFT JOIN turnos t ON t.zona_id = z.id
       AND LOWER(BTRIM(t.estado)) = 'reservado'
       AND t.aduana_confirmado = FALSE
     GROUP BY rutas.nombre, rutas.orden
     ORDER BY rutas.orden`,
  );
  return respond(res, true, 'Camiones actualmente en Playa.', result.rows);
}

async function aduanaList(req, res, authenticate) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) {
    const user = await authenticate(authorization.slice(7).trim());
    if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
    if (['admin_aduana', 'admin_defiba', 'admin_transito'].includes(user.rol)) {
      return fail(res, 'Esta lista personal no está disponible para administradores de área.', 403);
    }
  }
  const userId = positiveInt(req.query.usuario_id);
  if (!userId) return fail(res, 'El usuario de Aduana es obligatorio.', 422);
  const result = await pool.query(
    `SELECT t.id, t.numero, t.origen, t.numero_operacion, t.zona_id, t.destino_id,
       t.aduana_confirmado, t.aduana_confirmado_en, t.camionero_id, t.patente, t.empresa,
       t.mercaderia, t.mercaderia_vacia,
       t.fecha_ingreso, t.hora_ingreso, t.estado, t.usuario_id, t.usuario_pase_id,
       c.nombre AS camionero_nombre, c.dni AS camionero_dni, c.patente AS camionero_patente,
       c.telefono AS camionero_telefono, u.nombre AS operador_nombre, u.zona AS operador_zona,
       z.nombre AS zona_nombre, up.nombre AS pase_nombre, up.zona AS pase_zona
     FROM turnos t INNER JOIN camioneros c ON c.id=t.camionero_id
     INNER JOIN zonas z ON z.id=t.zona_id
     LEFT JOIN usuarios u ON u.id=t.usuario_id LEFT JOIN usuarios up ON up.id=t.usuario_pase_id
     WHERE t.aduana_confirmado=TRUE AND EXISTS (
       SELECT 1 FROM turno_historial h WHERE h.turno_id=t.id AND h.evento='lista_aduana' AND h.usuario_id=$1
     ) ORDER BY t.fecha_ingreso, t.hora_ingreso`, [userId],
  );
  return respond(res, true, 'Lista de Aduana.', normalizeBooleanRows(result.rows, ['mercaderia_vacia']));
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function aduanaFinalizados(req, res, authenticate) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    return fail(res, 'Debes iniciar sesión para consultar los finalizados.', 401);
  }
  const user = await authenticate(authorization.slice(7).trim());
  if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (user.rol !== 'admin_aduana') {
    return fail(res, 'No tienes permiso para consultar los finalizados de Aduana.', 403);
  }

  const conditions = ["t.estado = 'finalizado'", 't.aduana_confirmado = TRUE'];
  const values = [];
  const add = (condition, value) => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };
  const destinoId = positiveInt(req.query.destino_id);
  if (destinoId) add('t.destino_id = ?', destinoId);

  const desde = clean(req.query.desde);
  if (desde) {
    if (!validIsoDate(desde)) return fail(res, 'La fecha inicial no es válida.', 422);
    add('COALESCE(finalizacion.finalizado_en, t.fecha_ingreso + t.hora_ingreso) >= ?::date', desde);
  }
  const hasta = clean(req.query.hasta);
  if (hasta) {
    if (!validIsoDate(hasta)) return fail(res, 'La fecha final no es válida.', 422);
    add(
      "COALESCE(finalizacion.finalizado_en, t.fecha_ingreso + t.hora_ingreso) < (?::date + INTERVAL '1 day')",
      hasta,
    );
  }
  if (desde && hasta && desde > hasta) {
    return fail(res, 'La fecha inicial no puede ser posterior a la fecha final.', 422);
  }

  const result = await pool.query(
    `${turnSelect.replace(
      't.estado, t.usuario_id, t.usuario_pase_id,',
      `t.estado, t.usuario_id, t.usuario_pase_id,
       (SELECT d.nombre FROM destinos d WHERE d.id = t.destino_id) AS destino_nombre,
       COALESCE(finalizacion.finalizado_en, t.fecha_ingreso + t.hora_ingreso)
         AS aduana_finalizado_en,`,
    )}
     LEFT JOIN LATERAL (
       SELECT MAX(h.registrado_en) AS finalizado_en
       FROM turno_historial h
       WHERE h.turno_id = t.id
         AND h.estado = 'finalizado'
     ) finalizacion ON TRUE
     WHERE ${conditions.join(' AND ')}
     ORDER BY finalizacion.finalizado_en DESC, t.id DESC`,
    values,
  );
  return respond(
    res,
    true,
    'Turnos finalizados por Aduana.',
    normalizeBooleanRows(result.rows, [
      'aduana_confirmado',
      'defiba_aviso_confirmado',
      'operador_aduana_aviso_confirmado',
      'mercaderia_vacia',
    ]),
  );
}

async function defibaIngresos(req, res, authenticate) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const authorization = String(req.headers.authorization || '');
  if (!authorization.startsWith('Bearer ')) {
    return fail(res, 'Debes iniciar sesión para consultar los ingresos de Defiba.', 401);
  }
  const user = await authenticate(authorization.slice(7).trim());
  if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (user.rol !== 'admin_defiba') {
    return fail(res, 'No tienes permiso para consultar los ingresos de Defiba.', 403);
  }

  const conditions = [`${defibaTurnSql}`];
  const values = [];
  const add = (condition, value) => {
    values.push(value);
    conditions.push(condition.replace('?', `$${values.length}`));
  };
  const destinoId = positiveInt(req.query.destino_id);
  if (destinoId) add('t.destino_id = ?', destinoId);

  const desde = clean(req.query.desde);
  if (desde) {
    if (!validIsoDate(desde)) return fail(res, 'La fecha inicial no es válida.', 422);
    add('t.fecha_ingreso >= ?::date', desde);
  }
  const hasta = clean(req.query.hasta);
  if (hasta) {
    if (!validIsoDate(hasta)) return fail(res, 'La fecha final no es válida.', 422);
    add("t.fecha_ingreso < (?::date + INTERVAL '1 day')", hasta);
  }
  if (desde && hasta && desde > hasta) {
    return fail(res, 'La fecha inicial no puede ser posterior a la fecha final.', 422);
  }

  const result = await pool.query(
    `${turnSelect.replace(
      't.estado, t.usuario_id, t.usuario_pase_id,',
      `t.estado, t.usuario_id, t.usuario_pase_id,
       (SELECT d.nombre FROM destinos d WHERE d.id = t.destino_id) AS destino_nombre,`,
    )}
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.fecha_ingreso DESC, t.hora_ingreso DESC, t.id DESC`,
    values,
  );
  return respond(
    res,
    true,
    'Ingresos del flujo Defiba.',
    normalizeBooleanRows(result.rows, [
      'aduana_confirmado',
      'defiba_aviso_confirmado',
      'operador_aduana_aviso_confirmado',
      'mercaderia_vacia',
    ]),
  );
}

async function historyList(req, res, authenticate) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const authorization = String(req.headers.authorization || '');
  if (authorization.startsWith('Bearer ')) {
    const user = await authenticate(authorization.slice(7).trim());
    if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
    if (['admin_aduana', 'admin_defiba', 'admin_transito'].includes(user.rol)) {
      return fail(res, 'No tienes permiso para consultar este historial.', 403);
    }
  }
  const conditions = [];
  const values = [];
  const add = (column, value) => {
    values.push(value);
    conditions.push(`${column} = $${values.length}`);
  };
  if (positiveInt(req.query.turno_id)) add('h.turno_id', positiveInt(req.query.turno_id));
  if (positiveInt(req.query.zona_id)) add('h.zona_id', positiveInt(req.query.zona_id));
  if (clean(req.query.estado)) add('h.estado', clean(req.query.estado));
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.desde || '')) {
    values.push(req.query.desde);
    conditions.push(`DATE(h.registrado_en) >= $${values.length}`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(req.query.hasta || '')) {
    values.push(req.query.hasta);
    conditions.push(`DATE(h.registrado_en) <= $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query(
    `SELECT h.id,h.turno_id,h.zona_id,z.nombre AS zona_nombre,h.estado,h.evento,h.usuario_id,
            u.nombre AS usuario_nombre,h.origen,h.registrado_en
     FROM turno_historial h INNER JOIN zonas z ON z.id=h.zona_id
     LEFT JOIN usuarios u ON u.id=h.usuario_id ${where}
     ORDER BY h.turno_id,h.registrado_en,h.id`, values,
  );
  return respond(res, true, 'Historial de turnos.', result.rows);
}

export function registerTurnoRoutes(app, { authenticate = authenticateChatToken } = {}) {
  app.all('/api/turnos', (req, res, next) => turns(req, res, authenticate).catch(next));
  app.all('/api/transito/dashboard', (req, res, next) => transitoDashboard(req, res, authenticate).catch(next));
  app.all('/api/aduana/lista', (req, res, next) => aduanaList(req, res, authenticate).catch(next));
  app.all('/api/aduana/finalizados', (req, res, next) => aduanaFinalizados(req, res, authenticate).catch(next));
  app.all('/api/defiba/ingresos', (req, res, next) => defibaIngresos(req, res, authenticate).catch(next));
  app.all('/api/turnos/historial', (req, res, next) => historyList(req, res, authenticate).catch(next));
}

export async function ensureTurnoSchema() {
  await pool.query(`
    ALTER TABLE turnos
      ADD COLUMN IF NOT EXISTS mercaderia TEXT,
      ADD COLUMN IF NOT EXISTS mercaderia_vacia BOOLEAN NOT NULL DEFAULT FALSE
  `);
}