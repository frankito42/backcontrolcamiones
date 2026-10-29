import crypto from 'node:crypto';
import { lockTurnNumberSequence, pool, withTransaction } from './db.js';
import { escapeHtml, fail, publicBaseUrl, respond } from './helpers.js';
import {
  emitDefibaTurnosChanged,
  emitQrScanned,
  emitQrTurnoSolicitado,
  emitTurnosChanged,
} from './realtime.js';

const validSeconds = () => Number(process.env.QR_LINK_VALID_SECONDS || 30);
const clean = (value) => typeof value === 'string' ? value.trim() : '';

export async function claimQrToken(token, database = pool, now = Math.floor(Date.now() / 1000)) {
  const claimed = await database.query(
    `UPDATE qr_tokens SET claimed_at = CURRENT_TIMESTAMP, expires_at = $2
     WHERE token = $1 AND used = FALSE AND claimed_at IS NULL AND expires_at >= $3`,
    [token, now + 300, now],
  );
  if (claimed.rowCount) {
    const zone = await database.query(
      'SELECT zona_id FROM qr_tokens WHERE token = $1',
      [token],
    );
    if (!zone.rowCount) throw new Error('El token QR reclamado ya no existe.');
    return { zoneId: zone.rows[0].zona_id };
  }

  const result = await database.query(
    'SELECT zona_id, expires_at, claimed_at, used FROM qr_tokens WHERE token = $1',
    [token],
  );
  const row = result.rows[0];
  if (!row) return { error: 'Token inválido o inexistente.', status: 404 };
  if (row.used) return { error: 'Este QR ya fue canjeado.', status: 409 };
  if (row.claimed_at) return { error: 'Este QR ya fue escaneado. Usa el nuevo QR de la pantalla.', status: 409 };
  if (Number(row.expires_at) < now) return { error: 'Este QR expiró.', status: 410 };
  return { error: 'No se pudo reservar el QR. Escanéalo nuevamente.', status: 409 };
}

function html(res, content, status = 200) {
  if (res.locals.turnosRealtime) {
    const socketScript = '<script src="/socket.io/socket.io.js"></script><script>io({transports:[\'websocket\']}).on(\'turnos.changed\',()=>location.reload())</script>';
    content = content.replace('</body>', `${socketScript}</body>`);
  }
  return res.status(status).type('html').send(content);
}

