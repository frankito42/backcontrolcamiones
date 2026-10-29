export async function seedReferenceData(client) {
  await client.query(
    `INSERT INTO roles (slug, nombre) VALUES
     ('admin','Administrador'),('admin_aduana','Administrador de Aduana'),
     ('admin_defiba','Administrador de Defiba'),('admin_transito','Administrador de Tránsito'),
     ('operador','Operador'),('pase','Operador de Pase'),
     ('defiba','Usuario Defiba'),('aduana','Aduana') ON CONFLICT (slug) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO zonas (nombre)
     SELECT reference.nombre FROM (VALUES ('Defiba'), ('Aduana')) AS reference(nombre)
     WHERE NOT EXISTS (
       SELECT 1 FROM zonas existing WHERE LOWER(BTRIM(existing.nombre)) = LOWER(BTRIM(reference.nombre))
     )
     ON CONFLICT (nombre) DO NOTHING`,
  );
  await client.query(
    `INSERT INTO destinos (nombre) VALUES ('Aduana Falcon'), ('Aduana Pilcomayo')
     ON CONFLICT (nombre) DO NOTHING`,
  );
}