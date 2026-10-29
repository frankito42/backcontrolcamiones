import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { pool, withTransaction } from './db.js';
import { fail, methodNotAllowed, positiveInt, publicBaseUrl, respond } from './helpers.js';
import { authenticateChatToken, createChatSession } from './chat-auth.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const rolesValidos = ['admin', 'admin_aduana', 'admin_defiba', 'admin_transito', 'operador', 'pase', 'defiba', 'aduana'];
const transitRoles = ['operador', 'pase'];
const transitZones = ['ruta 11', 'ruta 86'];
const temasValidos = ['oscuro', 'claro', 'azul_marino', 'azul_claro'];
const uploadTargets = {
  zona: { table: 'zonas', column: 'logo_url', directory: 'logos', field: 'logo' },
  usuario: { table: 'usuarios', column: 'logo_url', directory: 'logos', field: 'logo' },
  rol: { table: 'roles', column: 'logo_url', directory: 'logos', field: 'logo' },
  usuario_fondo: {
    table: 'usuarios',
    column: 'fondo_url',
    directory: 'fondos',
    field: 'fondo',
  },
};

export async function ensureUsuarioSchema() {
  await pool.query(
    `INSERT IGNORE INTO roles (slug, nombre) VALUES
      ('admin_aduana', 'Administrador de Aduana'),
      ('admin_defiba', 'Administrador de Defiba'),
      ('admin_transito', 'Administrador de Tránsito')`,
  );
  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS destino_id INT NULL
  `);
  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS fondo_url VARCHAR(500)
  `);
  await pool.query(`
    ALTER TABLE usuarios
    ADD COLUMN IF NOT EXISTS tema_preferido VARCHAR(30) NOT NULL DEFAULT 'oscuro'
  `);
}

function methodOf(req) {
  const override = String(req.query._method || '').toUpperCase();
  return req.method === 'POST' && ['PUT', 'DELETE'].includes(override) ? override : req.method;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function bearerToken(req) {
  const authorization = String(req.headers.authorization || '');
  return authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
}

async function requestUser(req, authenticate) {
  return authenticate(bearerToken(req));
}

function roleManagedBy(user) {
  if (user?.rol === 'admin_aduana') return 'aduana';
  if (user?.rol === 'admin_defiba') return 'defiba';
  return null;
}

function canonicalZoneName(value) {
  const name = text(value);
  const normalized = name.toLowerCase();
  if (normalized === 'defiba') return 'Defiba';
  if (normalized === 'ruta 11') return 'Ruta 11';
  if (normalized === 'ruta 86') return 'Ruta 86';
  return name;
}

function isTransitUser(role, zone) {
  return transitRoles.includes(String(role || '').trim().toLowerCase())
    && transitZones.includes(String(zone || '').trim().toLowerCase());
}

function integerFields(rows, fields) {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    fields.includes(key) && value !== null ? Number(value) : value,
  ])));
}

function failDb(res, error, message) {
  if (error.code === 'ER_DUP_ENTRY') return fail(res, 'Ya existe un registro con esos datos.', 409);
  if (error.code === 'ER_NO_REFERENCED_ROW_2' || error.code === 'ER_ROW_IS_REFERENCED_2') {
    return fail(res, 'No se puede eliminar porque hay registros asociados.', 409);
  }
  console.error(error);
  return fail(res, message, 500);
}

async function login(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
  const user = text(req.body.user);
  const pass = typeof req.body.pass === 'string' ? req.body.pass : '';
  if (!user || !pass) return fail(res, 'Usuario y contraseña son obligatorios.', 422);

  const result = await pool.query(
    `SELECT u.id, u.nombre, u.\`user\`, u.dni, u.telefono, u.zona, u.destino_id,
            d.nombre AS destino_nombre, u.rol, u.logo_url, u.fondo_url,
            u.tema_preferido
     FROM usuarios u LEFT JOIN destinos d ON d.id = u.destino_id
     WHERE u.\`user\` = $1 AND u.pass = $2 LIMIT 1`,
    [user, pass],
  );
  if (!result.rowCount) return fail(res, 'Usuario o contraseña incorrectos.', 401);
  const chatToken = await createChatSession(result.rows[0].id);
  return respond(res, true, 'Inicio de sesión exitoso.', {
    ...result.rows[0],
    chat_token: chatToken,
  });
}

