import { escapeHtml } from './helpers.js';
import { pool } from './db.js';
import ExcelJS from 'exceljs';

function turnosEnCursoPage() {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Turnos en curso</title><style>
:root{font-family:Arial,Helvetica,sans-serif;color:#e6efed;background:#111b20}*{box-sizing:border-box}body{margin:0;padding:24px}.page{max-width:1050px;margin:0 auto}.head{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid #33454b;padding:12px 0 20px}h1{font-size:26px;margin:0}button{border:0;border-radius:6px;background:#087e8b;color:white;padding:11px 15px;font-weight:700;cursor:pointer}.list{display:grid;gap:10px;padding:16px 0}.item{display:grid;grid-template-columns:1fr auto;gap:14px;align-items:center;padding:16px;border:1px solid #33454b;border-radius:8px;background:#18262c}.detail{display:grid;gap:5px}.muted{color:#a7b9bc}.empty{padding:22px;color:#a7b9bc;border:1px dashed #52676c;border-radius:8px}@media(max-width:600px){body{padding:16px}.head{align-items:flex-start;flex-direction:column}.item{grid-template-columns:1fr}}
</style></head><body><main class="page"><header class="head"><div><h1>Turnos en curso</h1><p class="muted">Solo se muestran los turnos con estado en curso.</p></div><button id="refresh" type="button">Actualizar lista</button></header><p id="status" class="muted" aria-live="polite"></p><section id="list" class="list"></section></main><script>
const list=document.querySelector('#list'),status=document.querySelector('#status');
async function load(){status.textContent='Cargando…';list.replaceChildren();try{const response=await fetch('/api/turnos?estado=en_curso',{cache:'no-store'});const payload=await response.json();if(!response.ok||!payload.success)throw Error(payload.message||'No se pudo cargar la lista.');const turns=payload.data||[];if(!turns.length){list.innerHTML='<div class="empty">No hay turnos en curso.</div>'}for(const turn of turns){const row=document.createElement('article');row.className='item';const detail=document.createElement('div');detail.className='detail';const number=document.createElement('strong');number.textContent=turn.numero==null?'Sin número':'Turno N° '+turn.numero;const description=document.createElement('span');description.textContent=(turn.camionero_nombre||'Camionero')+' · '+(turn.patente||'');const zone=document.createElement('span');zone.className='muted';zone.textContent=turn.zona_nombre||'';detail.append(number,description,zone);const button=document.createElement('button');button.type='button';button.textContent='Finalizar';button.addEventListener('click',()=>finish(turn.id,button));row.append(detail,button);list.append(row)}status.textContent=turns.length+' turno(s) en curso.'}catch(error){status.textContent=error.message}}
async function finish(id,button){button.disabled=true;try{const response=await fetch('/api/turnos',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,estado:'finalizado'})});const payload=await response.json();if(!response.ok||!payload.success)throw Error(payload.message||'No se pudo finalizar.');await load()}catch(error){status.textContent=error.message;button.disabled=false}}
 document.querySelector('#refresh').addEventListener('click',load);
 const socketScript=document.createElement('script');
 socketScript.src='/socket.io/socket.io.js';
 socketScript.onload=()=>io({transports:['websocket']}).on('turnos.changed',load);
 document.head.append(socketScript);load();
