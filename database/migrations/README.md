# Migraciones de base de datos

Esta carpeta contiene los volcados MySQL para Hostinger. El backend Node activo
usa únicamente MySQL/MariaDB. El volcado se importa manualmente y no se ejecuta
al iniciar el servidor.

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

El archivo de exportación contiene datos personales, contraseñas y tokens; está
excluido de Git y debe tratarse como sensible. Importarlo únicamente en una base
MySQL vacía.
