# infra/pgbouncer

**Este directorio no contiene `pgbouncer.ini` ni `userlist.txt`, y es a propósito.**

La imagen `edoburu/pgbouncer` genera ambos ficheros dentro del contenedor, en
`/etc/pgbouncer/`, a partir de variables de entorno (`DATABASE_URL`, `POOL_MODE`,
`MAX_CLIENT_CONN`, …). Toda la configuración vive por tanto en
`infra/docker-compose.yml`, comentada allí.

Mantenerlo así tiene una razón que no es de comodidad: **`userlist.txt` contiene
las credenciales de `app_runtime`**. Si ese fichero viviera aquí, tendría que
estar en el repositorio con una contraseña dentro, o con un placeholder que
alguien acabaría rellenando y commiteando. Secretos jamás en el repo
(`CLAUDE.md` §5). Al generarse en el arranque desde `APP_RUNTIME_PASSWORD`, no
hay ningún fichero que proteger.

## Si algún día hace falta un `pgbouncer.ini` propio

Puede pasar: parámetros que la imagen no expone como variable, varias bases de
datos, TLS hacia el servidor. En ese caso:

1. El `.ini` sí puede vivir aquí, **sin contraseñas**, y montarse en
   `/etc/pgbouncer/pgbouncer.ini`.
2. El `auth_file` **no**. Se resuelve con `auth_user` + `auth_query` contra una
   función `SECURITY DEFINER` en Postgres, o montando el userlist desde el gestor
   de secretos del entorno. Nunca desde este directorio.
3. Añadir una entrada en `.gitignore` para `userlist.txt`, como red de seguridad
   contra el despiste.

## Comprobar que el pooler hace su trabajo

Con los contenedores arriba:

```bash
# Conexiones REALES abiertas contra Postgres (deben quedarse por debajo de
# DEFAULT_POOL_SIZE, por muchos clientes que haya del otro lado)
psql "$DATABASE_ADMIN_URL" -c \
  "SELECT count(*) FROM pg_stat_activity WHERE usename = 'app_runtime'"

# Lo que ve el propio PgBouncer: clientes conectados vs. servidores usados.
# `app_runtime` esta en `stats_users` (ver infra/docker-compose.yml): acceso de
# SOLO LECTURA a la consola. No puede hacer PAUSE, RESUME, RELOAD ni KILL.
psql "postgres://app_runtime:$APP_RUNTIME_PASSWORD@localhost:6432/pgbouncer" -c 'SHOW POOLS'
```

Si `SHOW POOLS` responde `FATAL: not allowed`, el usuario no esta en
`stats_users` ni en `admin_users`: la imagen deja `admin_users = postgres` por
defecto y el compose de este repo anade `STATS_USERS: app_runtime` justo para
que este comando funcione.

El test `packages/db/test/pgbouncer.test.ts` automatiza exactamente esa
comprobación: abre 200 conexiones de cliente simultáneas contra PgBouncer y
verifica contra `pg_stat_activity` que los backends reales se mantienen por
debajo del pool configurado.
