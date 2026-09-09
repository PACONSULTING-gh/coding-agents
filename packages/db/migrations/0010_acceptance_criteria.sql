-- Up Migration
-- ============================================================================
-- 0010 — Criterios de aceptacion como artefacto de primera clase (T01, epic 05).
--
-- El epic 05 dice que esta es "la palanca mas importante del epic, y no es
-- tecnica": sin criterios Given/When/Then aprobados por un humano ANTES de
-- codear, el resto de la verificacion es teatro — se acaba con una fachada de
-- tests verdes sobre funcionalidad rota.
--
-- Estas dos tablas son el almacen de esa palanca. La regla que de verdad
-- bloquea vive en `packages/graph/src/claims.ts`: un `claim()` sobre un issue
-- sin criterios aprobados se rechaza.
--
-- Sigue el patron de 0002/0003/0007/0008 sin excepciones: `tenant_id` en toda
-- fila y como columna LIDER de todo indice, RLS `ENABLE` + `FORCE` con politica
-- `FOR ALL` que declara `USING` y `WITH CHECK`.
--
-- ----------------------------------------------------------------------------
-- POR QUE LAS COLUMNAS SE LLAMAN `given_text` / `when_text` / `then_text`
-- ----------------------------------------------------------------------------
-- `WHEN` y `THEN` son palabras RESERVADAS en Postgres. Como columnas exigirian
-- comillas dobles en cada consulta que las toque, para siempre, y la primera vez
-- que alguien escriba `SELECT then FROM ...` a mano se encontrara un error de
-- sintaxis desconcertante. El nombre de dominio (`given` / `when` / `then`) vive
-- en el tipo de TypeScript, que es donde se lee; el mapeo esta en
-- `packages/db/src/acceptance-criteria.ts`.
--
-- ----------------------------------------------------------------------------
-- EL `content_hash`: POR QUE LA APROBACION CADUCA SOLA
-- ----------------------------------------------------------------------------
-- ESTE ES EL PUNTO IMPORTANTE DE LA MIGRACION.
--
-- El tercer criterio de aceptacion de T01 pide que un cambio en los criterios
-- despues de aprobados "requiera re-aprobacion". La forma ingenua es una
-- columna `approved boolean` que alguien tenga que poner a false al editar. Esa
-- forma depende de la DISCIPLINA de quien edita, y la disciplina falla: basta un
-- UPDATE directo, una migracion de datos o una ruta de codigo nueva que no se
-- acuerde de revocar, y queda una aprobacion viva sobre unos criterios que nadie
-- aprobo. Eso es peor que no tener aprobacion, porque parece que la hay.
--
-- Aqui la aprobacion NO apunta a "esta tarea": apunta al CONTENIDO EXACTO que se
-- aprobo, por su hash. La comprobacion es "¿el hash de los criterios que hay
-- ahora coincide con el hash que se aprobo?". Si alguien toca una coma, deja de
-- coincidir y la aprobacion queda obsoleta SIN QUE NADIE HAGA NADA. No hay
-- ningun camino —ni un UPDATE a pelo— que deje una aprobacion viva sobre un
-- contenido distinto del aprobado.
--
-- El hash lo calcula `computeCriteriaContentHash` en
-- `packages/db/src/acceptance-criteria.ts`, y su definicion es (resumen; el
-- detalle esta alli, porque un solo sitio puede ser la fuente de verdad):
--
--     sha256( JSON de [[ordinal, given, when, then], ...] ordenado por ordinal )
--
-- con cada texto normalizado a NFC, sin espacios en los extremos y con las
-- rachas internas de espacio colapsadas a uno. La normalizacion existe para que
-- el hash sea estable ante lo que no cambia el significado (reindentar un
-- criterio, pegarlo desde un editor que usa otra forma Unicode) y solo ante eso:
-- cambiar una palabra cambia el hash.
--
-- `revoked_at` sigue existiendo para la revocacion EXPLICITA ("me equivoque al
-- aprobar"), que es otra cosa distinta de la caducidad por contenido.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- acceptance_criteria
-- ----------------------------------------------------------------------------
CREATE TABLE acceptance_criteria (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Referencia a la tarea: el numero del issue de GitHub (como texto) o un slug
  -- de la fase de diseño, cuando todavia no hay issue. Es texto y no un entero
  -- justamente por ese segundo caso: la cadena de trazabilidad de CLAUDE.md 2.2
  -- empieza antes de que exista el issue.
  task_ref    text        NOT NULL,

  -- Posicion del criterio dentro de la tarea, empezando en 1. Es parte de la
  -- identidad (y del hash) porque el orden en el que se leen los criterios es
  -- informacion: "el tercer criterio" tiene que significar siempre lo mismo.
  ordinal     integer     NOT NULL CHECK (ordinal >= 1),

  given_text  text        NOT NULL,
  when_text   text        NOT NULL,
  then_text   text        NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Quien lo escribio. Puede ser un agente, y por eso es texto libre acotado y
  -- no una clave ajena a `users`: proponer criterios si lo puede hacer un
  -- agente. APROBARLOS no (ver la otra tabla).
  created_by  text        NOT NULL CHECK (length(btrim(created_by)) BETWEEN 1 AND 200),

  CONSTRAINT acceptance_criteria_tenant_id_id_key UNIQUE (tenant_id, id),

  -- La unicidad que pide T01. Ademas de identidad, es lo que garantiza que el
  -- hash del conjunto es reproducible: no puede haber dos criterios peleandose
  -- por el mismo hueco.
  CONSTRAINT acceptance_criteria_tenant_task_ordinal_key
    UNIQUE (tenant_id, task_ref, ordinal),

  -- `task_ref` entra por una frontera de confianza (lo elige quien llama) y
  -- ademas viaja al hash y a los mensajes de error. Se acota tambien aqui, no
  -- solo en zod: dos capas, como en `claims`.
  CONSTRAINT acceptance_criteria_task_ref_is_well_formed CHECK (
    task_ref = btrim(task_ref)
    AND length(task_ref) BETWEEN 1 AND 200
    AND task_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#-]*$'
  ),

  -- Un criterio con cualquiera de las tres partes vacia no es un criterio. El
  -- CHECK cubre lo comprobable por el motor; la heuristica de "observable y
  -- acotado" vive en el codigo y esta documentada alli como lo que es: una
  -- heuristica, no una garantia.
  CONSTRAINT acceptance_criteria_parts_are_not_empty CHECK (
    length(btrim(given_text)) BETWEEN 1 AND 2000
    AND length(btrim(when_text)) BETWEEN 1 AND 2000
    AND length(btrim(then_text)) BETWEEN 1 AND 2000
  )
);

COMMENT ON TABLE acceptance_criteria IS
  'Criterios de aceptacion Given/When/Then por tarea. Una tarea sin criterios APROBADOS no se puede reclamar (ver packages/graph/src/claims.ts).';
COMMENT ON COLUMN acceptance_criteria.task_ref IS
  'Numero de issue de GitHub (como texto) o slug de la tarea cuando el issue todavia no existe.';
COMMENT ON COLUMN acceptance_criteria.ordinal IS
  'Posicion dentro de la tarea, desde 1. Entra en el hash del conjunto: reordenar los criterios es cambiarlos.';
COMMENT ON COLUMN acceptance_criteria.created_by IS
  'Quien redacto el criterio. Puede ser un agente: proponer criterios si lo puede hacer un agente, aprobarlos no (CLAUDE.md 2.1).';

-- ----------------------------------------------------------------------------
-- acceptance_criteria_approvals
-- ----------------------------------------------------------------------------
CREATE TABLE acceptance_criteria_approvals (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  task_ref     text        NOT NULL,

  -- Hash del CONJUNTO de criterios que se aprobo. Ver la cabecera: es lo que
  -- hace que la aprobacion caduque sola cuando los criterios cambian.
  content_hash text        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),

  -- Un HUMANO. Clave ajena COMPUESTA contra `users`, que lleva el tenant: sin el
  -- tenant en la clave, una fila podria apuntar a un usuario de otro cliente y
  -- la RLS no lo impediria (la politica filtra lo que LEES, no a que apuntas).
  -- Que sea `users` y no texto libre es la mitad estructural de "ningun agente
  -- aprueba su propio trabajo" (CLAUDE.md 2.1); la otra mitad es RBAC y todavia
  -- no existe.
  approved_by  uuid        NOT NULL,
  approved_at  timestamptz NOT NULL DEFAULT now(),

  -- Revocacion EXPLICITA ("aprobe por error"). Distinta de la caducidad por
  -- contenido, que no necesita escribir nada.
  revoked_at   timestamptz,

  CONSTRAINT acceptance_criteria_approvals_tenant_id_id_key UNIQUE (tenant_id, id),

  CONSTRAINT acceptance_criteria_approvals_approver_fkey
    FOREIGN KEY (tenant_id, approved_by) REFERENCES users (tenant_id, id) ON DELETE RESTRICT,

  CONSTRAINT acceptance_criteria_approvals_task_ref_is_well_formed CHECK (
    task_ref = btrim(task_ref)
    AND length(task_ref) BETWEEN 1 AND 200
    AND task_ref ~ '^[A-Za-z0-9][A-Za-z0-9._/#-]*$'
  ),

  CONSTRAINT acceptance_criteria_approvals_revoked_after_approved CHECK (
    revoked_at IS NULL OR revoked_at >= approved_at
  )
);

