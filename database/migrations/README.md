# Migraciones de base de datos

Esta carpeta está reservada para migraciones versionadas de la base MySQL
destino de Hostinger. El backend actual continúa conectado a PostgreSQL; crear
esta carpeta no cambia el motor ni copia datos.

## Convenciones

- Nombrar cada migración con versión y descripción, por ejemplo
  `20261029120000_agregar_indice_productos.sql`.
- Una migración aplicada es inmutable. Los cambios posteriores van en un archivo
  nuevo.
- Escribir SQL compatible con la versión de MySQL de Hostinger y considerar
  explícitamente si la operación conserva o transforma los datos existentes.
- Antes de aplicar una migración real, revisar el SQL, confirmar backup y validar
  los resultados. No ejecutar cambios sobre la base de producción sin pedido
  explícito.
- No aplicar automáticamente estos archivos al iniciar el servidor. Se ejecutan
  únicamente cuando se solicite la migración correspondiente.

Todavía no hay migraciones ejecutables en esta carpeta.
