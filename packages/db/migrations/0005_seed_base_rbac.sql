-- Up Migration
-- ============================================================================
-- 0005 — Semilla del RBAC base.
--
-- Roles y permisos son filas POR TENANT (llevan tenant_id como todo lo demas),
-- asi que no se pueden sembrar de una vez en la migracion: cuando esta corre
-- todavia no hay tenants, y los que se creen manana tambien los necesitan.
--
-- La semilla vive por tanto en una funcion, y un trigger sobre `tenants` la
-- ejecuta al dar de alta cada cliente. Consecuencia: no puede existir un tenant
-- sin sus cuatro roles base. Si en vez de un trigger fuera una llamada del
-- codigo de aplicacion, "se me olvido llamarla" seria un estado alcanzable.
--
-- La funcion es SECURITY INVOKER (por defecto): corre con los privilegios de
-- quien inserta el tenant y bajo su misma RLS. No abre ningun agujero.
-- Es idempotente (ON CONFLICT DO NOTHING), asi que se puede reejecutar sobre un
-- tenant existente para reponer roles base borrados por error.
-- ============================================================================

CREATE FUNCTION seed_tenant_rbac(p_tenant_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- Catalogo de permisos, en formato `recurso:accion`. La columna `key` de
  -- permissions es generada, asi que aqui solo se dan recurso y accion.
  INSERT INTO permissions (tenant_id, resource, action)
  SELECT p_tenant_id, resource, action
  FROM (VALUES
    ('tenant',     'read'),
    ('tenant',     'update'),
    ('user',       'read'),
    ('user',       'invite'),
    ('user',       'update'),
    ('user',       'remove'),
    ('team',       'read'),
    ('team',       'create'),
    ('team',       'update'),
    ('team',       'delete'),
    ('task',       'read'),
    ('task',       'create'),
    ('task',       'update'),
    ('task',       'assign'),
    ('task',       'close'),
    ('repository', 'read'),
    ('repository', 'connect'),
    ('repository', 'disconnect'),
    ('role',       'read'),
    ('role',       'assign'),
    ('audit',      'read')
  ) AS catalog (resource, action)
  ON CONFLICT ON CONSTRAINT permissions_tenant_id_key_key DO NOTHING;

  INSERT INTO roles (tenant_id, key, name, description)
  SELECT p_tenant_id, key, name, description
  FROM (VALUES
    ('owner',       'Propietario', 'Control total del tenant, incluida su configuracion.'),
    ('maintainer',  'Responsable', 'Gestiona personas, equipos, repositorios y tareas.'),
    ('contributor', 'Colaborador', 'Trabaja en tareas; no gestiona personas ni permisos.'),
    ('viewer',      'Observador',  'Solo lectura, sin acceso al registro de auditoria.')
  ) AS base (key, name, description)
  ON CONFLICT ON CONSTRAINT roles_tenant_id_key_key DO NOTHING;

  -- Que puede hacer cada rol base. Se expresa como predicado sobre el catalogo
  -- para que anadir un permiso nuevo no obligue a tocar cuatro listas.
  INSERT INTO role_permissions (tenant_id, role_id, permission_id)
  SELECT p_tenant_id, r.id, p.id
  FROM roles r
  JOIN permissions p ON p.tenant_id = r.tenant_id
  WHERE r.tenant_id = p_tenant_id
    AND (
         r.key = 'owner'
      OR (r.key = 'maintainer'  AND p.key <> 'tenant:update')
      OR (r.key = 'contributor' AND (p.key IN ('task:create', 'task:update', 'task:close')
                                     OR (p.action = 'read' AND p.resource <> 'audit')))
      OR (r.key = 'viewer'      AND p.action = 'read' AND p.resource <> 'audit')
    )
  ON CONFLICT ON CONSTRAINT role_permissions_tenant_id_role_id_permission_id_key DO NOTHING;
END
$$;

COMMENT ON FUNCTION seed_tenant_rbac(uuid) IS
  'Siembra (idempotente) los permisos y los cuatro roles base de un tenant. La invoca el trigger tenants_seed_rbac al crear el tenant.';

CREATE FUNCTION tenants_seed_rbac() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM seed_tenant_rbac(NEW.id);
  RETURN NULL;
END
$$;

CREATE TRIGGER tenants_seed_rbac
  AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_seed_rbac();

-- Down Migration
DROP TRIGGER IF EXISTS tenants_seed_rbac ON tenants;
DROP FUNCTION IF EXISTS tenants_seed_rbac();
DROP FUNCTION IF EXISTS seed_tenant_rbac(uuid);
