import '../src/config.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

function assertPostgresConfig() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString && !process.env.PGPASSWORD) {
    throw new Error('Falta configurar DATABASE_URL para acceder a la base PostgreSQL histórica.');
  }
  if (connectionString) {
    let parsed;
    try {
      parsed = new URL(connectionString);
    } catch {
      throw new Error('DATABASE_URL no es válida para PostgreSQL.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('DATABASE_URL debe apuntar a PostgreSQL.');
    }
  }
}

const pool = new Pool({
  ...(process.env.DATABASE_URL?.trim()
    ? { connectionString: process.env.DATABASE_URL.trim() }
    : {}),
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const tables = [
  {
    name: 'zonas',
    columns: ['id', 'nombre', 'logo_url', 'creado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`zonas\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`nombre\` VARCHAR(80) NOT NULL,
  \`logo_url\` VARCHAR(500) NULL,
  \`creado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_zonas_nombre\` (\`nombre\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'destinos',
    columns: ['id', 'nombre', 'creado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`destinos\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`nombre\` VARCHAR(120) NOT NULL,
  \`creado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_destinos_nombre\` (\`nombre\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'roles',
    columns: ['id', 'slug', 'nombre', 'logo_url', 'activo', 'creado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`roles\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`slug\` VARCHAR(30) NOT NULL,
  \`nombre\` VARCHAR(80) NOT NULL,
  \`logo_url\` VARCHAR(500) NULL,
  \`activo\` TINYINT(1) NOT NULL DEFAULT 1,
  \`creado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_roles_slug\` (\`slug\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'usuarios',
    columns: [
      'id', 'nombre', 'user', 'dni', 'telefono', 'zona', 'destino_id', 'pass',
      'rol', 'logo_url', 'fondo_url', 'tema_preferido', 'creado_en',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`usuarios\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`nombre\` VARCHAR(120) NOT NULL,
  \`user\` VARCHAR(60) NOT NULL,
  \`dni\` VARCHAR(20) NOT NULL,
  \`telefono\` VARCHAR(30) NULL,
  \`zona\` VARCHAR(80) NULL,
  \`destino_id\` INT NULL,
  \`pass\` VARCHAR(120) NOT NULL,
  \`rol\` VARCHAR(30) NOT NULL DEFAULT 'operador',
  \`logo_url\` VARCHAR(500) NULL,
  \`fondo_url\` VARCHAR(500) NULL,
  \`tema_preferido\` VARCHAR(30) NOT NULL DEFAULT 'oscuro',
  \`creado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_usuarios_user\` (\`user\`),
  KEY \`idx_usuarios_destino_id\` (\`destino_id\`),
  CONSTRAINT \`chk_usuarios_rol\` CHECK (\`rol\` IN ('admin', 'admin_aduana', 'admin_defiba', 'admin_transito', 'operador', 'pase', 'defiba', 'aduana')),
  CONSTRAINT \`chk_usuarios_tema\` CHECK (\`tema_preferido\` IN ('oscuro', 'claro', 'azul_marino', 'azul_claro')),
  CONSTRAINT \`fk_usuarios_destino\` FOREIGN KEY (\`destino_id\`)
    REFERENCES \`destinos\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'pase_libre_destinos',
    columns: ['destino_id', 'activo', 'actualizado_por', 'actualizado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`pase_libre_destinos\` (
  \`destino_id\` INT NOT NULL,
  \`activo\` TINYINT(1) NOT NULL DEFAULT 0,
  \`actualizado_por\` INT NULL,
  \`actualizado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`destino_id\`),
  CONSTRAINT \`fk_pase_libre_destinos_destino\` FOREIGN KEY (\`destino_id\`)
    REFERENCES \`destinos\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`fk_pase_libre_destinos_usuario\` FOREIGN KEY (\`actualizado_por\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'pase_libre_estado',
    columns: ['id', 'activo', 'actualizado_por', 'actualizado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`pase_libre_estado\` (
  \`id\` SMALLINT NOT NULL,
  \`activo\` TINYINT(1) NOT NULL DEFAULT 0,
  \`actualizado_por\` INT NULL,
  \`actualizado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  CONSTRAINT \`chk_pase_libre_estado_id\` CHECK (\`id\` = 1),
  CONSTRAINT \`fk_pase_libre_estado_usuario\` FOREIGN KEY (\`actualizado_por\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'camioneros',
    columns: ['id', 'nombre', 'dni', 'patente', 'telefono', 'creado_en'],
    definition: `CREATE TABLE IF NOT EXISTS \`camioneros\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`nombre\` VARCHAR(120) NOT NULL,
  \`dni\` VARCHAR(20) NOT NULL,
  \`patente\` VARCHAR(20) NOT NULL,
  \`telefono\` VARCHAR(30) NULL,
  \`creado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_camioneros_dni\` (\`dni\`),
  KEY \`idx_camioneros_patente\` (\`patente\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'turnos',
    columns: [
      'id', 'numero', 'camionero_id', 'patente', 'empresa', 'mercaderia',
      'mercaderia_vacia', 'fecha_ingreso', 'hora_ingreso', 'estado', 'origen',
      'numero_operacion', 'prioridad', 'usuario_id', 'usuario_pase_id', 'zona_id',
      'destino_id', 'aduana_confirmado', 'aduana_confirmado_en', 'estado_aduana',
      'defiba_aviso_confirmado', 'operador_aduana_aviso_confirmado',
      'bocina_pendiente', 'bocina_pendiente_en', 'bocina_procesando',
      'bocina_reclamada_en', 'creada_en',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`turnos\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`numero\` INT NULL,
  \`camionero_id\` INT NOT NULL,
  \`patente\` VARCHAR(20) NOT NULL,
  \`empresa\` VARCHAR(120) NULL,
  \`mercaderia\` TEXT NULL,
  \`mercaderia_vacia\` TINYINT(1) NOT NULL DEFAULT 0,
  \`fecha_ingreso\` DATE NOT NULL DEFAULT (CURRENT_DATE),
  \`hora_ingreso\` TIME NOT NULL DEFAULT (CURRENT_TIME),
  \`estado\` VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  \`origen\` VARCHAR(20) NOT NULL DEFAULT 'normal',
  \`numero_operacion\` VARCHAR(80) NULL,
  \`prioridad\` VARCHAR(20) NULL,
  \`usuario_id\` INT NULL,
  \`usuario_pase_id\` INT NULL,
  \`zona_id\` INT NOT NULL,
  \`destino_id\` INT NULL,
  \`aduana_confirmado\` TINYINT(1) NOT NULL DEFAULT 0,
  \`aduana_confirmado_en\` DATETIME(3) NULL,
  \`estado_aduana\` VARCHAR(20) NULL,
  \`defiba_aviso_confirmado\` TINYINT(1) NOT NULL DEFAULT 0,
  \`operador_aduana_aviso_confirmado\` TINYINT(1) NOT NULL DEFAULT 0,
  \`bocina_pendiente\` TINYINT(1) NOT NULL DEFAULT 0,
  \`bocina_pendiente_en\` DATETIME(3) NULL,
  \`bocina_procesando\` TINYINT(1) NOT NULL DEFAULT 0,
  \`bocina_reclamada_en\` DATETIME(3) NULL,
  \`creada_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`uq_turnos_zona_numero\` (\`zona_id\`, \`numero\`),
  KEY \`idx_turnos_patente\` (\`patente\`),
  KEY \`idx_turnos_camionero_estado\` (\`camionero_id\`, \`estado\`),
  KEY \`idx_turnos_estado_fecha\` (\`estado\`, \`fecha_ingreso\`, \`hora_ingreso\`),
  KEY \`idx_turnos_zona_estado_fecha\` (\`zona_id\`, \`estado\`, \`fecha_ingreso\`, \`hora_ingreso\`),
  KEY \`idx_turnos_estado_numero\` (\`estado\`, \`numero\`),
  KEY \`idx_turnos_numero\` (\`numero\`),
  KEY \`idx_turnos_bocina_queue\` (\`bocina_pendiente_en\`, \`id\`),
  CONSTRAINT \`chk_turnos_estado\` CHECK (\`estado\` IN ('pendiente', 'en_curso', 'finalizado', 'reservado', 'listo_para_salir', 'anulado')),
  CONSTRAINT \`fk_turnos_camionero\` FOREIGN KEY (\`camionero_id\`)
    REFERENCES \`camioneros\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT \`fk_turnos_usuario\` FOREIGN KEY (\`usuario_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT \`fk_turnos_usuario_pase\` FOREIGN KEY (\`usuario_pase_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT \`fk_turnos_zona\` FOREIGN KEY (\`zona_id\`)
    REFERENCES \`zonas\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT \`fk_turnos_destino\` FOREIGN KEY (\`destino_id\`)
    REFERENCES \`destinos\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'turno_historial',
    columns: [
      'id', 'turno_id', 'zona_id', 'estado', 'evento', 'usuario_id', 'origen',
      'registrado_en',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`turno_historial\` (
  \`id\` BIGINT NOT NULL AUTO_INCREMENT,
  \`turno_id\` INT NOT NULL,
  \`zona_id\` INT NOT NULL,
  \`estado\` VARCHAR(30) NOT NULL,
  \`evento\` VARCHAR(30) NOT NULL DEFAULT 'estado',
  \`usuario_id\` INT NULL,
  \`origen\` VARCHAR(30) NOT NULL DEFAULT 'sistema',
  \`registrado_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_historial_turno_fecha\` (\`turno_id\`, \`registrado_en\`),
  KEY \`idx_historial_zona_estado\` (\`zona_id\`, \`estado\`, \`registrado_en\`),
  KEY \`idx_historial_evento_turno\` (\`evento\`, \`turno_id\`),
  CONSTRAINT \`chk_historial_estado\` CHECK (\`estado\` IN ('pendiente', 'en_curso', 'finalizado', 'reservado', 'listo_para_salir', 'anulado')),
  CONSTRAINT \`fk_historial_turno\` FOREIGN KEY (\`turno_id\`)
    REFERENCES \`turnos\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT \`fk_historial_zona\` FOREIGN KEY (\`zona_id\`)
    REFERENCES \`zonas\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT \`fk_historial_usuario\` FOREIGN KEY (\`usuario_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'cargas_especiales',
    columns: [
      'id', 'patente', 'zona_id', 'destino_id', 'estado', 'usuario_id',
      'creada_en',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`cargas_especiales\` (
  \`id\` INT NOT NULL AUTO_INCREMENT,
  \`patente\` VARCHAR(20) NOT NULL,
  \`zona_id\` INT NOT NULL,
  \`destino_id\` INT NOT NULL,
  \`estado\` VARCHAR(20) NOT NULL DEFAULT 'en_camino',
  \`usuario_id\` INT NULL,
  \`creada_en\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`id\`),
  KEY \`idx_cargas_especiales_zona_estado_fecha\` (\`zona_id\`, \`estado\`, \`creada_en\`),
  CONSTRAINT \`chk_cargas_especiales_estado\` CHECK (\`estado\` IN ('en_camino', 'finalizado')),
  CONSTRAINT \`fk_cargas_especiales_zona\` FOREIGN KEY (\`zona_id\`)
    REFERENCES \`zonas\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT \`fk_cargas_especiales_destino\` FOREIGN KEY (\`destino_id\`)
    REFERENCES \`destinos\` (\`id\`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT \`fk_cargas_especiales_usuario\` FOREIGN KEY (\`usuario_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'qr_tokens',
    columns: [
      'token', 'zona_id', 'expires_at', 'used', 'created_at', 'claimed_at',
      'used_at',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`qr_tokens\` (
  \`token\` CHAR(32) NOT NULL,
  \`zona_id\` INT NOT NULL,
  \`expires_at\` BIGINT NOT NULL,
  \`used\` TINYINT(1) NOT NULL DEFAULT 0,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`claimed_at\` DATETIME(3) NULL,
  \`used_at\` DATETIME(3) NULL,
  PRIMARY KEY (\`token\`),
  CONSTRAINT \`fk_qr_tokens_zona\` FOREIGN KEY (\`zona_id\`)
    REFERENCES \`zonas\` (\`id\`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'chat_sessions',
    columns: [
      'token_hash', 'usuario_id', 'created_at', 'expires_at', 'revoked_at',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`chat_sessions\` (
  \`token_hash\` CHAR(64) NOT NULL,
  \`usuario_id\` INT NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`expires_at\` DATETIME(3) NOT NULL,
  \`revoked_at\` DATETIME(3) NULL,
  PRIMARY KEY (\`token_hash\`),
  KEY \`idx_chat_sessions_user\` (\`usuario_id\`, \`expires_at\`),
  CONSTRAINT \`fk_chat_sessions_usuario\` FOREIGN KEY (\`usuario_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'chat_messages',
    columns: [
      'id', 'sender_id', 'recipient_id', 'content', 'created_at',
      'delivered_at', 'read_at',
    ],
    definition: `CREATE TABLE IF NOT EXISTS \`chat_messages\` (
  \`id\` BIGINT NOT NULL AUTO_INCREMENT,
  \`sender_id\` INT NOT NULL,
  \`recipient_id\` INT NOT NULL,
  \`content\` VARCHAR(2000) NOT NULL,
  \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  \`delivered_at\` DATETIME(3) NULL,
  \`read_at\` DATETIME(3) NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_chat_messages_conversation\` (\`sender_id\`, \`recipient_id\`, \`id\` DESC),
  KEY \`idx_chat_messages_unread\` (\`recipient_id\`, \`sender_id\`, \`id\` DESC),
  CONSTRAINT \`chk_chat_messages_content\` CHECK (CHAR_LENGTH(TRIM(\`content\`)) > 0),
  CONSTRAINT \`fk_chat_messages_sender\` FOREIGN KEY (\`sender_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_chat_messages_recipient\` FOREIGN KEY (\`recipient_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
  {
    name: 'push_notification_devices',
    columns: ['token', 'usuario_id', 'session_token_hash', 'updated_at'],
    definition: `CREATE TABLE IF NOT EXISTS \`push_notification_devices\` (
  \`token\` VARCHAR(700) NOT NULL,
  \`usuario_id\` INT NOT NULL,
  \`session_token_hash\` CHAR(64) NOT NULL,
  \`updated_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (\`token\`),
  KEY \`idx_push_notification_devices_user\` (\`usuario_id\`, \`session_token_hash\`),
  CONSTRAINT \`fk_push_notification_devices_usuario\` FOREIGN KEY (\`usuario_id\`)
    REFERENCES \`usuarios\` (\`id\`) ON DELETE CASCADE,
  CONSTRAINT \`fk_push_notification_devices_session\` FOREIGN KEY (\`session_token_hash\`)
    REFERENCES \`chat_sessions\` (\`token_hash\`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`,
  },
];

function mysqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Dato numérico no válido en origen.');
    return String(value);
  }
  const text = value instanceof Date
    ? value.toISOString().replace('T', ' ').replace('Z', '')
    : String(value);
  return `CONVERT(X'${Buffer.from(text, 'utf8').toString('hex')}' USING utf8mb4)`;
}

async function main() {
  assertPostgresConfig();
  const sourceTables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const expectedTableNames = new Set(tables.map((table) => table.name));
  const unexpectedTables = sourceTables.rows
    .map((row) => row.table_name)
    .filter((name) => !expectedTableNames.has(name));
  const missingTables = [...expectedTableNames].filter(
    (name) => !sourceTables.rows.some((row) => row.table_name === name),
  );
  if (unexpectedTables.length || missingTables.length) {
    throw new Error(
      `Esquema PostgreSQL no cubierto por completo. ` +
      `Tablas nuevas: ${unexpectedTables.join(', ') || 'ninguna'}; ` +
      `tablas esperadas ausentes: ${missingTables.join(', ') || 'ninguna'}.`,
    );
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const outputDir = path.resolve(scriptDir, '../database/migrations/exports');
  const outputPath = path.join(outputDir, 'turnos_camiones_hostinger.sql');
  const contents = [
    '-- Exportación completa PostgreSQL -> MySQL/MariaDB.',
    `-- Incluye las ${tables.length} tablas del esquema activo y sus datos.`,
    '-- Contiene datos personales y credenciales/tokens: proteger y eliminar tras importar.',
    '-- Importar en una base vacía; no elimina ni reemplaza tablas existentes.',
    'SET NAMES utf8mb4;',
    "SET time_zone = '+00:00';",
    'SET FOREIGN_KEY_CHECKS = 0;',
    ...tables.map((table) => table.definition),
    'START TRANSACTION;',
  ];
  const counts = {};

  for (const table of tables) {
    const result = await pool.query(
      `SELECT ${table.columns.map((column) => `"${column}"`).join(', ')}
       FROM "${table.name}" ORDER BY "${table.columns[0]}"`,
    );
    counts[table.name] = result.rowCount;
    if (table.name === 'push_notification_devices') {
      const tooLongToken = result.rows.find((row) => row.token.length > 700);
      if (tooLongToken) {
        throw new Error(
          'Hay un token push de más de 700 caracteres, no se puede representar ' +
          'sin pérdida en la clave primaria MySQL definida.',
        );
      }
    }
    if (!result.rows.length) continue;

    const columns = table.columns.map((column) => `\`${column}\``).join(', ');
    const values = result.rows.map((row) => (
      `(${table.columns.map((column) => mysqlValue(row[column])).join(', ')})`
    ));
    contents.push(
      `INSERT INTO \`${table.name}\` (${columns}) VALUES\n${values.join(',\n')};`,
    );
  }

  contents.push(
    'COMMIT;',
    'SET FOREIGN_KEY_CHECKS = 1;',
    '',
  );
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, contents.join('\n\n'), 'utf8');
  console.log(`Exportación MySQL completa creada: ${outputPath}`);
  console.log(`Tablas exportadas: ${tables.length}`);
  console.log(`Filas exportadas: ${JSON.stringify(counts)}`);
}

try {
  await main();
} catch (error) {
  console.error('No se pudo crear la exportación MySQL:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
