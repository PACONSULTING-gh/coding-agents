-- Up Migration
-- ============================================================================
-- 0002 — Tablas del nucleo multi-tenant.
--
-- Reglas que aplican a TODAS las tablas de este fichero (CLAUDE.md 2.6):
--   * PK uuid con `gen_random_uuid()`; timestamps siempre `timestamptz`.
--   * Toda tabla lleva `tenant_id uuid NOT NULL REFERENCES tenants(id)`.
--     `tenants` es la unica excepcion: su propio `id` hace de tenant_id.
--   * `tenant_id` es la columna LIDER de todo indice DE ACCESO POR TENANT.
--     Las claves naturales son unicas POR TENANT (`UNIQUE (tenant_id, email)`),
--     nunca globales: dos clientes distintos pueden tener el mismo email.
--
--     Dos familias de indices son excepcion, y lo son a proposito:
--       1. Las CLAVES PRIMARIAS son `(id)`. El uuid ya es globalmente unico, asi
--          que anadirle `tenant_id` delante no aporta unicidad, y las claves
--          ajenas compuestas no se apoyan en la PK sino en el
--          `UNIQUE (tenant_id, id)` que declara cada tabla hija (ver punto
--          siguiente). Cambiarlas a `(tenant_id, id)` es una decision de diseno
--          con consecuencias en todas las FK: si algun dia se quiere, va por ADR,
--          no por cambio silencioso.
--       2. Las tres CLAVES NATURALES GLOBALES: `tenants.slug`,
--          `github_installations.installation_id` (0006) y
--          `webhook_deliveries.delivery_id` (0006). Son identificadores que
--          asigna el mundo exterior y que tienen que ser unicos en TODO el
--          despliegue, precisamente para que no haya dos tenants reclamando la
--          misma instalacion o la misma entrega.
--
--     La regla y su lista de excepciones NO viven solo en este comentario: el
--     bloque 6 de `test/tenant-isolation.test.ts` recorre el catalogo y falla si
--     aparece un indice sin `tenant_id` como primera columna que no este en la
--     lista. Ampliar la lista es un cambio visible en el diff.
--   * Cada tabla hija declara ademas `UNIQUE (tenant_id, id)` para poder ser
--     referenciada con clave ajena COMPUESTA. Eso convierte "no mezclar tenants"
--     en una restriccion del motor: no se puede meter en un equipo del tenant A
--     a un usuario del tenant B ni equivocandose a proposito.
--
-- Requiere PostgreSQL >= 15 (`ON DELETE SET NULL (columna)` en user_roles).
-- ============================================================================

-- Mantiene `updated_at` sincronizado sin depender de que la aplicacion se
-- acuerde. Sin `SET search_path` a proposito: solo usa constructos de
-- pg_catalog, y anadir la clausula impediria que el planner la incorpore.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION set_updated_at() IS
  'Trigger BEFORE UPDATE: refresca updated_at con la hora del servidor.';

-- ----------------------------------------------------------------------------
-- tenants
-- ----------------------------------------------------------------------------
CREATE TABLE tenants (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL CHECK (length(btrim(name)) > 0),
  slug         text        NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  database_url text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_slug_key UNIQUE (slug)
);

COMMENT ON TABLE tenants IS
  'Cliente/organizacion. Raiz del aislamiento: el id de esta fila es el tenant_id del resto.';
COMMENT ON COLUMN tenants.slug IS
  'Identificador legible y GLOBALMENTE unico: a diferencia del resto de claves naturales del esquema, no puede repetirse entre tenants porque es la propia tabla de tenants.';
COMMENT ON COLUMN tenants.database_url IS
  'HOY SIEMPRE VA NULL, y NULL significa "este tenant vive en el esquema compartido con RLS". La columna existe ya porque anadirla despues obligaria a reescribir toda la capa de acceso (CLAUDE.md 4: barato ahora, caro despues). Solo se rellenaria el dia que un cliente exija por contrato su propia base de datos; ese dia el enrutado leeria esta columna. Nunca debe contener la contrasena en claro: se guardaria una referencia al secreto, no el secreto.';

CREATE TRIGGER tenants_set_updated_at BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- users
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email        text        NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  display_name text        NOT NULL CHECK (length(btrim(display_name)) > 0),
  github_login text        CHECK (github_login IS NULL OR github_login ~ '^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$'),
  status       text        NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT users_tenant_id_email_key UNIQUE (tenant_id, email)
);

COMMENT ON COLUMN users.email IS
  'Se almacena en minusculas (lo fuerza el CHECK) para que la unicidad por tenant no dependa de como escriba quien invita.';

-- Unico por tenant solo cuando hay valor: varios usuarios pueden no tener
-- cuenta de GitHub todavia.
CREATE UNIQUE INDEX users_tenant_id_github_login_key
  ON users (tenant_id, github_login)
  WHERE github_login IS NOT NULL;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- teams / team_members
-- ----------------------------------------------------------------------------
CREATE TABLE teams (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  slug        text        NOT NULL CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teams_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT teams_tenant_id_slug_key UNIQUE (tenant_id, slug)
);