COMMENT ON TABLE acceptance_criteria_approvals IS
  'Aprobacion humana de un CONJUNTO concreto de criterios, identificado por su hash. Si los criterios cambian, el hash deja de casar y la aprobacion queda obsoleta sin que nadie tenga que revocarla.';
COMMENT ON COLUMN acceptance_criteria_approvals.content_hash IS
  'sha256 del conjunto de criterios normalizado. Lo calcula computeCriteriaContentHash en packages/db/src/acceptance-criteria.ts, que es la unica fuente de verdad del algoritmo.';
COMMENT ON COLUMN acceptance_criteria_approvals.revoked_at IS
  'Revocacion explicita. La caducidad por cambio de contenido NO pasa por aqui: no escribe nada, simplemente el hash deja de coincidir.';

-- Como mucho una aprobacion VIVA por (tarea, contenido). Aprobar dos veces lo
-- mismo no es un evento nuevo, y dos filas vivas identicas solo servirian para
-- que "quien aprobo esto" tuviera dos respuestas.
CREATE UNIQUE INDEX acceptance_criteria_approvals_live_idx
  ON acceptance_criteria_approvals (tenant_id, task_ref, content_hash)
  WHERE revoked_at IS NULL;

-- La consulta caliente: "¿esta tarea tiene aprobacion viva?", que se ejecuta en
-- cada intento de claim.
CREATE INDEX acceptance_criteria_approvals_tenant_task_approved_at_idx
  ON acceptance_criteria_approvals (tenant_id, task_ref, approved_at DESC)
  WHERE revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, con la MISMA politica que el resto del esquema.
-- Los criterios de aceptacion describen que hace el producto de un cliente y
-- quien lo aprobo: no cruzan la frontera entre clientes.
-- ----------------------------------------------------------------------------
ALTER TABLE acceptance_criteria ENABLE ROW LEVEL SECURITY;
ALTER TABLE acceptance_criteria FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON acceptance_criteria
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE acceptance_criteria_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE acceptance_criteria_approvals FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON acceptance_criteria_approvals
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Permisos de app_runtime, explicitos como en 0002, 0006, 0007 y 0008.
GRANT SELECT, INSERT, UPDATE, DELETE ON acceptance_criteria TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON acceptance_criteria_approvals TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS acceptance_criteria_approvals;
DROP TABLE IF EXISTS acceptance_criteria;
