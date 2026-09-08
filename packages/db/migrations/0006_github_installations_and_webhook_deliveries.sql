-- Up Migration
-- ============================================================================
-- 0006 — Integracion con GitHub: mapeo instalacion -> tenant y deduplicacion
--        de entregas de webhook (T05).
--
-- Sigue el patron de 0002/0003 sin excepciones: uuid como PK, `tenant_id` como
-- columna lider, `UNIQUE (tenant_id, id)` para poder referenciar con clave
-- ajena compuesta, trigger de `updated_at`, y RLS habilitada + FORZADA con la
-- politica `tenant_isolation` identica a la del resto.
--
-- ----------------------------------------------------------------------------
-- LA PARTE QUE HAY QUE LEER ANTES DE TOCAR NADA: EL LOOKUP DE ENRUTADO
-- ----------------------------------------------------------------------------
-- Cuando llega un webhook de GitHub, todavia NO se sabe de que tenant es. Lo
-- unico que trae el evento es el `installation.id`. Es decir, hay que leer
-- `github_installations` para AVERIGUAR el tenant, y con RLS forzada eso es
-- imposible por definicion: sin `app.tenant_id` la politica no deja pasar
-- ninguna fila (es su razon de ser: fallar cerrado).
--
-- Tampoco sirve la via administrativa de T03 (`unsafeWithoutTenantScope`): esa
-- funcion NO desactiva la RLS —no puede, ningun rol tiene BYPASSRLS— y ademas
-- exige saber bajo que tenant dejar el rastro de auditoria, que es justo el
-- dato que aun no tenemos. Su propia documentacion lo dice: sirve para
-- catalogo y DDL, no para leer filas de dominio.
--
-- La salida es una SEGUNDA politica, deliberadamente diminuta:
--
--   * solo SELECT (nunca escribe),
--   * solo cuando NO hay contexto de tenant (jamas puede ampliar lo que ve una
--     consulta con tenant fijado: las politicas permisivas se combinan con OR,
--     y esta exige `app_current_tenant_id() IS NULL`),
--   * y solo para la instalacion CONCRETA que el llamante declara por
--     adelantado en `app.github_installation_lookup`.
--
-- Ese ultimo punto es lo que la hace aceptable: el radio de exposicion no es
-- "la tabla entera", es UNA fila, la que se ha nombrado explicitamente. Un
-- `SELECT *` por error dentro de ese bloque sigue devolviendo como mucho esa
-- fila. Y el ajuste se hace con `set_config(..., true)`, LOCAL a la
-- transaccion, por la misma razon que en client.ts: detras de PgBouncer en
-- modo transaccion, un ajuste de sesion se queda pegado en un backend que
-- despues sirve a otro cliente.
--
-- La unica funcion del repositorio que activa este ajuste es
-- `findInstallationRouting()` en packages/db/src/github-installations.ts.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- github_installations
-- ----------------------------------------------------------------------------
CREATE TABLE github_installations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  installation_id      bigint      NOT NULL CHECK (installation_id > 0),
  account_login        text        NOT NULL CHECK (account_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$'),
  account_type         text        NOT NULL CHECK (account_type IN ('Organization', 'User')),
  repository_selection text        NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  suspended_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_installations_tenant_id_id_key UNIQUE (tenant_id, id),
  -- GLOBALMENTE unico, no por tenant: una instalacion de la GitHub App
  -- pertenece a una organizacion de GitHub y esa organizacion es de UN cliente.
  -- Es la excepcion documentada a "las claves naturales son unicas por tenant"
  -- de 0002, y ademas es lo que impide que dos tenants se reclamen la misma
  -- instalacion y se roben los eventos.
  CONSTRAINT github_installations_installation_id_key UNIQUE (installation_id)
);

COMMENT ON TABLE github_installations IS
  'Mapeo instalacion de la GitHub App -> tenant. Es la tabla de ENRUTADO: se consulta antes de saber de quien es un webhook.';
COMMENT ON COLUMN github_installations.installation_id IS
  'Id numerico de la instalacion en GitHub. Unico en todo el sistema: una instalacion pertenece a un solo tenant.';
COMMENT ON COLUMN github_installations.suspended_at IS
  'No NULL mientras la instalacion este suspendida en GitHub. Una instalacion suspendida sigue mapeada, pero sus tokens no sirven.';

CREATE TRIGGER github_installations_set_updated_at BEFORE UPDATE ON github_installations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE github_installations ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_installations FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON github_installations
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Ver la explicacion larga de la cabecera. Solo SELECT, solo sin contexto de
-- tenant, y solo de la instalacion nombrada de antemano.
CREATE POLICY installation_routing_lookup ON github_installations
  FOR SELECT
  USING (
    app_current_tenant_id() IS NULL
    AND installation_id::text
        = NULLIF(pg_catalog.current_setting('app.github_installation_lookup', true), '')
  );

COMMENT ON POLICY installation_routing_lookup ON github_installations IS
  'Carve-out minimo para el enrutado de webhooks: devuelve como mucho la fila de la instalacion declarada en app.github_installation_lookup, y solo fuera de contexto de tenant.';

-- ----------------------------------------------------------------------------
-- webhook_deliveries
--
-- La deduplicacion de entregas se apoya en la RESTRICCION UNICA, no en un
-- SELECT previo: `SELECT ... IF NOT EXISTS THEN INSERT` tiene una carrera que
-- dos entregas simultaneas de la misma entrega ganan sin esfuerzo. Con
-- `INSERT ... ON CONFLICT DO NOTHING`, la segunda transaccion se bloquea hasta
-- que la primera confirma y despues no inserta nada: el numero de filas
-- afectadas es la respuesta.
--
-- `delivery_id` es unico GLOBALMENTE por el mismo motivo que installation_id:
-- el GUID lo genera GitHub y es unico en todo GitHub. Como el indice unico no
-- pasa por la RLS, un choque contra la fila de otro tenant tambien se detecta
-- (y no filtra nada: el llamante solo aprende "duplicado").
-- ----------------------------------------------------------------------------
CREATE TABLE webhook_deliveries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  delivery_id text        NOT NULL CHECK (length(btrim(delivery_id)) > 0),
  event       text        NOT NULL CHECK (length(btrim(event)) > 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_deliveries_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT webhook_deliveries_delivery_id_key UNIQUE (delivery_id)
);

COMMENT ON TABLE webhook_deliveries IS
  'Una fila por entrega de webhook aceptada. Existe para deduplicar reentregas de GitHub; el contenido del evento NO se guarda aqui (va al job y al audit_log).';
COMMENT ON CONSTRAINT webhook_deliveries_delivery_id_key ON webhook_deliveries IS
  'La deduplicacion ES esta restriccion. Si alguien la quita, dos entregas simultaneas del mismo GUID encolan dos veces.';

-- Patron de lectura real: las ultimas entregas de un tenant.
CREATE INDEX webhook_deliveries_tenant_id_received_at_idx
  ON webhook_deliveries (tenant_id, received_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- ----------------------------------------------------------------------------
-- Permisos de app_runtime, explicitos como en 0002.
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON github_installations, webhook_deliveries TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS webhook_deliveries;
DROP TABLE IF EXISTS github_installations;
