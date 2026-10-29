export function compileMysqlQuery(sql, values = []) {
  const normalized = sql;
  const arrayMarker = /([A-Za-z_][A-Za-z0-9_.]*)\s+IN\s*\(\s*\$(\d+)\s*\)/gi;
  const expanded = normalized.replace(arrayMarker, (_match, column, indexText) => {
    const array = values[Number(indexText) - 1];
    if (!Array.isArray(array)) {
      throw new TypeError(`El parámetro $${indexText} de IN debe ser un arreglo.`);
    }
    if (array.length === 0) return `${column} IN (NULL)`;
    return `${column} IN (${array.map((_, index) => `__array_${indexText}_${index}__`).join(', ')})`;
  });

  const parameters = [];
  const statement = expanded.replace(/\$(\d+)|__array_(\d+)_(\d+)__/g, (_match, index, arrayIndex, elementIndex) => {
    if (index) {
      const position = Number(index) - 1;
      if (position < 0 || position >= values.length) {
        throw new RangeError(`Falta el parámetro $${index} de la consulta.`);
      }
      parameters.push(values[position]);
    } else {
      const array = values[Number(arrayIndex) - 1];
      parameters.push(array[Number(elementIndex)]);
    }
    return '?';
  });

  return { sql: statement, values: parameters };
}

function splitStatements(sql) {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function adaptResult(result) {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  return {
    rows: [],
    rowCount: result.affectedRows ?? 0,
    insertId: result.insertId,
    command: result.command,
  };
}

export function createMysqlPoolAdapter(mysqlPool) {
  async function runQuery(connection, sql, values = []) {
    const statements = values.length ? [sql] : splitStatements(sql);
    let adapted;
    for (const statement of statements) {
      if (!statement) continue;
      const compiled = compileMysqlQuery(statement, values);
      const [result] = await connection.query(compiled.sql, compiled.values);
      adapted = adaptResult(result);
    }
    return adapted || { rows: [], rowCount: 0 };
  }

  return {
    query: (sql, values) => runQuery(mysqlPool, sql, values),
    async connect() {
      const connection = await mysqlPool.getConnection();
      return {
        query: (sql, values) => runQuery(connection, sql, values),
        release: () => connection.release(),
      };
    },
    end: () => mysqlPool.end(),
    on: (...args) => mysqlPool.on(...args),
  };
}
