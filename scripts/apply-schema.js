import '../src/config.js';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assertDatabaseConfig, pool } from '../src/db.js';
import { seedReferenceData } from './seed-reference-data.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const schema = await readFile(path.resolve(scriptDir, '../database/schema.sql'), 'utf8');

try {
  assertDatabaseConfig();
  await pool.query(schema);
  await seedReferenceData(pool);
  console.log('Esquema MySQL aplicado.');
} catch (error) {
  console.error('No se pudo aplicar el esquema:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}