function errorPage(message, status = 400) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turno QR</title><style>body{font:16px Arial,sans-serif;background:#eff6ff;color:#0f172a;margin:0;padding:24px}.box{max-width:480px;margin:10vh auto;background:white;padding:28px;border-radius:18px;box-shadow:0 16px 48px #0f172a1a}h1{font-size:24px}p{line-height:1.5;color:#475569}</style></head><body><main class="box"><h1>No se pudo procesar el turno</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function formPage({ zoneName = '', zoneId, query, message = '', note = 'El QR es de un solo uso.', actionUrl }) {
  const title = zoneName ? `Turno en Zona: ${escapeHtml(zoneName)}` : `Turno en Zona #${zoneId}`;
  const formAction = actionUrl || `?${query}`;
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Turno por QR</title><style>
:root{font-family:Arial,Helvetica,sans-serif;color:#102033;background:#edf6ff}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(180deg,#dff2ff,#f7fbff 50%,#eaf3fb)}
.main{width:min(100%,480px);margin:20px auto;padding:20px 16px}.card{background:#fff;border:1px solid #d9e5ef;border-radius:18px;padding:24px 20px;box-shadow:0 18px 44px #14516e20}
h1{font-size:24px;margin:0 0 10px}.subtitle{color:#526477;line-height:1.5;margin:0 0 20px}.alert{padding:12px 14px;border-radius:10px;background:#fee2e2;color:#991b1b;margin:0 0 16px}
label{display:block;font-weight:700;margin:0 0 8px}input{width:100%;padding:14px;border:1px solid #b9cad8;border-radius:10px;font-size:18px;text-transform:uppercase}button{width:100%;padding:14px;border:0;border-radius:10px;background:#087e8b;color:#fff;font-size:16px;font-weight:700;margin-top:16px;cursor:pointer}.note{text-align:center;color:#526477;font-size:13px;line-height:1.5;margin:14px 0 0}
</style></head><body><main class="main"><section class="card"><h1>${title}</h1><p class="subtitle">Ingresá el dominio de tu camión para solicitar un turno.</p>${message ? `<p class="alert">${escapeHtml(message)}</p>` : ''}<form method="post" action="${escapeHtml(formAction)}"><label for="patente">Dominio</label><input id="patente" name="patente" required autocomplete="off" autocapitalize="characters" placeholder="AB123CD"><button type="submit">Solicitar turno</button><p class="note">${escapeHtml(note)}</p></form></section></main></body></html>`;
}

function successPage(number, zone) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turno pendiente</title><style>body{font:16px Arial,sans-serif;background:#eff6ff;color:#102033;margin:0;padding:24px}.box{max-width:480px;margin:10vh auto;background:white;padding:28px;border:1px solid #d9e5ef;border-radius:18px;text-align:center;box-shadow:0 16px 48px #0f172a1a}h1{font-size:25px}.number{display:inline-block;padding:14px 22px;border-radius:10px;background:#d9f2f0;color:#07565e;font-size:24px;font-weight:800}p{color:#526477;line-height:1.5}</style></head><body><main class="box"><h1>Turno pendiente</h1><p>Tu turno quedó confirmado y está en espera para la zona.</p><div class="number">N° ${escapeHtml(number)}</div><p>${escapeHtml(zone)}</p><p>El estado pasará a reservado cuando se complete el proceso.</p></main></body></html>`;
}

function signature(zoneId, expires) {
  return crypto.createHmac('sha256', process.env.QR_SECRET || 'CAMBIAR_POR_UN_SECRETO_ALEATORIO')
    .update(`${zoneId}|${expires}`).digest('hex');
}

function validSignature(zoneId, expires, supplied) {
  const expected = Buffer.from(signature(zoneId, expires));
  const actual = Buffer.from(String(supplied || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function createQrToken(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Método no permitido.', data: null });
  const zoneId = Number.parseInt(req.query.zona_id, 10);
  if (!Number.isSafeInteger(zoneId) || zoneId <= 0) return fail(res, 'Zona inválida.', 422);
  const zone = await pool.query('SELECT id FROM zonas WHERE id = $1', [zoneId]);
  if (!zone.rowCount) return fail(res, 'Zona no encontrada.', 404);
  const token = crypto.randomBytes(16).toString('hex');
  const expires = Math.floor(Date.now() / 1000) + validSeconds();
  await pool.query('INSERT INTO qr_tokens (token, zona_id, expires_at) VALUES ($1, $2, $3)', [token, zoneId, expires]);
  const target = `${publicBaseUrl(req)}/qr?token=${token}`;
  return respond(res, true, 'Token generado.', { target, token, expires, seconds_valid: validSeconds() });
}

async function qrBoard(req, res) {
  const zoneId = Number.parseInt(req.query.zona_id, 10);
  if (!Number.isSafeInteger(zoneId) || zoneId <= 0) return html(res, errorPage('Zona inválida.'), 400);
  const result = await pool.query('SELECT nombre FROM zonas WHERE id = $1', [zoneId]);
  if (!result.rowCount) return html(res, errorPage('Zona no encontrada.'), 404);
  const zoneName = escapeHtml(result.rows[0].nombre);
  return html(res, `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>QR Zona: ${zoneName}</title>
<style>
*{box-sizing:border-box}body{font:16px Arial,sans-serif;background:#080d11;color:#edf4f3;margin:0;min-height:100vh}
.main{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;width:min(100%,640px);min-height:100vh;margin:0 auto;padding:28px}
h1{font-size:24px}.qr{display:grid;place-items:center;background:white;padding:20px;border-radius:8px;width:min(80vw,520px);aspect-ratio:1}
#qrcode{display:grid;place-items:center;width:100%}#qrcode img,#qrcode canvas{display:block;max-width:100%;height:auto}
</style>
</head>
<body>
<main class="main"><h1>QR de la zona: ${zoneName}</h1><div class="qr"><div id="qrcode"></div></div></main>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<script src="/socket.io/socket.io.js"></script>
<script>
const target=document.getElementById('qrcode');
const zoneId=${zoneId};
let activeToken=null,renewalTimer=null,renewing=false,renewalRequested=false;
const socket=io({transports:['websocket']});
socket.on('qr.scanned',event=>{
  if(Number(event.zona_id)!==zoneId||!activeToken)return;
  activeToken=null;
  clearTimeout(renewalTimer);
  target.replaceChildren();
  requestRenewal();
});
function requestRenewal(){
  if(renewing){renewalRequested=true;return;}
  void renew();
}
async function renew(){
  if(renewing){renewalRequested=true;return;}
  renewing=true;
  clearTimeout(renewalTimer);
  try{
    const response=await fetch(${JSON.stringify(`/api/qr/token?zona_id=${zoneId}`)},{cache:'no-store'});
    const result=await response.json();
    if(!response.ok||!result.success)throw Error('No se pudo generar el QR');
    target.replaceChildren();
    activeToken=result.data.token;
    new QRCode(target,{text:result.data.target,width:500,height:500,colorDark:'#000',colorLight:'#fff'});
    renewalTimer=setTimeout(()=>{
      activeToken=null;
      target.replaceChildren();
      requestRenewal();
    },(result.data.seconds_valid||${validSeconds()})*1000);
  }catch(error){
    activeToken=null;
    target.replaceChildren();
    renewalTimer=setTimeout(requestRenewal,3000);
  }finally{
    renewing=false;
    if(renewalRequested){
      renewalRequested=false;
      activeToken=null;
      target.replaceChildren();
      requestRenewal();
    }
  }
}
requestRenewal();
</script>
</body>
</html>`);
}

async function submitQrTurn({ zoneId, plate, token, res }) {
  if (!plate) return { error: 'Ingresá el dominio del camión.' };
  const result = await withTransaction(async (client) => {
    if (token) {
      const tokenResult = await client.query('SELECT token, zona_id, expires_at, claimed_at, used FROM qr_tokens WHERE token = $1 FOR UPDATE', [token]);
      const row = tokenResult.rows[0];
      if (!row) throw new Error('Token inválido o inexistente.');
      if (row.used) throw new Error('Este QR ya fue canjeado.');
      if (!row.claimed_at) throw new Error('Primero escanea el QR vigente.');
      if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) throw new Error('Este QR expiró.');
      zoneId = row.zona_id;
    }
    const zone = await client.query('SELECT nombre FROM zonas WHERE id = $1', [zoneId]);
    if (!zone.rowCount) throw new Error('Zona no encontrada.');

    let driver = await client.query('SELECT id FROM camioneros WHERE UPPER(patente) = $1 LIMIT 1', [plate]);
    let driverId = driver.rows[0]?.id;
    if (!driverId) {
      const seed = token || `${zoneId}|${Date.now()}|${plate}`;
      const dni = `QR${crypto.createHash('sha256').update(`${seed}|${plate}`).digest('hex').slice(0, 17).toUpperCase()}`;
      const inserted = await client.query(
        `INSERT INTO camioneros (nombre, dni, patente) VALUES ('Pendiente de completar', $1, $2)`, [dni, plate],
      );
      driverId = inserted.insertId;
    }
    const active = await client.query(
      'SELECT patente FROM turnos WHERE camionero_id = $1 AND estado IN ($2)',
      [driverId, ['reservado', 'pendiente', 'en_curso']],
    );
    const conflict = active.rows.find((row) => row.patente.toUpperCase() !== plate);
    if (conflict) throw new Error(`Ya tenés un turno activo con patente diferente: ${conflict.patente}.`);

    await lockTurnNumberSequence(client);
    const latest = await client.query('SELECT COALESCE(MAX(numero), 0) + 1 AS numero FROM turnos');
    const number = latest.rows[0].numero;
    const inserted = await client.query(
      `INSERT INTO turnos (numero, camionero_id, patente, estado, zona_id)
       VALUES ($1, $2, $3, 'pendiente', $4)`, [number, driverId, plate, zoneId],
    );
    const turnId = inserted.insertId;
    await client.query(
      `INSERT INTO turno_historial (turno_id, zona_id, estado, evento, origen)
       VALUES ($1, $2, 'pendiente', 'estado', 'qr')`, [turnId, zoneId],
    );
    if (token) {
      await client.query('UPDATE qr_tokens SET used = TRUE, used_at = CURRENT_TIMESTAMP WHERE token = $1', [token]);
    }
    return { number, zoneName: zone.rows[0].nombre };
  });
  return result;
}

async function qrForm(req, res) {
  const token = clean(req.query.token);
  let zoneId = Number.parseInt(req.query.zona_id, 10) || 0;
  let zoneName = '';
  let note = 'Link firmado válido por 30 segundos.';
  if (token) {
    if (req.method === 'GET') {
      const claim = await claimQrToken(token);
      if (claim.error) return html(res, errorPage(claim.error), claim.status);
      zoneId = claim.zoneId;
      emitQrScanned(zoneId);
    } else {
      const tokenRow = await pool.query(
        'SELECT zona_id, expires_at, claimed_at, used FROM qr_tokens WHERE token = $1',
        [token],
      );
      if (!tokenRow.rowCount) return html(res, errorPage('Token inválido o inexistente.'), 404);
      const row = tokenRow.rows[0];
      zoneId = row.zona_id;
      if (row.used) return html(res, errorPage('Este QR ya fue canjeado.'), 409);
      if (!row.claimed_at) return html(res, errorPage('Primero escanea el QR vigente.'), 409);
      if (Number(row.expires_at) < Math.floor(Date.now() / 1000)) return html(res, errorPage('El formulario expiró. Escanea el nuevo QR.'), 410);
    }
    note = 'Formulario reservado por 5 minutos desde su apertura.';
  } else {
    const expires = Number.parseInt(req.query.expires, 10) || 0;
    const sig = clean(req.query.sig);
    if (zoneId <= 0 || !expires || !sig || Math.floor(Date.now() / 1000) > expires || !validSignature(zoneId, expires, sig)) {
      return html(res, errorPage('Link QR inválido, vencido o con firma incorrecta.'), 400);
    }
  }
  const zone = await pool.query('SELECT nombre FROM zonas WHERE id = $1', [zoneId]);
  if (!zone.rowCount) return html(res, errorPage('Zona no encontrada.'), 404);
  zoneName = zone.rows[0].nombre;
  if (req.method !== 'POST') {
    return html(res, formPage({ zoneName, zoneId, query: req.originalUrl.split('?')[1] || '', note }));
  }

  const plate = clean(req.body.patente).toUpperCase().replace(/\s+/g, '');
  try {
    const result = await submitQrTurn({ zoneId, plate, token, res });
    emitTurnosChanged();
    emitQrTurnoSolicitado({
      zoneId,
      zoneName: result.zoneName,
      number: result.number,
    });
    if (result.zoneName.trim().toLowerCase() === 'defiba') {
      emitDefibaTurnosChanged({ zona_id: zoneId });
    }
    return html(res, successPage(result.number, result.zoneName));
  } catch (error) {
    return html(res, formPage({ zoneName, zoneId, query: req.originalUrl.split('?')[1] || '', note, message: error.message }), 422);
  }
}

async function tracking(req, res) {
  const zoneId = Number.parseInt(req.query.zona_id, 10) || 0;
  const number = Number.parseInt(req.query.numero, 10) || 0;
  if (!zoneId || !number) return html(res, errorPage('Faltan datos de zona o número de turno.'), 400);
  const turn = await pool.query(
    `SELECT t.numero,t.estado,t.fecha_ingreso,t.hora_ingreso,z.nombre AS zona_nombre,
            c.nombre AS camionero_nombre,c.patente
     FROM turnos t INNER JOIN zonas z ON z.id=t.zona_id INNER JOIN camioneros c ON c.id=t.camionero_id
     WHERE t.zona_id=$1 AND t.numero=$2 LIMIT 1`, [zoneId, number],
  );
  if (!turn.rowCount) return html(res, errorPage('Turno no encontrado.'), 404);
  const row = turn.rows[0];
  const ahead = await pool.query(
    `SELECT numero, patente FROM turnos WHERE estado IN ('pendiente','reservado','en_curso')
     AND numero < $1 ORDER BY numero ASC`, [number],
  );
  const states = {
    reservado: 'Reservado', pendiente: 'Pendiente', en_curso: 'En curso',
    finalizado: 'Finalizado', anulado: 'Anulado', listo_para_salir: 'Listo para salir',
  };
  const aheadHtml = ahead.rows.length
    ? ahead.rows.map((entry) => `<li>N° ${escapeHtml(entry.numero)} (${escapeHtml(entry.patente)})</li>`).join('')
    : '<li>No hay turnos adelante.</li>';
  return html(res, `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seguimiento de turno ${number}</title><style>body{font:16px Arial,sans-serif;background:#081019;color:#edf4f3;margin:0;padding:24px}.page{max-width:800px;margin:6vh auto}.hero,.list{background:#101d27;padding:22px;border-radius:12px;margin-bottom:12px;border:1px solid #263744}h1{font-size:27px;margin:0 0 12px}.number{font-size:32px;font-weight:800;color:#75d0c3}small{color:#a9bac4}.list li{padding:8px 0}</style></head><body><main class="page"><section class="hero"><small>${escapeHtml(row.zona_nombre)} · ${escapeHtml(row.fecha_ingreso)} ${escapeHtml(row.hora_ingreso)}</small><h1>Seguimiento de turno</h1><div class="number">N° ${escapeHtml(row.numero)}</div><p>${escapeHtml(row.camionero_nombre)} · ${escapeHtml(row.patente)}</p><strong>${escapeHtml(states[row.estado] || row.estado)}</strong></section><section class="list"><h2>Turnos adelante</h2><ul>${aheadHtml}</ul></section></main></body></html>`);
}

export function registerQrRoutes(app) {
  app.get('/api/qr/token', (req, res, next) => createQrToken(req, res).catch(next));
  app.get('/qr/zona', (req, res, next) => qrBoard(req, res).catch(next));
  app.all('/qr', (req, res, next) => qrForm(req, res).catch(next));
  app.all('/qr/formulario-original', (_req, res) => html(res, errorPage('Este formulario quedó reemplazado por el flujo QR actual.'), 410));
  app.get('/tracking', (req, res, next) => {
    res.locals.turnosRealtime = true;
    tracking(req, res).catch(next);
  });
}