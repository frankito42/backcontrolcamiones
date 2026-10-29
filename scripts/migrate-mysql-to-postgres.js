import '../src/config.js';
import mysql from 'mysql2/promise';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertDatabaseConfig, pool } from '../src/db.js';
import { seedReferenceData } from './seed-reference-data.js';

const tables = ['zonas', 'destinos', 'roles', 'usuarios', 'camioneros', 'turnos', 'turno_historial', 'qr_tokens'];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schema = await readFile(path.resolve(scriptDir, '../database/schema.sql'), 'utf8');
let source;

async function importTable(client, table) {
  const [sourceTables] = await source.query('SHOW TABLES LIKE ?', [table]);
  if (!sourceTables.length) {
    console.log(`${table}: no existe en MySQL, se omite.`);
    return 0;
  }

  assertDatabaseConfig();
  const targetColumns = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table],
  );
  const targetTypes = new Map(targetColumns.rows.map((column) => [column.column_name, column.data_type]));
  const sortColumn = table === 'qr_tokens' ? 'token' : 'id';
  const [sourceRows] = await source.query(`SELECT * FROM \`${table}\` ORDER BY \`${sortColumn}\``);
  if (!sourceRows.length) {
    console.log(`${table}: 0 filas.`);
    return 0;
  }

  const columns = Object.keys(sourceRows[0]).filter((column) => targetTypes.has(column));
  if (!columns.length) throw new Error(`No hay columnas comunes para importar ${table}.`);
  const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
  const insert = `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
  let copied = 0;

  await client.query('BEGIN');
  try {
    for (const row of sourceRows) {
      const values = columns.map((column) => {
        const value = row[column];
        if (targetTypes.get(column) === 'boolean' && value !== null) return Boolean(Number(value));
        return value;
      });
      const result = await client.query(insert, values);
      copied += result.rowCount;
    }

    if (targetTypes.has('id') && targetColumns.rows.some((column) => column.column_name === 'id')) {
      const maxId = await client.query(`SELECT MAX(id) AS max_id FROM "${table}"`);
      const max = Number(maxId.rows[0].max_id || 0);
      if (max > 0) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, 'id'), $2, TRUE)`, [`${table}`, max],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  console.log(`${table}: ${copied}/${sourceRows.length} filas insertadas.`);
  return copied;
}

try {
  assertDatabaseConfig();
  source = await mysql.createConnection({
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    database: process.env.MYSQL_DATABASE || 'turnos_camiones',
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    charset: 'utf8mb4',
  });
  await pool.query(schema);
  console.log('Esquema PostgreSQL preparado.');
  const client = await pool.connect();
  try {
    for (const table of tables) await importTable(client, table);
    await seedReferenceData(client);
  } finally {
    client.release();
  }
  console.log('Migración finalizada. Las filas existentes en PostgreSQL no se sobrescribieron.');
} catch (error) {
  console.error('Migración detenida:', error.message);
  process.exitCode = 1;
} finally {
  if (source) await source.end().catch(() => {});
  await pool.end();
}