import '../src/config.js';
import pg from 'pg';
import { assertDatabaseConfig } from '../src/db.js';

let client;

try {
  assertDatabaseConfig();
  const target = new URL(process.env.DATABASE_URL);
  const database = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('El nombre de base en DATABASE_URL solo puede contener letras, números y guion bajo.');
  }

  target.pathname = '/postgres';
  client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (exists.rowCount) {
    console.log(`La base ${database} ya existe; no se modificó.`);
  } else {
    await client.query(`CREATE DATABASE "${database}"`);
    console.log(`Base ${database} creada.`);
  }
} catch (error) {
  console.error('No se pudo preparar la base PostgreSQL:', error.message);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}