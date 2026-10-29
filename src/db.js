import './config.js';
import mysql from 'mysql2/promise';
import { createMysqlPoolAdapter } from './mysql-dialect.js';

export function assertDatabaseConfig() {
  const required = ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD'];
  const missing = required.filter((key) => process.env[key] === undefined || process.env[key] === '');
  if (missing.length) {
    throw new Error(`Falta configurar MySQL en .env: ${missing.join(', ')}.`);
  }
}

assertDatabaseConfig();

const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: Number(process.env.MYSQL_PORT || 3306),
  database: process.env.MYSQL_DATABASE,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_MAX || 10),
  connectTimeout: 10_000,
  flags: ['FOUND_ROWS'],
  dateStrings: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  typeCast(field, next) {
    if (field.type === 'TINY' && field.length === 1) {
      const value = field.string();
      return value === null ? null : value === '1';
    }
    return next();
  },
});

export const pool = createMysqlPoolAdapter(mysqlPool);

pool.on('error', (error) => {
  console.error('Error inesperado del pool MySQL:', error.message);
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