import './config.js';
import pg from 'pg';

const { Pool, types } = pg;

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(1082, (value) => value);
types.setTypeParser(1083, (value) => value);

const ssl = process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false;

export function assertDatabaseConfig() {
  const connectionString = process.env.DATABASE_URL?.trim();
  const separatePassword = process.env.PGPASSWORD;
  if (!connectionString && separatePassword === undefined) {
    throw new Error('Falta DATABASE_URL. Copia .env.example a .env y configura las credenciales de PostgreSQL.');
  }
  if (connectionString) {
    let parsed;
    try {
      parsed = new URL(connectionString);
    } catch {
      throw new Error('DATABASE_URL no es válida. Usa postgresql://usuario:contraseña@host:5432/base.');
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('DATABASE_URL debe usar el protocolo postgresql://.');
    }
    if (!parsed.password && separatePassword === undefined) {
      throw new Error('DATABASE_URL no incluye contraseña. Usa postgresql://usuario:contraseña@host:5432/base o define PGPASSWORD.');
    }
  }
}

const poolConfig = {
  ...(process.env.DATABASE_URL?.trim() ? { connectionString: process.env.DATABASE_URL.trim() } : {}),
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  ssl,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};
if (process.env.PGPASSWORD !== undefined) poolConfig.password = process.env.PGPASSWORD;

export const pool = new Pool(poolConfig);

pool.on('error', (error) => {
  console.error('Error inesperado del pool PostgreSQL:', error.message);
});

export async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}