async function camioneros(req, res, authenticate) {
  const method = methodOf(req);
  const user = await requestUser(req, authenticate);
  if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (user.rol === 'admin_transito') {
    return fail(res, 'No tienes permiso para acceder al directorio de camioneros.', 403);
  }
  if (roleManagedBy(user) && !(user.rol === 'admin_defiba'
    && method === 'GET' && text(req.query.dni))) {
    return fail(res, 'No tienes permiso para acceder al directorio de camioneros.', 403);
  }
  if (roleManagedBy(user) && method !== 'GET') {
    return fail(res, 'No tienes permiso para modificar camioneros.', 403);
  }
  if (method === 'GET') {
    if (text(req.query.dni)) {
      const result = await pool.query(
        'SELECT id, nombre, dni, patente, telefono FROM camioneros WHERE dni = $1 LIMIT 1',
        [text(req.query.dni)],
      );
      return respond(res, true, result.rowCount ? 'Camionero encontrado.' : 'No existe camionero con ese DNI.', result.rows[0] || null);
    }
    const q = text(req.query.buscar);
    const result = q
      ? await pool.query(
        `SELECT id, nombre, dni, patente, telefono FROM camioneros
         WHERE LOWER(dni) LIKE LOWER($1) OR LOWER(patente) LIKE LOWER($1)
           OR LOWER(nombre) LIKE LOWER($1) ORDER BY nombre ASC`,
        [`%${q}%`],
      )
      : await pool.query('SELECT id, nombre, dni, patente, telefono FROM camioneros ORDER BY nombre ASC');
    return respond(res, true, 'Listado de camioneros.', result.rows);
  }

  if (method === 'POST') {
    const nombre = text(req.body.nombre);
    const dni = text(req.body.dni);
    const patente = text(req.body.patente).toUpperCase();
    const telefono = text(req.body.telefono) || null;
    if (!nombre || !dni || !patente) return fail(res, 'Nombre, DNI y patente son obligatorios.', 422);
    try {
      const result = await pool.query(
        `INSERT INTO camioneros (nombre, dni, patente, telefono)
         VALUES ($1, $2, $3, $4)`,
        [nombre, dni, patente, telefono],
      );
      return respond(res, true, 'Camionero registrado.', { id: result.insertId, nombre, dni, patente, telefono }, 201);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        const existing = await pool.query('SELECT id FROM camioneros WHERE dni = $1 LIMIT 1', [dni]);
        return fail(res, 'Ya existe un camionero con ese DNI.', 409, { id: existing.rows[0]?.id ?? null });
      }
      throw error;
    }
  }

  if (method === 'PUT') {
    const id = positiveInt(req.body.id);
    const nombre = text(req.body.nombre);
    const dni = text(req.body.dni);
    if (!id || !nombre || !dni) return fail(res, 'ID, nombre y DNI son obligatorios.', 422);
    const exists = await pool.query('SELECT id FROM camioneros WHERE id = $1', [id]);
    if (!exists.rowCount) return fail(res, 'Camionero no encontrado.', 404);
    const duplicate = await pool.query('SELECT id FROM camioneros WHERE dni = $1 AND id <> $2', [dni, id]);
    if (duplicate.rowCount) return fail(res, 'El DNI ya está asociado a otro camionero.', 409);
    await pool.query(
      'UPDATE camioneros SET nombre = $1, dni = $2, telefono = $3 WHERE id = $4',
      [nombre, dni, text(req.body.telefono) || null, id],
    );
    return respond(res, true, 'Camionero actualizado.', { id });
  }
  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
}

