export async function seedReferenceData(client) {
  await client.query(
    `INSERT IGNORE INTO roles (slug, nombre) VALUES
     ('admin','Administrador'),('admin_aduana','Administrador de Aduana'),
     ('admin_defiba','Administrador de Defiba'),('admin_transito','Administrador de Tránsito'),
     ('operador','Operador'),('pase','Operador de Pase'),
     ('defiba','Usuario Defiba'),('aduana','Aduana')`,
  );
  await client.query(
    `INSERT IGNORE INTO zonas (nombre) VALUES ('Defiba'), ('Aduana')`,
  );
  await client.query(
    `INSERT IGNORE INTO destinos (nombre) VALUES ('Aduana Falcon'), ('Aduana Pilcomayo')`,
  );
}