</script></body></html>`;
}

function configuracionPage({ usuarios, roles, zonas, destinos }) {
  const userRows = usuarios.length
    ? usuarios.map((user) => `<tr>
        <td>${escapeHtml(user.nombre)}</td>
        <td>${escapeHtml(user.usuario)}</td>
        <td>${escapeHtml(user.rol)}</td>
        <td>${escapeHtml(user.zona || '—')}</td>
        <td>${escapeHtml(user.destino || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="5" class="empty">No hay usuarios registrados.</td></tr>';
  const roleItems = roles.length
    ? roles.map((role) => `<li>${escapeHtml(role.nombre)} <span>${escapeHtml(role.slug)}${role.activo ? '' : ' · Inactivo'}</span></li>`).join('')
    : '<li>No hay roles registrados.</li>';
  const zoneItems = zonas.length
    ? zonas.map((zone) => `<li>${escapeHtml(zone.nombre)}</li>`).join('')
    : '<li>No hay zonas registradas.</li>';
  const destinationItems = destinos.length
    ? destinos.map((destination) => `<li>${escapeHtml(destination.nombre)}</li>`).join('')
    : '<li>No hay destinos registrados.</li>';

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>SICOF · Usuarios y configuración</title>
  <style>
    :root{font-family:Arial,Helvetica,sans-serif;color:#202b33;background:#eef2f4}
    *{box-sizing:border-box}
    body{margin:0;padding:28px}
    main{max-width:1100px;margin:0 auto}
    header{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:24px}
    h1{font-size:28px;margin:0 0 6px}
    h2{font-size:18px;margin:0 0 12px}
    p,.muted{color:#63727b;margin:0}
    button{border:0;border-radius:8px;background:#087e8b;color:#fff;padding:11px 16px;font-weight:700;cursor:pointer}
    .actions{display:flex;gap:10px}
    .download{display:inline-block;border-radius:8px;background:#087e8b;color:#fff;padding:11px 16px;font-weight:700;text-decoration:none}
    section,.catalog article{background:#fff;border:1px solid #d8e0e4;border-radius:12px;padding:18px;margin-bottom:18px}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #e4e9ec}
    th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#53636c;background:#f4f7f8}
    tbody tr:last-child td{border-bottom:0}
    .catalog{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
    .catalog article{margin:0}
    ul{list-style:none;margin:0;padding:0}
    li{padding:7px 0;border-bottom:1px solid #edf0f2}
    li:last-child{border-bottom:0}
    li span{color:#71818a;font-size:12px;margin-left:6px}
    .empty{padding:20px;text-align:center;color:#71818a}
    @media(max-width:700px){body{padding:16px}header{align-items:flex-start;flex-direction:column}.catalog{grid-template-columns:1fr}section{overflow-x:auto}table{min-width:650px}}
    @media print{
      :root{background:#fff;color:#000}
      body{padding:0}
      main{max-width:none}
      header{margin-bottom:14px}
      header button{display:none}
      section,.catalog article{border:1px solid #bbb;border-radius:0;break-inside:avoid;padding:12px}
      .catalog{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
      th,td{padding:7px 8px}
      th{background:#eee!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .muted,li span{color:#444}
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>SICOF · Usuarios y configuración</h1>
        <p class="muted">Listado de usuarios, roles, zonas y destinos · ${escapeHtml(new Date().toLocaleString('es-AR'))}</p>
      </div>
      <div class="actions">
        <a class="download" href="/configuracion/usuarios.xlsx">Descargar Excel</a>
        <button type="button" onclick="window.print()">Imprimir lista</button>
      </div>
    </header>
    <section>
      <h2>Usuarios (${usuarios.length})</h2>
      <table>
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Zona</th><th>Destino</th></tr></thead>
        <tbody>${userRows}</tbody>
      </table>
    </section>
    <div class="catalog">
      <article><h2>Roles (${roles.length})</h2><ul>${roleItems}</ul></article>
      <article><h2>Zonas (${zonas.length})</h2><ul>${zoneItems}</ul></article>
      <article><h2>Destinos (${destinos.length})</h2><ul>${destinationItems}</ul></article>
    </div>
  </main>
</body>
</html>`;
}

export function registerWebRoutes(app) {
  app.get('/turnos/en-curso', (_req, res) => res.type('html').send(turnosEnCursoPage()));
  const getConfiguration = async () => {
    const [usersResult, rolesResult, zonesResult, destinationsResult] = await Promise.all([
      pool.query(
        `SELECT u.nombre, u."user" AS usuario, u.rol, u.zona, d.nombre AS destino
         FROM usuarios u
         LEFT JOIN destinos d ON d.id = u.destino_id
         ORDER BY LOWER(u.rol), LOWER(COALESCE(u.zona, '')), LOWER(u.nombre)`,
      ),
      pool.query('SELECT slug, nombre, activo FROM roles ORDER BY nombre'),
      pool.query('SELECT nombre FROM zonas ORDER BY nombre'),
      pool.query('SELECT nombre FROM destinos ORDER BY nombre'),
    ]);
    return {
      usuarios: usersResult.rows,
      roles: rolesResult.rows,
      zonas: zonesResult.rows,
      destinos: destinationsResult.rows,
    };
  };

  app.get('/configuracion/usuarios', async (_req, res, next) => {
    try {
      res.type('html').send(configuracionPage(await getConfiguration()));
    } catch (error) {
      next(error);
    }
  });

  app.get('/configuracion/usuarios.xlsx', async (_req, res, next) => {
    try {
      const { usuarios, roles, zonas, destinos } = await getConfiguration();
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'SICOF';
      workbook.created = new Date();

      const addSheet = (name, columns, rows) => {
        const sheet = workbook.addWorksheet(name);
        sheet.columns = columns;
        sheet.addRows(rows);
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FF087E8B' },
        };
        sheet.views = [{ state: 'frozen', ySplit: 1 }];
        if (rows.length) sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}${rows.length + 1}` };
      };

      addSheet('Usuarios', [
        { header: 'Nombre', key: 'nombre', width: 28 },
        { header: 'Usuario', key: 'usuario', width: 22 },
        { header: 'Rol', key: 'rol', width: 18 },
        { header: 'Zona', key: 'zona', width: 22 },
        { header: 'Destino', key: 'destino', width: 26 },
      ], usuarios.map((user) => ({
        nombre: user.nombre,
        usuario: user.usuario,
        rol: user.rol,
        zona: user.zona || '',
        destino: user.destino || '',
      })));
      addSheet('Roles', [
        { header: 'Nombre', key: 'nombre', width: 28 },
        { header: 'Identificador', key: 'slug', width: 22 },
        { header: 'Estado', key: 'estado', width: 16 },
      ], roles.map((role) => ({
        nombre: role.nombre,
        slug: role.slug,
        estado: role.activo ? 'Activo' : 'Inactivo',
      })));
      addSheet('Zonas', [{ header: 'Nombre', key: 'nombre', width: 30 }], zonas);
      addSheet('Destinos', [{ header: 'Nombre', key: 'nombre', width: 30 }], destinos);

      const buffer = await workbook.xlsx.writeBuffer();
      res
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .attachment('SICOF-usuarios-roles-zonas-destinos.xlsx')
        .send(Buffer.from(buffer));
    } catch (error) {
      next(error);
    }
  });
}

export function htmlMessage(title, message, status = 400) {
  return (req, res) => res.status(status).type('html').send(
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
  );
}