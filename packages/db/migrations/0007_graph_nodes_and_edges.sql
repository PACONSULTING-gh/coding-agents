-- Up Migration
-- ============================================================================
-- 0007 — Grafo de dependencias: nodos, aristas, y las dos tablas de soporte de
--        la ingesta incremental (T01 del epic 02).
--
-- El grafo vive en ESTE Postgres, no en una base de datos de grafos. La
-- decision esta cerrada (CLAUDE.md 3 y 4): en el patron que usamos —expansion
-- de vecindario acotada, no pathfinding profundo— la lista de adyacencia con
-- CTEs recursivas gana, y Neo4j solo se reconsidera cuando haya una p95 de las
-- CTEs degradada Y MEDIDA.
--
-- Sigue el patron de 0002/0003/0006 sin excepciones:
--   * PK uuid con `gen_random_uuid()`; instantes en `timestamptz`.
--   * `tenant_id uuid NOT NULL REFERENCES tenants(id)` en las cuatro tablas.
--   * `tenant_id` como columna LIDER de todo indice.
--   * `UNIQUE (tenant_id, id)` en cada tabla para poder referenciarla con
--     clave ajena COMPUESTA, de modo que mezclar tenants sea imposible a nivel
--     de motor y no solo desaconsejado.
--   * RLS `ENABLE` + `FORCE` y politica `tenant_isolation` con `USING` y
--     `WITH CHECK`.
--
-- ----------------------------------------------------------------------------
-- POR QUE `repo_id` NO TIENE CLAVE AJENA
-- ----------------------------------------------------------------------------
-- Un tenant puede tener varios repositorios y el grafo de cada uno es
-- independiente: `repo_id` particiona el grafo dentro del tenant. Todavia NO
-- existe una tabla `repositories` (llega con la ingesta real), asi que la
-- columna se declara sin FK en vez de inventar hoy una tabla sin consumidor
-- (peldano 1 de la escalera, CLAUDE.md 2.4). Cuando exista, anadir la FK
-- compuesta `(tenant_id, repo_id) -> repositories (tenant_id, id)` es una
-- migracion de una linea.
--
-- Lo que SI esta garantizado hoy por el motor es lo importante: las dos puntas
-- de una arista pertenecen al mismo tenant (FK compuesta), y la unicidad de la
-- arista incluye `repo_id`.
--
-- Requiere PostgreSQL >= 15 (`UNIQUE NULLS NOT DISTINCT`).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- graph_nodes
-- ----------------------------------------------------------------------------
CREATE TABLE graph_nodes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  repo_id    uuid        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('file', 'symbol', 'package', 'target')),
  path       text        NOT NULL CHECK (length(btrim(path)) > 0),
  name       text        CHECK (name IS NULL OR length(btrim(name)) > 0),
  language   text        CHECK (language IS NULL OR language ~ '^[a-z0-9+#-]+$'),
  metadata   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_nodes_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Clave natural, unica POR TENANT Y POR REPO. `NULLS NOT DISTINCT` es
  -- imprescindible: `name` va a NULL en los nodos de tipo `file`, y con la
  -- semantica por defecto de SQL dos NULL no chocan, asi que la reindexacion
  -- del mismo fichero habria creado un nodo duplicado en cada pasada en vez de
  -- resolverse con un `ON CONFLICT`.
  CONSTRAINT graph_nodes_natural_key
    UNIQUE NULLS NOT DISTINCT (tenant_id, repo_id, kind, path, name)
);

COMMENT ON TABLE graph_nodes IS
  'Vertices del grafo de dependencias: ficheros, simbolos, paquetes y targets de build. Particionado por (tenant_id, repo_id).';
COMMENT ON COLUMN graph_nodes.repo_id IS
  'Repositorio dentro del tenant. Sin clave ajena todavia porque no existe tabla de repositorios; ver la cabecera de la migracion.';
COMMENT ON COLUMN graph_nodes.path IS
  'Ruta RELATIVA a la raiz del repo. Nunca absoluta: una ruta absoluta filtraria la maquina del desarrollador al grafo compartido.';
