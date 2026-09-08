-- Up Migration
-- ============================================================================
-- 0004 — `audit_log` es append-only. Dos cerrojos independientes:
--
--   1. GRANTS. app_runtime solo tiene SELECT e INSERT. Un UPDATE o un DELETE
--      desde la aplicacion muere en el control de privilegios (SQLSTATE 42501)
--      antes de tocar una fila. Defiende del uso normal y de un bug.
--
--   2. TRIGGER. Los grants no protegen del DUENO de la tabla: app_migrator
--      tiene todos los privilegios sobre lo que crea, y podria borrar historial
--      desde una migracion o una consola. El trigger corta tambien ese camino.
--
-- Se ponen los dos a proposito. Cada uno tapa el hueco del otro. Quitar el
-- historial de auditoria deja de ser un descuido posible: hay que borrar el
-- trigger explicitamente, y eso queda en el propio historial de migraciones.
--
-- El trigger es FOR EACH STATEMENT, no FOR EACH ROW: asi salta aunque la
-- sentencia no llegue a casar ninguna fila (por ejemplo porque la RLS ya la
-- habia ocultado). Se rechaza la INTENCION, no solo el efecto.
-- ============================================================================

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log es append-only: % no esta permitido sobre esta tabla', TG_OP
    USING HINT = 'Corrige el historial anadiendo un evento nuevo que lo compense; nunca reescribiendo el pasado.';
END
$$;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_is_append_only();

-- Cerrojo 1: la aplicacion solo puede anadir y leer.
GRANT SELECT, INSERT ON audit_log TO app_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_runtime;

-- Down Migration
DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
DROP FUNCTION IF EXISTS audit_log_is_append_only();
REVOKE SELECT, INSERT ON audit_log FROM app_runtime;
