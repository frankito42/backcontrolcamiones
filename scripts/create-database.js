import '../src/config.js';
import mysql from 'mysql2/promise';
import { assertDatabaseConfig } from '../src/db.js';

let connection;

try {
  assertDatabaseConfig();
  const database = process.env.MYSQL_DATABASE;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
    throw new Error('MYSQL_DATABASE solo puede contener letras, números y guion bajo.');
  }

  connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    charset: 'utf8mb4',
  });
  const [exists] = await connection.query(
    'SELECT 1 FROM information_schema.schemata WHERE schema_name = ?',
    [database],
  );
  if (exists.length) {
    console.log(`La base ${database} ya existe; no se modificó.`);
  } else {
    await connection.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`Base ${database} creada.`);
  }
} catch (error) {
  console.error('No se pudo preparar la base MySQL:', error.message);
  process.exitCode = 1;
} finally {
  if (connection) await connection.end();
}