CREATE TRIGGER teams_set_updated_at BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE team_members (
  id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  team_id   uuid        NOT NULL,
  user_id   uuid        NOT NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT team_members_tenant_id_team_id_user_id_key UNIQUE (tenant_id, team_id, user_id),
  CONSTRAINT team_members_team_fkey FOREIGN KEY (tenant_id, team_id)
    REFERENCES teams (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT team_members_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON CONSTRAINT team_members_user_fkey ON team_members IS
  'Clave ajena compuesta: el usuario tiene que pertenecer al MISMO tenant que la fila. Impide cruzar tenants aunque el codigo llamante se equivoque.';

CREATE INDEX team_members_tenant_id_user_id_idx ON team_members (tenant_id, user_id);

-- ----------------------------------------------------------------------------
-- skills / user_skills
-- ----------------------------------------------------------------------------
CREATE TABLE skills (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name       text        NOT NULL CHECK (length(btrim(name)) > 0),
  category   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skills_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT skills_tenant_id_name_key UNIQUE (tenant_id, name)
);

CREATE TRIGGER skills_set_updated_at BEFORE UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_skills (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  skill_id   uuid        NOT NULL,
  level      smallint    NOT NULL CHECK (level BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_skills_tenant_id_user_id_skill_id_key UNIQUE (tenant_id, user_id, skill_id),
  CONSTRAINT user_skills_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_skills_skill_fkey FOREIGN KEY (tenant_id, skill_id)
    REFERENCES skills (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX user_skills_tenant_id_skill_id_idx ON user_skills (tenant_id, skill_id);

CREATE TRIGGER user_skills_set_updated_at BEFORE UPDATE ON user_skills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- RBAC: roles, permissions, role_permissions, user_roles
--
-- Los permisos son FILAS, no columnas booleanas. En este esquema no existe (ni
-- puede existir) un `is_admin`: quien puede hacer que se responde uniendo
-- user_roles -> role_permissions -> permissions (CLAUDE.md 4, "RBAC real").
-- ----------------------------------------------------------------------------
CREATE TABLE roles (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  key         text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  name        text        NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT roles_tenant_id_key_key UNIQUE (tenant_id, key)
);

COMMENT ON TABLE roles IS
  'Roles por tenant. Los cuatro base (owner/maintainer/contributor/viewer) los siembra el trigger de 0005 al crear el tenant; un tenant puede anadir los suyos.';

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE permissions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  resource   text        NOT NULL CHECK (resource ~ '^[a-z][a-z0-9_]*$'),
  action     text        NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]*$'),
  key        text        GENERATED ALWAYS AS (resource || ':' || action) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT permissions_tenant_id_key_key UNIQUE (tenant_id, key)
);

COMMENT ON COLUMN permissions.key IS
  'Columna generada `recurso:accion`. Al ser GENERATED, el formato no depende de que quien inserta se acuerde de respetarlo.';

CREATE TABLE role_permissions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role_id       uuid        NOT NULL,
  permission_id uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT role_permissions_tenant_id_role_id_permission_id_key UNIQUE (tenant_id, role_id, permission_id),
  CONSTRAINT role_permissions_role_fkey FOREIGN KEY (tenant_id, role_id)
    REFERENCES roles (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT role_permissions_permission_fkey FOREIGN KEY (tenant_id, permission_id)
    REFERENCES permissions (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX role_permissions_tenant_id_permission_id_idx
  ON role_permissions (tenant_id, permission_id);

CREATE TABLE user_roles (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id    uuid        NOT NULL,
  role_id    uuid        NOT NULL,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_roles_tenant_id_user_id_role_id_key UNIQUE (tenant_id, user_id, role_id),
  CONSTRAINT user_roles_user_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT user_roles_role_fkey FOREIGN KEY (tenant_id, role_id)
    REFERENCES roles (tenant_id, id) ON DELETE CASCADE,
  -- Si se borra quien concedio el rol, la concesion sobrevive con granted_by a
  -- NULL. La lista de columnas es necesaria para no intentar anular tenant_id.
  CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (tenant_id, granted_by)
    REFERENCES users (tenant_id, id) ON DELETE SET NULL (granted_by)
);

CREATE INDEX user_roles_tenant_id_role_id_idx ON user_roles (tenant_id, role_id);

-- ----------------------------------------------------------------------------
-- audit_log (append-only; la parte de "solo INSERT/SELECT" la aplica 0004)
-- ----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_id      uuid,
  actor_type    text        NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  action        text        NOT NULL CHECK (length(btrim(action)) > 0),
  resource_type text        NOT NULL CHECK (length(btrim(resource_type)) > 0),
  resource_id   text,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id    text
);

COMMENT ON TABLE audit_log IS
  'Registro append-only. Fuente de verdad de quien hizo que; se lee con la API de packages/db/src/audit.ts.';
COMMENT ON COLUMN audit_log.actor_id IS
  'Nullable a proposito: el actor puede ser el sistema o un agente sin fila en users. Sin clave ajena, tambien a proposito: el registro debe sobrevivir al borrado del usuario que lo genero.';

-- Sirve al patron de lectura real (ultimos eventos del tenant) y al keyset
-- pagination de audit.ts, que ordena por (occurred_at DESC, id DESC).
CREATE INDEX audit_log_tenant_id_occurred_at_idx
  ON audit_log (tenant_id, occurred_at DESC, id DESC);

-- ----------------------------------------------------------------------------
-- Permisos de app_runtime. Explicitos por tabla: los DEFAULT PRIVILEGES de 0001
-- solo aplican si quien crea las tablas es app_migrator, y esta migracion tiene
-- que funcionar tambien cuando la aplica un DBA.
-- audit_log se concede aparte en 0004 (solo SELECT/INSERT).
-- ----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON
  tenants, users, teams, team_members, skills, user_skills,
  roles, permissions, role_permissions, user_roles
TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS user_roles;
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
DROP TABLE IF EXISTS roles;
DROP TABLE IF EXISTS user_skills;
DROP TABLE IF EXISTS skills;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
DROP FUNCTION IF EXISTS set_updated_at();
