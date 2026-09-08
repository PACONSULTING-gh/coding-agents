# infra

## Levantar Postgres en local

```
docker compose -f infra/docker-compose.yml up -d
```

Postgres queda disponible en `localhost:5432`, usuario/contraseña/db `coord`/`coord`/`coord`
(solo para desarrollo local; en ningún otro entorno se usan estas credenciales).
Comprueba que está sano con:

```
docker compose -f infra/docker-compose.yml ps
```

Para pararlo y borrar los datos:

```
docker compose -f infra/docker-compose.yml down -v
```

## PgBouncer

El `docker-compose.yml` incluye también un **PgBouncer en modo transacción** en
`localhost:6432`. Es el destino de **`PGBOUNCER_URL`**, la variable por la que
va todo el acceso a datos de la aplicación: `DATABASE_URL` apunta a Postgres
DIRECTO (5432) y es la que necesitan pg-boss —que usa `LISTEN/NOTIFY` y no
sobrevive al modo transacción— y las migraciones. La convención vive en un solo
sitio, `resolveRuntimeConnectionString` de `packages/db/src/pool.ts`, que avisa
por consola si `PGBOUNCER_URL` falta y hay que caer al Postgres directo.

Necesita la contraseña del rol `app_runtime` por variable de entorno (nunca en
el fichero), así que antes de levantarlo:

```bash
export APP_RUNTIME_PASSWORD='...'        # o ponla en el .env local
docker compose -f infra/docker-compose.yml up -d
```

El rol `app_runtime` lo crea la migración `0001` de `packages/db`, y su
contraseña se asigna fuera de banda (ver `packages/db/README.md` §1). Hasta que
eso ocurra, PgBouncer arranca pero rechaza las conexiones: es lo esperado.

Configuración y por qué de cada parámetro: comentarios del propio
`docker-compose.yml` y `infra/pgbouncer/README.md`.

**Antes de tocar el modo de pooling**, lee la cabecera de
`packages/db/src/client.ts`: el modo transacción es lo que obliga a fijar el
tenant con `set_config(..., true)` dentro de una transacción, y pasar a modo
sesión sin entender eso rompe el aislamiento entre clientes.
