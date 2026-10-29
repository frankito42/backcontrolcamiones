import '../src/config.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { assertDatabaseConfig, pool } from '../src/db.js';

const tablasPreservadas = ['usuarios', 'roles', 'zonas', 'destinos'];
const argumentoConfirmacion = process.argv
  .slice(2)
  .find((argumento) => argumento.startsWith('--confirm-database='));
const identificador = (value) => `"${value.replaceAll('"', '""')}"`;

async function main() {
  if ((!stdin.isTTY || !stdout.isTTY) && argumentoConfirmacion === undefined) {
    throw new Error(
      'Por seguridad, este script requiere una terminal interactiva o --confirm-database=<nombre exacto de la base>.',
    );
  }

  assertDatabaseConfig();
  const databaseResult = await pool.query('SELECT current_database() AS nombre');
  const database = databaseResult.rows[0]?.nombre;
  if (!database) throw new Error('No se pudo determinar la base conectada.');

  const tablesResult = await pool.query(
    `SELECT tablename
     FROM pg_catalog.pg_tables
     WHERE schemaname = 'public'
     ORDER BY tablename`,
  );
  const tablas = tablesResult.rows.map((row) => row.tablename);
  const faltantes = tablasPreservadas.filter((table) => !tablas.includes(table));
  if (faltantes.length) {
    throw new Error(
      `Faltan tablas de configuración esperadas: ${faltantes.join(', ')}. No se modificó la base.`,
    );
  }

  const tablasALimpiar = tablas.filter((table) => !tablasPreservadas.includes(table));
  if (!tablasALimpiar.length) {
    console.log('No hay tablas operativas para vaciar.');
    return;
  }

  console.log(`Base conectada: ${database}`);
  console.log(`Se preservarán, sin cambios: ${tablasPreservadas.join(', ')}`);
  console.log('Se vaciarán estas tablas (sus estructuras permanecerán):');
  for (const table of tablasALimpiar) console.log(`  - ${table}`);
  console.log('Las identidades/autonuméricos de las tablas vaciadas se reiniciarán.');
  console.log('No se usa CASCADE; si existen dependencias externas, se abortará sin cambios.');

  if (argumentoConfirmacion !== undefined) {
    const databaseConfirmation = argumentoConfirmacion.slice(
      '--confirm-database='.length,
    );
    if (databaseConfirmation !== database) {
      throw new Error(
        `La base confirmada (${databaseConfirmation}) no coincide con la base conectada (${database}). No se modificó la base.`,
      );
    }
    console.log(`Confirmación explícita recibida para la base ${database}.`);
  } else {
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const confirmation = await readline.question(
        `Para continuar, escribí exactamente VACIAR ${database}: `,
      );
      if (confirmation !== `VACIAR ${database}`) {
        console.log('Confirmación incorrecta. No se modificó la base.');
        return;
      }
    } finally {
      readline.close();
    }
  }

  const list = tablasALimpiar
    .map((table) => `public.${identificador(table)}`)
    .join(', ');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      await client.query(`TRUNCATE TABLE ${list} RESTART IDENTITY`);
      await client.query('COMMIT');
      console.log(
        `Limpieza completada en ${database}. Se preservaron ${tablasPreservadas.join(', ')}.`,
      );
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('También falló el rollback de la transacción:', rollbackError.message);
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

try {
  await main();
} catch (error) {
  console.error('No se pudo limpiar la base:', error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
