import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMysqlQuery, createMysqlPoolAdapter } from '../src/mysql-dialect.js';

test('compiles positional placeholders in the correct order', () => {
  const compiled = compileMysqlQuery(
    'SELECT * FROM usuarios WHERE id = $2 AND rol = $1 AND zona = $2',
    ['operador', 17],
  );
  assert.deepEqual(compiled, {
    sql: 'SELECT * FROM usuarios WHERE id = ? AND rol = ? AND zona = ?',
    values: [17, 'operador', 17],
  });
});

test('expands array comparisons and preserves values after the array', () => {
  const compiled = compileMysqlQuery(
    'SELECT id FROM turnos WHERE id IN ($1) AND estado = $2',
    [[4, 8, 15], 'reservado'],
  );
  assert.deepEqual(compiled, {
    sql: 'SELECT id FROM turnos WHERE id IN (?, ?, ?) AND estado = ?',
    values: [4, 8, 15, 'reservado'],
  });
});

test('compiles empty array comparisons to a match-nothing predicate', () => {
  const compiled = compileMysqlQuery(
    'SELECT id FROM turnos WHERE id IN ($1)',
    [[]],
  );
  assert.deepEqual(compiled, {
    sql: 'SELECT id FROM turnos WHERE id IN (NULL)',
    values: [],
  });
});

test('preserves MySQL upserts and case-insensitive search queries', () => {
  const compiled = compileMysqlQuery(
    `INSERT INTO pase_libre_destinos (destino_id, activo)
     VALUES ($1, $2)
     ON DUPLICATE KEY UPDATE activo = VALUES(activo)`,
    [5, true],
  );
  assert.equal(
    compiled.sql,
    `INSERT INTO pase_libre_destinos (destino_id, activo)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE activo = VALUES(activo)`,
  );
  assert.deepEqual(compiled.values, [5, true]);

  const search = compileMysqlQuery('SELECT id FROM camioneros WHERE LOWER(nombre) LIKE LOWER($1)', ['%ana%']);
  assert.deepEqual(search, {
    sql: 'SELECT id FROM camioneros WHERE LOWER(nombre) LIKE LOWER(?)',
    values: ['%ana%'],
  });
});

test('preserves MySQL date arithmetic expressions', () => {
  const compiled = compileMysqlQuery(
    `SELECT DATE_ADD(CURRENT_TIMESTAMP, INTERVAL $1 DAY),
            DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`,
    [30],
  );
  assert.deepEqual(compiled, {
    sql: `SELECT DATE_ADD(CURRENT_TIMESTAMP, INTERVAL ? DAY),
            DATE_SUB(CURRENT_TIMESTAMP, INTERVAL 10 MINUTE)`,
    values: [30],
  });
});

test('preserves WHERE clauses while executing regular SELECT statements', async () => {
  const statements = [];
  const mysqlPool = {
    async query(sql, values) {
      statements.push({ sql, values });
      return [[{ id: 1 }], []];
    },
    async end() {},
    on() {},
  };
  const pool = createMysqlPoolAdapter(mysqlPool);
  const result = await pool.query('SELECT id FROM usuarios WHERE id = $1', [1]);

  assert.deepEqual(statements, [{
    sql: 'SELECT id FROM usuarios WHERE id = ?',
    values: [1],
  }]);
  assert.deepEqual(result, { rows: [{ id: 1 }], rowCount: 1 });
});

test('executes native MySQL schema statements without translation', async () => {
  const statements = [];
  const mysqlPool = {
    async query(sql, values) {
      statements.push({ sql, values });
      return [{ affectedRows: 0 }, []];
    },
    async end() {},
    on() {},
  };
  const pool = createMysqlPoolAdapter(mysqlPool);
  await pool.query(`CREATE TABLE IF NOT EXISTS sample (
    id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    created_at DATETIME(3) NOT NULL,
    KEY idx_sample (id)
  ) ENGINE=InnoDB;`);

  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /id INT NOT NULL AUTO_INCREMENT PRIMARY KEY/);
  assert.match(statements[0].sql, /created_at DATETIME\(3\) NOT NULL/);
  assert.match(statements[0].sql, /KEY idx_sample \(id\)/);
});