COMMENT ON COLUMN graph_nodes.name IS
  'Nombre del simbolo (funcion, clase, target...). NULL en los nodos de tipo `file`, que ya quedan identificados por `path`.';
COMMENT ON CONSTRAINT graph_nodes_natural_key ON graph_nodes IS
  'Identidad del nodo. Es lo que permite que la ingesta incremental de T02 haga UPSERT en vez de duplicar en cada pasada.';

-- Resolucion "ruta -> nodo", que es como entra toda consulta que arranca de un
-- diff o de una lista de ficheros. La clave natural no sirve para esto: su
-- prefijo es (tenant_id, repo_id, kind, ...) y aqui no se conoce el `kind`.
CREATE INDEX graph_nodes_tenant_id_repo_id_path_idx
  ON graph_nodes (tenant_id, repo_id, path);

CREATE TRIGGER graph_nodes_set_updated_at BEFORE UPDATE ON graph_nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- graph_edges
-- ----------------------------------------------------------------------------
CREATE TABLE graph_edges (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  repo_id      uuid        NOT NULL,
  from_node_id uuid        NOT NULL,
  to_node_id   uuid        NOT NULL,
  kind         text        NOT NULL CHECK (kind IN ('imports', 'calls', 'inherits', 'contains', 'cochange')),
  source       text        NOT NULL CHECK (source IN ('static', 'build', 'git')),
  weight       real        NOT NULL DEFAULT 1.0 CHECK (weight > 0),
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_edges_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT graph_edges_natural_key
    UNIQUE (tenant_id, repo_id, from_node_id, to_node_id, kind, source),
  -- Claves ajenas COMPUESTAS: las dos puntas de la arista tienen que ser del
  -- MISMO tenant que la arista. No es una convencion, lo impone el motor.
  CONSTRAINT graph_edges_from_node_fkey FOREIGN KEY (tenant_id, from_node_id)
    REFERENCES graph_nodes (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT graph_edges_to_node_fkey FOREIGN KEY (tenant_id, to_node_id)
    REFERENCES graph_nodes (tenant_id, id) ON DELETE CASCADE
);

COMMENT ON TABLE graph_edges IS
  'Aristas dirigidas: `from` depende de `to`. Recorrerlas al reves da los DEPENDIENTES, que es la consulta que importa.';
COMMENT ON COLUMN graph_edges.source IS
  'Que senal produjo la arista: `static` (tree-sitter), `build` (Nx/Bazel/Turborepo) o `git` (co-cambio historico). Es la columna que responde "que predijo esto" en T03 y T05, asi que viaja en el resultado de las consultas, no se queda en la tabla.';
COMMENT ON COLUMN graph_edges.weight IS
  '1.0 para las aristas estaticas y de build (o esta o no esta). Para `cochange` es la frecuencia de co-cambio, que es lo que permite ranquear.';
COMMENT ON CONSTRAINT graph_edges_natural_key ON graph_edges IS
  'La misma pareja de nodos puede estar unida por varias aristas si las produjeron senales distintas (un import estatico Y un co-cambio historico): `source` forma parte de la identidad a proposito, para no perder ninguna de las dos.';

-- Los DOS sentidos, y los dos hacen falta:
--   * `from` -> dependencias (que usa este nodo).
--   * `to`   -> DEPENDIENTES (quien usa este nodo). La CTE recursiva de
--     `findDependents` y `blastRadius` recorre la arista al reves y hace el
--     JOIN por `to_node_id`; sin este segundo indice cada nivel de la recursion
--     seria un seq scan de la tabla de aristas y el criterio de 200 ms en p95
--     es inalcanzable.
-- `kind` va en el indice porque las consultas filtran por tipo de arista.
CREATE INDEX graph_edges_tenant_id_repo_id_from_node_id_kind_idx
  ON graph_edges (tenant_id, repo_id, from_node_id, kind);
CREATE INDEX graph_edges_tenant_id_repo_id_to_node_id_kind_idx
  ON graph_edges (tenant_id, repo_id, to_node_id, kind);

CREATE TRIGGER graph_edges_set_updated_at BEFORE UPDATE ON graph_edges
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- graph_files — hash de contenido por fichero indexado.
--
-- Existe ya, aunque T01 no la use, porque es la pieza de la INDEXACION
-- INCREMENTAL de T02 y el epic dice explicitamente que retrofitear eso despues
-- sale caro. Al llegar un commit se compara el hash: si no cambio, ese fichero
-- no se reparsea.
-- ----------------------------------------------------------------------------
CREATE TABLE graph_files (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  repo_id        uuid        NOT NULL,
  path           text        NOT NULL CHECK (length(btrim(path)) > 0),
  content_hash   text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{40,64}$'),
  language       text        CHECK (language IS NULL OR language ~ '^[a-z0-9+#-]+$'),
  indexed_at     timestamptz NOT NULL DEFAULT now(),
  indexed_commit text        CHECK (indexed_commit IS NULL OR indexed_commit ~ '^[0-9a-f]{7,40}$'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_files_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT graph_files_tenant_id_repo_id_path_key UNIQUE (tenant_id, repo_id, path)
);

COMMENT ON TABLE graph_files IS
  'Un fichero indexado y el hash del contenido con el que se indexo. Es el estado que hace incremental la ingesta de T02.';
COMMENT ON COLUMN graph_files.content_hash IS
  'Hash hexadecimal del contenido (el blob sha de git o un sha-256). Si coincide con el del commit nuevo, el fichero no se reparsea.';

CREATE TRIGGER graph_files_set_updated_at BEFORE UPDATE ON graph_files
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- graph_ingestions — estado y checkpoint de cada pasada de ingesta.
--
-- Tambien es de T02: su cuarto criterio es que una ingesta interrumpida a mitad
-- se reanude sin empezar de cero. `checkpoint` guarda por donde iba (que
-- ficheros quedan), y `status` distingue "esta corriendo" de "murio a medias".
-- ----------------------------------------------------------------------------
CREATE TABLE graph_ingestions (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  repo_id     uuid        NOT NULL,
  commit_sha  text        NOT NULL CHECK (commit_sha ~ '^[0-9a-f]{7,40}$'),
  status      text        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  checkpoint  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- Motivo del fallo, en claro. Un `failed` sin explicacion obliga a reproducir
  -- la ingesta entera para saber que paso (CLAUDE.md 5: nunca tragarse el error).
  error       text,
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT graph_ingestions_tenant_id_id_key UNIQUE (tenant_id, id),
  CONSTRAINT graph_ingestions_finished_implies_started
    CHECK (finished_at IS NULL OR started_at IS NOT NULL),
  CONSTRAINT graph_ingestions_failed_has_error
    CHECK (status <> 'failed' OR error IS NOT NULL)
);

COMMENT ON TABLE graph_ingestions IS
  'Una fila por pasada de ingesta del grafo. `checkpoint` es lo que permite reanudar una ingesta interrumpida en vez de reindexar el repo entero (T02).';

-- Patron de lectura real: la ultima ingesta de un repo, y las que quedaron a
-- medias y hay que reanudar.
CREATE INDEX graph_ingestions_tenant_id_repo_id_created_at_idx
  ON graph_ingestions (tenant_id, repo_id, created_at DESC);

CREATE TRIGGER graph_ingestions_set_updated_at BEFORE UPDATE ON graph_ingestions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, con la MISMA politica que el resto del esquema.
-- Sin esto, el grafo —que contiene la estructura del codigo de cada cliente—
-- seria la unica parte del sistema legible desde otro tenant.
-- ----------------------------------------------------------------------------
DO $enable_rls$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'graph_nodes', 'graph_edges', 'graph_files', 'graph_ingestions'
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

-- Permisos de app_runtime, explicitos como en 0002 y 0006.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  graph_nodes, graph_edges, graph_files, graph_ingestions
TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS graph_ingestions;
DROP TABLE IF EXISTS graph_files;
DROP TABLE IF EXISTS graph_edges;
DROP TABLE IF EXISTS graph_nodes;