async function usuarios(req, res, authenticate) {
  const method = methodOf(req);
  const requester = await requestUser(req, authenticate);
  if (!requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  const managedRole = roleManagedBy(requester);
  const isTransitAdmin = requester.rol === 'admin_transito';
  if (!managedRole && !isTransitAdmin && requester.rol !== 'admin') {
    return fail(res, 'No tienes permiso para administrar usuarios.', 403);
  }
  if (method === 'GET') {
    if (req.query.id !== undefined) {
      const id = positiveInt(req.query.id);
      if (isTransitAdmin) {
        const result = await pool.query(
          `SELECT u.id, u.nombre, u.\`user\`, u.dni, u.telefono, u.zona,
            u.destino_id, d.nombre AS destino_nombre, u.rol, u.logo_url,
            u.fondo_url, u.tema_preferido
           FROM usuarios u LEFT JOIN destinos d ON d.id = u.destino_id
           WHERE u.id = $1 AND LOWER(TRIM(u.rol)) IN ('operador', 'pase')
             AND LOWER(TRIM(COALESCE(u.zona, ''))) IN ('ruta 11', 'ruta 86')`,
          [id],
        );
        if (!result.rowCount) return fail(res, 'Usuario no encontrado.', 404);
        return respond(res, true, 'Usuario.', result.rows[0]);
      }
      const result = await pool.query(
        `SELECT u.id, u.nombre, u.\`user\`, u.dni, u.telefono, u.zona,
          u.destino_id, d.nombre AS destino_nombre, u.rol, u.logo_url,
          u.fondo_url, u.tema_preferido
         FROM usuarios u LEFT JOIN destinos d ON d.id = u.destino_id
         WHERE u.id = $1 AND ($2 IS NULL OR u.rol = $2)`,
        [id, managedRole],
      );
      if (!result.rowCount) return fail(res, 'Usuario no encontrado.', 404);
      return respond(res, true, 'Usuario.', result.rows[0]);
    }
    if (isTransitAdmin) {
      const result = await pool.query(
        `SELECT u.id, u.nombre, u.\`user\`, u.dni, u.telefono, u.zona,
                u.destino_id, d.nombre AS destino_nombre, u.rol, u.logo_url,
                u.fondo_url, u.tema_preferido
         FROM usuarios u LEFT JOIN destinos d ON d.id = u.destino_id
         WHERE LOWER(TRIM(u.rol)) IN ('operador', 'pase')
           AND LOWER(TRIM(COALESCE(u.zona, ''))) IN ('ruta 11', 'ruta 86')
         ORDER BY u.nombre ASC`,
      );
      return respond(res, true, 'Listado de usuarios.', result.rows);
    }
    const result = await pool.query(
      `SELECT u.id, u.nombre, u.\`user\`, u.dni, u.telefono, u.zona,
              u.destino_id, d.nombre AS destino_nombre, u.rol, u.logo_url,
              u.fondo_url, u.tema_preferido
       FROM usuarios u LEFT JOIN destinos d ON d.id = u.destino_id
       WHERE ($1 IS NULL OR u.rol = $1) ORDER BY u.nombre ASC`,
      [managedRole],
    );
    return respond(res, true, 'Listado de usuarios.', result.rows);
  }

  if (method === 'POST') {
    const { nombre, user, dni, telefono, pass } = req.body;
    const rol = text(req.body.rol).toLowerCase();
    const zona = rol === 'defiba' ? 'Defiba' : canonicalZoneName(req.body.zona);
    const destinoId = positiveInt(req.body.destino_id) || null;
    if (isTransitAdmin && !transitRoles.includes(rol)) {
      return fail(res, 'Solo puedes crear Operadores y Operadores de Pase.', 403);
    }
    if (isTransitAdmin && !isTransitUser(rol, zona)) {
      return fail(res, 'Solo puedes asignar usuarios a Ruta 11 o Ruta 86.', 422);
    }
    if (managedRole && rol !== managedRole) {
      return fail(res, 'Solo puedes crear usuarios del área que administras.', 403);
    }
    if (!text(nombre) || !text(user) || !text(dni) || !pass || !rolesValidos.includes(rol)) {
      return fail(res, 'Todos los campos son obligatorios y el rol debe ser válido.', 422);
    }
    if (rol === 'aduana' && !destinoId) {
      return fail(res, 'Cada usuario Aduana debe tener un destino asignado.', 422);
    }
    if (destinoId) {
      const destino = await pool.query('SELECT id FROM destinos WHERE id = $1', [destinoId]);
      if (!destino.rowCount) return fail(res, 'Destino inválido.', 422);
    }
    try {
      const result = await pool.query(
        `INSERT INTO usuarios (nombre, \`user\`, dni, telefono, zona, destino_id, pass, rol)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [text(nombre), text(user), text(dni), text(telefono) || null, zona || null,
          ['aduana', 'pase'].includes(rol) ? destinoId : null, pass, rol],
      );
      return respond(res, true, 'Usuario creado.', { id: result.insertId }, 201);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return fail(res, 'El nombre de usuario ya está en uso.', 409);
      throw error;
    }
  }

  if (method === 'PUT') {
    const id = positiveInt(req.body.id);
    const nombre = text(req.body.nombre);
    const user = text(req.body.user);
    const dni = text(req.body.dni);
    const rol = text(req.body.rol).toLowerCase();
    const destinoId = positiveInt(req.body.destino_id) || null;
    const zona = canonicalZoneName(req.body.zona);
    const pass = typeof req.body.pass === 'string' ? req.body.pass : '';
    if (isTransitAdmin && !transitRoles.includes(rol)) {
      return fail(res, 'Solo puedes editar Operadores y Operadores de Pase.', 403);
    }
    if (isTransitAdmin && !isTransitUser(rol, zona)) {
      return fail(res, 'Solo puedes asignar usuarios a Ruta 11 o Ruta 86.', 422);
    }
    if (managedRole && rol !== managedRole) {
      return fail(res, 'Solo puedes editar usuarios del área que administras.', 403);
    }
    if (!id || !nombre || !user || !dni || !rolesValidos.includes(rol)) {
      return fail(res, 'Datos incompletos o rol inválido.', 422);
    }
    if (rol === 'aduana' && !destinoId) {
      return fail(res, 'Cada usuario Aduana debe tener un destino asignado.', 422);
    }
    if (destinoId) {
      const destino = await pool.query('SELECT id FROM destinos WHERE id = $1', [destinoId]);
      if (!destino.rowCount) return fail(res, 'Destino inválido.', 422);
    }
    const existing = await pool.query('SELECT id, rol, zona FROM usuarios WHERE id = $1', [id]);
    if (!existing.rowCount) return fail(res, 'Usuario no encontrado.', 404);
    if (managedRole && existing.rows[0].rol !== managedRole) {
      return fail(res, 'Solo puedes editar usuarios del área que administras.', 403);
    }
    if (isTransitAdmin && !isTransitUser(existing.rows[0].rol, existing.rows[0].zona)) {
      return fail(res, 'Solo puedes editar usuarios de Operador o Pase en Ruta 11 o Ruta 86.', 403);
    }
    const duplicate = await pool.query('SELECT id FROM usuarios WHERE `user` = $1 AND id <> $2', [user, id]);
    if (duplicate.rowCount) return fail(res, 'El nombre de usuario ya está en uso por otro usuario.', 409);
    const values = [nombre, user, dni, text(req.body.telefono) || null, zona || null,
      ['aduana', 'pase'].includes(rol) ? destinoId : null, rol, id];
    const updateSql = pass
      ? `UPDATE usuarios SET nombre=$1, \`user\`=$2, dni=$3, telefono=$4, zona=$5,
           destino_id=$6, rol=$7, pass=$9 WHERE id=$8`
      : `UPDATE usuarios SET nombre=$1, \`user\`=$2, dni=$3, telefono=$4, zona=$5,
           destino_id=$6, rol=$7 WHERE id=$8`;
    if (pass) values.push(pass);
    const result = await pool.query(updateSql, values);
    if (!result.rowCount) return fail(res, 'Usuario no encontrado.', 404);
    return respond(res, true, 'Usuario actualizado.', { id });
  }
  return methodNotAllowed(res, ['GET', 'POST', 'PUT']);
}

async function roles(req, res, authenticate) {
  const method = methodOf(req);
  const requester = await requestUser(req, authenticate);
  if (!requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (method === 'PUT' && requester.rol !== 'admin') {
    return fail(res, 'Solo el administrador general puede gestionar roles.', 403);
  }
  if (method === 'GET') {
    const result = await pool.query('SELECT id, slug, nombre, logo_url, activo FROM roles ORDER BY nombre');
    return respond(res, true, 'Listado de roles.', result.rows);
  }
  if (method === 'PUT') {
    const id = positiveInt(req.body.id);
    const nombre = text(req.body.nombre);
    if (!id || !nombre) return fail(res, 'ID y nombre son obligatorios.', 422);
    const activo = req.body.activo === undefined ? true : Boolean(req.body.activo);
    const result = await pool.query('UPDATE roles SET nombre = $1, activo = $2 WHERE id = $3', [nombre, activo, id]);
    if (!result.rowCount) return fail(res, 'Rol no encontrado.', 404);
    return respond(res, true, 'Rol actualizado.', { id });
  }
  return methodNotAllowed(res, ['GET', 'PUT']);
}

async function updateTheme(req, res) {
  if (req.method !== 'PUT') return methodNotAllowed(res, ['PUT']);
  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
  const user = await authenticateChatToken(token);
  if (!user) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);

  const theme = text(req.body.tema_preferido);
  if (!temasValidos.includes(theme)) {
    return fail(res, 'El tema seleccionado no es válido.', 422);
  }
  const result = await pool.query(
    'UPDATE usuarios SET tema_preferido = $1 WHERE id = $2',
    [theme, user.id],
  );
  if (!result.rowCount) return fail(res, 'La sesión ya no es válida.', 401);
  return respond(res, true, 'Tema actualizado.', { tema_preferido: theme });
}

function qrLink(req, zonaId) {
  return {
    link: `${publicBaseUrl(req)}/qr/zona?zona_id=${zonaId}`,
    expires_at: new Date(Date.now() + Number(process.env.QR_LINK_VALID_SECONDS || 30) * 1000).toISOString(),
    seconds_valid: Number(process.env.QR_LINK_VALID_SECONDS || 30),
  };
}

async function zonas(req, res, authenticate) {
  const method = methodOf(req);
  const requester = await requestUser(req, authenticate);
  if (!requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (roleManagedBy(requester) && (method !== 'GET' || req.query.qr === '1')) {
    return fail(res, 'No tienes permiso para administrar zonas y QR.', 403);
  }
  if (method !== 'GET' && requester.rol !== 'admin') {
    return fail(res, 'Solo el administrador general puede modificar zonas.', 403);
  }
  if (method === 'GET') {
    if (req.query.qr === '1') {
      const id = positiveInt(req.query.id);
      if (!id) return fail(res, 'ID de zona obligatorio para generar el link QR.', 422);
      const zone = await pool.query('SELECT id FROM zonas WHERE id = $1', [id]);
      if (!zone.rowCount) return fail(res, 'Zona no encontrada.', 404);
      return respond(res, true, 'Link QR generado.', qrLink(req, id));
    }
    const result = await pool.query('SELECT id, nombre, logo_url FROM zonas ORDER BY nombre ASC');
    return respond(res, true, 'Listado de zonas.', result.rows);
  }
  if (method === 'POST') {
    const nombre = canonicalZoneName(req.body.nombre);
    if (!nombre) return fail(res, 'El nombre de la zona es obligatorio.', 422);
    const duplicate = await pool.query(
      'SELECT id FROM zonas WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1)) LIMIT 1', [nombre],
    );
    if (duplicate.rowCount) return fail(res, 'Ya existe una zona con ese nombre.', 409);
    try {
      const result = await pool.query('INSERT INTO zonas (nombre) VALUES ($1)', [nombre]);
      return respond(res, true, 'Zona creada.', { id: result.insertId, nombre }, 201);
    } catch (error) {
      return failDb(res, error, 'No se pudo crear la zona.');
    }
  }
  if (method === 'PUT') {
    const id = positiveInt(req.body.id);
    const nombre = canonicalZoneName(req.body.nombre);
    if (!id || !nombre) return fail(res, 'ID y nombre son obligatorios.', 422);
    const duplicate = await pool.query(
      'SELECT id FROM zonas WHERE LOWER(TRIM(nombre)) = LOWER(TRIM($1)) AND id <> $2 LIMIT 1', [nombre, id],
    );
    if (duplicate.rowCount) return fail(res, 'Ya existe otra zona con ese nombre.', 409);
    try {
      const previousName = await withTransaction(async (client) => {
        const current = await client.query('SELECT nombre FROM zonas WHERE id = $1 FOR UPDATE', [id]);
        if (!current.rowCount) return null;
        await client.query('UPDATE zonas SET nombre = $1 WHERE id = $2', [nombre, id]);
        await client.query(
          'UPDATE usuarios SET zona = $1 WHERE LOWER(TRIM(zona)) = LOWER(TRIM($2))',
          [nombre, current.rows[0].nombre],
        );
        return current.rows[0].nombre;
      });
      if (previousName === null) return fail(res, 'Zona no encontrada.', 404);
      return respond(res, true, 'Zona actualizada.', { id, nombre });
    } catch (error) {
      return failDb(res, error, 'No se pudo actualizar la zona.');
    }
  }
  if (method === 'DELETE') {
    const id = positiveInt(req.query.id ?? req.body.id);
    if (!id) return fail(res, 'ID de zona obligatorio.', 422);
    try {
      const deleted = await withTransaction(async (client) => {
        const zone = await client.query('SELECT nombre FROM zonas WHERE id = $1 FOR UPDATE', [id]);
        if (!zone.rowCount) return false;
        await client.query(
          'UPDATE usuarios SET zona = NULL WHERE LOWER(TRIM(zona)) = LOWER(TRIM($1))',
          [zone.rows[0].nombre],
        );
        await client.query('DELETE FROM zonas WHERE id = $1', [id]);
        return true;
      });
      if (!deleted) return fail(res, 'Zona no encontrada.', 404);
      return respond(res, true, 'Zona eliminada.', { id });
    } catch (error) {
      return failDb(res, error, 'No se pudo eliminar la zona.');
    }
  }
  return methodNotAllowed(res, ['GET', 'POST', 'PUT', 'DELETE']);
}

async function destinos(req, res, authenticate) {
  const requester = await requestUser(req, authenticate);
  if (!requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const result = await pool.query('SELECT id, nombre FROM destinos ORDER BY nombre ASC');
  return respond(res, true, 'Listado de destinos.', result.rows);
}

function imageExtension(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function saveLogo(req, res, authenticate) {
  upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'fondo', maxCount: 1 }])(
    req,
    res,
    async (uploadError) => {
      if (uploadError) {
        const message = uploadError.code === 'LIMIT_FILE_SIZE'
          ? 'La imagen debe pesar como máximo 2 MB.'
          : 'No se pudo procesar la imagen enviada.';
        return fail(res, message, 422);
      }
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST']);
      const requester = await requestUser(req, authenticate);
      if (!requester) return fail(res, 'La sesión expiró. Vuelve a iniciar sesión.', 401);
      const tipo = text(req.body.tipo).toLowerCase();
      const target = uploadTargets[tipo];
      const id = positiveInt(req.body.id);
      if (!target || !id) return fail(res, 'Tipo o ID inválido.', 422);
      const managedRole = roleManagedBy(requester);
      if (managedRole || requester.rol === 'admin_transito') {
        if (!['usuario', 'usuario_fondo'].includes(tipo)) {
          return fail(res, 'No tienes permiso para modificar esta imagen.', 403);
        }
        const targetUser = await pool.query('SELECT rol, zona FROM usuarios WHERE id = $1', [id]);
        const canManageTarget = targetUser.rowCount && (
          managedRole
            ? targetUser.rows[0].rol === managedRole
            : isTransitUser(targetUser.rows[0].rol, targetUser.rows[0].zona)
        );
        if (!canManageTarget) {
          return fail(res, 'Solo puedes modificar imágenes de usuarios de tu área.', 403);
        }
      } else if (requester.rol !== 'admin') {
        return fail(res, 'No tienes permiso para modificar imágenes.', 403);
      }
      const file = req.files?.[target.field]?.[0];
      if (!file) return fail(res, 'Debe enviar una imagen.', 422);
      const extension = imageExtension(file.buffer);
      if (!extension) return fail(res, 'Formato no permitido. Use JPG, PNG o WEBP.', 422);
      try {
        const directory = path.resolve(currentDir, `../uploads/${target.directory}`);
        await fs.mkdir(directory, { recursive: true });
        const filename = `${tipo}_${id}_${crypto.randomBytes(8).toString('hex')}.${extension}`;
        await fs.writeFile(path.join(directory, filename), file.buffer, { flag: 'wx' });
        const url = `${publicBaseUrl(req)}/uploads/${target.directory}/${filename}`;
        const result = await pool.query(
          `UPDATE ${target.table} SET ${target.column} = $1 WHERE id = $2`,
          [url, id],
        );
        if (!result.rowCount) return fail(res, 'Registro no encontrado.', 404);
        const data = target.column === 'fondo_url' ? { fondo_url: url } : { logo_url: url };
        return respond(
          res,
          true,
          target.column === 'fondo_url' ? 'Fondo actualizado.' : 'Logo actualizado.',
          data,
        );
      } catch (error) {
        console.error(error);
        return fail(res, 'No se pudo guardar la imagen.', 500);
      }
    },
  );
}

export function registerAccountRoutes(app, { authenticate = authenticateChatToken } = {}) {
  app.all('/api/auth/login', (req, res, next) => login(req, res).catch(next));
  app.all('/api/camioneros', (req, res, next) => camioneros(req, res, authenticate).catch(next));
  app.all('/api/usuarios', (req, res, next) => usuarios(req, res, authenticate).catch(next));
  app.all('/api/usuarios/tema', (req, res, next) => updateTheme(req, res).catch(next));
  app.all('/api/roles', (req, res, next) => roles(req, res, authenticate).catch(next));
  app.all('/api/zonas', (req, res, next) => zonas(req, res, authenticate).catch(next));
  app.all('/api/destinos', (req, res, next) => destinos(req, res, authenticate).catch(next));
  app.all('/api/logos', (req, res, next) => saveLogo(req, res, authenticate).catch(next));
}

export { integerFields };