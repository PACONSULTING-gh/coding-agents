-- Up Migration
-- ============================================================================
-- 0003 — Row Level Security forzada en TODAS las tablas de `public`.
--
-- Esta es la defensa real del aislamiento entre clientes. No depende de que
-- ningun programador se acuerde de escribir `WHERE tenant_id = ...`: aunque la
-- consulta este mal escrita, Postgres no devuelve filas de otro tenant.
--
-- Dos clausulas, no una:
--   ENABLE ROW LEVEL SECURITY  -> activa las politicas.
--   FORCE  ROW LEVEL SECURITY  -> las aplica TAMBIEN al dueno de la tabla
--                                 (app_migrator). Sin FORCE, el dueno las
--                                 saltaria y una migracion o un script de
--                                 mantenimiento veria todos los tenants.
--
-- Nota: los superusuarios y los roles con BYPASSRLS siguen saltandose la RLS
-- pase lo que pase. Por eso 0001 fuerza NOSUPERUSER/NOBYPASSRLS en app_runtime:
-- la politica solo vale lo que valgan los atributos del rol que la sufre.
-- ============================================================================

-- Lee el tenant del contexto de sesion/transaccion.
--
--   * `current_setting(..., true)` (missing_ok = true) devuelve NULL cuando la
--     variable no esta fijada, en vez de lanzar.
--   * `NULLIF(..., '')` cubre el caso de que alguien la fije a cadena vacia,
--     que si no reventaria al castear a uuid.
--   * El resultado es NULL cuando no hay contexto. Y `tenant_id = NULL` no es
--     TRUE, es NULL: la politica no deja pasar la fila. Es decir, SIN CONTEXTO
--     DE TENANT NO SE VE NADA. Falla cerrado, que es exactamente lo que
--     queremos: el modo degradado es "no devuelvo datos", nunca "los devuelvo
--     todos".
--
-- STABLE y sin `SET search_path` para que el planner pueda incorporarla dentro
-- de la condicion de la politica (si no, se pagaria en cada fila). Todo lo que
-- referencia esta cualificado a pg_catalog, asi que no depende del search_path.
CREATE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION app_current_tenant_id() IS
  'Tenant activo, o NULL si no hay contexto. NULL hace que toda politica de aislamiento no devuelva filas: falla cerrado.';

-- `tenants` es su propia raiz: el discriminante es `id`, no `tenant_id`.
-- Ojo: por el FORCE, crear un tenant exige fijar antes app.tenant_id al id que
-- se va a insertar. Es deliberado: no existe ningun camino, ni para el dueno
-- del esquema, que lea o escriba tenants sin declarar sobre cual trabaja.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  FOR ALL
  USING      (id = app_current_tenant_id())
  WITH CHECK (id = app_current_tenant_id());

-- El resto de tablas comparten exactamente la misma politica. `FOR ALL` cubre
-- SELECT/INSERT/UPDATE/DELETE, y se declaran las DOS clausulas:
--   USING      -> que filas se pueden LEER (y cuales se pueden tocar).
--   WITH CHECK -> que filas se pueden ESCRIBIR. Sin ella, un INSERT podria
--                 colar una fila con el tenant_id de otro cliente: USING no
--                 mira los valores nuevos.
DO $enable_rls$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'users', 'teams', 'team_members', 'skills', 'user_skills',
    'roles', 'permissions', 'role_permissions', 'user_roles', 'audit_log'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I FOR ALL'
      ' USING (tenant_id = app_current_tenant_id())'
      ' WITH CHECK (tenant_id = app_current_tenant_id())',
      target
    );
  END LOOP;
END
$enable_rls$;

-- Down Migration
DO $disable_rls$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'tenants', 'users', 'teams', 'team_members', 'skills', 'user_skills',
    'roles', 'permissions', 'role_permissions', 'user_roles', 'audit_log'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', target);
  END LOOP;
END
$disable_rls$;

DROP FUNCTION IF EXISTS app_current_tenant_id();
