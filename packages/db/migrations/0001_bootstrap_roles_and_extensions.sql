-- Up Migration
-- ============================================================================
-- 0001 — Bootstrap: extensiones y roles de base de datos.
--
-- Esta migracion es la UNICA que necesita privilegios elevados: crea roles, que
-- son objetos de cluster. En un despliegue real hay dos formas de ejecutarla:
--
--   a) Un DBA la ejecuta una vez con un rol que tenga CREATEROLE (o superusuario).
--      A partir de ahi todas las migraciones corren como `app_migrator`.
--   b) El DBA ejecuta a mano el mismo bloque DO de abajo antes del primer deploy.
--      Como el bloque es idempotente, esta migracion queda entonces en no-op.
--
-- Las CONTRASENAS de los dos roles NUNCA viven en el repositorio ni en esta
-- migracion. Se asignan fuera de banda, leyendolas de variables de entorno:
--
--   psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 \
--     -c "ALTER ROLE app_migrator WITH PASSWORD '$(printf '%s' "$APP_MIGRATOR_PASSWORD")'" \
--     -c "ALTER ROLE app_runtime  WITH PASSWORD '$(printf '%s' "$APP_RUNTIME_PASSWORD")'"
--
-- y despues se componen las URLs DATABASE_MIGRATION_URL / DATABASE_URL con esas
-- contrasenas. Ver packages/db/README.md.
-- ============================================================================

-- pgcrypto: `gen_random_uuid()` es nativo desde PostgreSQL 13, pero la extension
-- se instala igualmente porque el resto del producto necesitara sus primitivas
-- (digest/hmac) y porque deja explicito el requisito en el esquema.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Dos roles con responsabilidades separadas (CLAUDE.md 2.6):
--   app_migrator: dueno del esquema, aplica DDL. NO es superusuario.
--   app_runtime:  el que usa la aplicacion. NO es dueno de nada, NO es
--                 superusuario y, sobre todo, NO tiene BYPASSRLS: si lo
--                 tuviera, toda la politica de aislamiento de abajo seria
--                 decorativa.
DO $bootstrap_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_migrator') THEN
    CREATE ROLE app_migrator WITH LOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime WITH LOGIN;
  END IF;
END
$bootstrap_roles$;

-- Se reafirman los atributos criticos aunque el rol ya existiera: si alguien
-- concedio SUPERUSER o BYPASSRLS a mano, este deploy lo revierte.
ALTER ROLE app_migrator WITH NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;
ALTER ROLE app_runtime  WITH NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION;

-- app_migrator necesita CREATE sobre la base de datos porque el runner crea el
-- schema `migrations` (con IF NOT EXISTS, que aun asi comprueba el privilegio).
-- app_runtime solo se conecta: no crea nada.
DO $grant_connect$
BEGIN
  EXECUTE format(
    'GRANT CONNECT, CREATE ON DATABASE %I TO app_migrator',
    current_database()
  );
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_runtime', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM app_runtime', current_database());
END
$grant_connect$;

-- app_runtime solo puede *usar* el schema public; no puede crear objetos en el.
GRANT USAGE ON SCHEMA public TO app_runtime;
REVOKE CREATE ON SCHEMA public FROM app_runtime;
GRANT USAGE, CREATE ON SCHEMA public TO app_migrator;

-- La tabla de control de node-pg-migrate vive en su propio schema `migrations`
-- (ver packages/db/src/migrate.ts). Mantenerla fuera de `public` permite exigir
-- que TODA tabla de `public` tenga RLS forzada, sin excepciones que memorizar.
GRANT USAGE, CREATE ON SCHEMA migrations TO app_migrator;
GRANT SELECT, INSERT, DELETE ON TABLE migrations.pgmigrations TO app_migrator;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA migrations TO app_migrator;

-- Red de seguridad: si una migracion futura crea una tabla y se olvida del
-- GRANT, app_runtime la ve igualmente. Preferimos ese fallo a un runtime caido
-- por permisos.
--
-- RIESGO CONOCIDO, ANOTADO A PROPOSITO: "la RLS sigue protegiendola" solo es
-- cierto si la migracion que crea la tabla se acuerda de activarla. Si se
-- olvida, app_runtime ve TODAS las filas de TODOS los tenants y nada falla en
-- tiempo de ejecucion. La unica red que lo atrapa hoy es el test de catalogo
-- (`test/tenant-isolation.test.ts`, bloque 6), que compara la lista exacta de
-- tablas de `public` contra DOMAIN_TABLES y exige RLS forzada en todas.
-- Es suficiente hoy, pero esta en un solo sitio.
--
-- Arreglo de raiz cuando toque: un event trigger `ddl_command_end` sobre
-- CREATE TABLE que rechace crear una tabla en `public` sin RLS forzada, para
-- que el fallo ocurra en la migracion y no en el CI. No se hace ahora porque
-- afecta a como se escriben todas las migraciones futuras y merece decision
-- humana (CLAUDE.md 2.1).
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;

-- Down Migration
-- Los roles son objetos de CLUSTER: pueden estar en uso por otras bases de datos
-- del mismo servidor. Esta bajada revoca solo lo concedido sobre ESTA base de
-- datos y deliberadamente NO borra los roles; eliminarlos es una accion de
-- operaciones explicita (`DROP OWNED BY ...` + `DROP ROLE ...`).
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM app_runtime;

REVOKE ALL ON SCHEMA public FROM app_runtime;
REVOKE ALL ON SCHEMA public FROM app_migrator;

DO $revoke_connect$
BEGIN
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM app_migrator', current_database());
END
$revoke_connect$;

-- Tampoco se elimina la extension: como los roles, es un objeto compartido de
-- la base de datos que esta migracion pudo no crear (puede venir de la
-- plantilla o de otro producto) y que quien la aplica puede no poseer.
