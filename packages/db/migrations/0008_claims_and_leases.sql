-- Up Migration
-- ============================================================================
-- 0008 — Claims y leases sobre issues y ficheros (T04 del epic 02).
--
-- Un claim reserva un SUJETO (un issue, o un fichero) dentro de un repositorio
-- de un tenant, para un TITULAR (una persona o un agente), durante un tiempo
-- acotado. Es la pieza que evita que dos agentes de dos desarrolladores
-- distintos se pisen (problema 2 de CLAUDE.md 1).
--
-- Sigue el patron de 0002/0003/0007 sin excepciones: `tenant_id` en toda fila y
-- como columna LIDER de todo indice, `UNIQUE (tenant_id, id)` para poder ser
-- referenciada con clave ajena compuesta, y RLS `ENABLE` + `FORCE` con politica
-- `FOR ALL` que declara `USING` y `WITH CHECK`.
--
-- ----------------------------------------------------------------------------
-- POR QUE EL LEASE ES UNA FILA CON `expires_at` Y NO UN ADVISORY LOCK DE SESION
-- ----------------------------------------------------------------------------
-- LEE ESTO ANTES DE "SIMPLIFICAR" ESTA TABLA. Esta explicado largo en
-- `docs/adr/0004-claims-como-lease-en-tabla.md`; el resumen:
--
--   * `pg_advisory_xact_lock` se libera en el COMMIT. No puede sostener una
--     reserva que dura minutos, ni tener TTL.
--   * `pg_advisory_lock` (de SESION) si persiste, pero corremos detras de
--     PgBouncer en MODO TRANSACCION (CLAUDE.md 3): la conexion logica no esta
--     atada a un backend fisico, asi que el lock se quedaria pegado en un
--     backend que despues sirve a OTRO tenant. Es exactamente el mismo motivo
--     por el que la capa de acceso usa `set_config(..., true)` y no un `SET` de
--     sesion (ver la cabecera de `packages/db/src/client.ts`).
--
-- Por tanto: la FUENTE DE VERDAD del lease es esta tabla. Un claim esta VIVO si
--
--     released_at IS NULL AND expires_at > now()
--
-- y caduca SOLO. No hace falta que corra ningun proceso de limpieza para que la
-- correccion se cumpla; la purga periodica solo recorta el historico.
--
-- ----------------------------------------------------------------------------
-- COMO SE GARANTIZA "UN SOLO CLAIM VIVO POR SUJETO" SIN `now()` EN UN INDICE
-- ----------------------------------------------------------------------------
-- ESTE ES EL PUNTO DELICADO DE LA TABLA.
--
-- El indice que uno querria escribir es este, y NO SE PUEDE:
--
--     UNIQUE (tenant_id, repo_id, subject_kind, subject_key)
--       WHERE released_at IS NULL AND expires_at > now()   -- <-- ILEGAL
--
-- El predicado de un indice parcial tiene que ser INMUTABLE, y `now()` no lo
-- es: depende de la transaccion. Postgres lo rechaza (42P17), y con razon: si
-- lo aceptara, la pertenencia de una fila al indice cambiaria sola con el paso
-- del tiempo y el indice quedaria desincronizado de la tabla.
--
-- La solucion que se implementa aqui tiene DOS piezas que se refuerzan:
--
--   1. `released_at` se convierte en la marca de "ya no vale", y la escribe
--      TAMBIEN la caducidad, no solo una liberacion explicita. La operacion de
--      reclamar, dentro de su transaccion y bajo el advisory lock del punto 2,
--      hace primero un SEGADO (`released_reason = 'expired'`) de los claims del
--      sujeto que ya pasaron su `expires_at`, y despues inserta. El segado es un
--      paso EN LINEA de la propia operacion, no un proceso de fondo: la
--      correccion no depende de que nadie mas corra.
--
--      Con eso, el indice parcial ya puede ser inmutable y sigue significando
--      lo que queremos:
--
--          UNIQUE (tenant_id, repo_id, subject_kind, subject_key)
--            WHERE released_at IS NULL
--
--      Es una restriccion ESTRICTAMENTE MAS FUERTE que "un vivo por sujeto":
--      prohibe incluso dos claims sin liberar sobre el mismo sujeto aunque uno
--      de ellos ya hubiera caducado. Y la impone el motor, no el codigo.
--
--   2. `pg_advisory_xact_lock` sobre `(tenant_id, repo_id)`, tomado al principio
--      de la transaccion que reclama o renueva. Serializa el segado + la
--      comprobacion + la insercion, que sin el serian tres pasos con ventanas
--      entre ellos. Es TRANSACCIONAL: se suelta en el COMMIT, asi que entre
--      transacciones NO QUEDA NINGUN ADVISORY LOCK RETENIDO (criterio de
--      aceptacion de T04, comprobado contra `pg_locks` en los tests) y funciona
--      bajo PgBouncer en modo transaccion.
--
-- El punto 2 da un RECHAZO LIMPIO ("lo tiene Ana desde las 10:03") en vez de una
-- violacion de unicidad en bruto; el punto 1 es la red que sigue ahi aunque el
-- codigo de aplicacion se equivoque. Ninguno de los dos sobra.
--
-- ----------------------------------------------------------------------------
-- POR QUE NO HAY `created_at`
-- ----------------------------------------------------------------------------
-- `claimed_at` ES el instante de creacion, y ademas es el que tiene significado
-- de dominio: es el "desde cuando" que hay que poder responderle a quien choca
-- con un claim ajeno. Dos columnas con el mismo valor son dos columnas que
-- tarde o temprano divergen. `updated_at` si existe, porque `renew` y `release`
-- modifican la fila de verdad.
-- ============================================================================

CREATE TABLE claims (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Un `claim(...)` reserva un issue Y, opcionalmente, un conjunto de ficheros.
  -- Cada sujeto es su propia fila (para que el indice de unicidad trabaje por
  -- sujeto), y todas comparten `claim_group_id`: es lo que hace que liberar o
  -- renovar sea una sola operacion sobre el arriendo entero y no queden
  -- ficheros bloqueados detras de un issue ya liberado.
  claim_group_id  uuid        NOT NULL,

  repo_id         uuid        NOT NULL,
  subject_kind    text        NOT NULL CHECK (subject_kind IN ('issue', 'file')),
  subject_key     text        NOT NULL CHECK (length(subject_key) BETWEEN 1 AND 1024),

  holder_kind     text        NOT NULL CHECK (holder_kind IN ('user', 'agent')),
  holder_id       text        NOT NULL CHECK (length(btrim(holder_id)) BETWEEN 1 AND 200),
  -- Sin esto no se puede cumplir el criterio de aceptacion "recibe aviso con
  -- QUIEN lo tiene": `holder_id` puede ser un uuid o el identificador de un
  -- proceso, y ninguno de los dos se le puede ensenar a una persona.
  holder_label    text        NOT NULL CHECK (length(btrim(holder_label)) BETWEEN 1 AND 200),

  claimed_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  released_at     timestamptz,
  released_reason text        CHECK (released_reason IN ('released', 'expired')),
  metadata        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT claims_tenant_id_id_key UNIQUE (tenant_id, id),

  -- Un arriendo con duracion cero o negativa no es un arriendo.
  CONSTRAINT claims_expires_after_claimed CHECK (expires_at > claimed_at),

  -- `released_at` y `released_reason` van juntos o no van: un claim liberado sin
  -- motivo no deja saber si el agente termino o si se le acabo el TTL, y esa es
  -- justamente la pregunta que se le hace a esta tabla al supervisar.
  CONSTRAINT claims_release_is_complete
    CHECK ((released_at IS NULL) = (released_reason IS NULL)),

  -- La clave del sujeto entra por una frontera de confianza (el numero de issue
  -- o la ruta la elige quien llama). Se valida tambien en el codigo con zod,
  -- pero una ruta absoluta o con `..` en el grafo compartido es una fuga de la
  -- maquina del desarrollador, y de esas no se recorta ninguna capa
  -- (CLAUDE.md 2.4).
  CONSTRAINT claims_subject_key_is_well_formed CHECK (
    CASE subject_kind
      WHEN 'issue' THEN subject_key ~ '^[1-9][0-9]{0,9}$'
      WHEN 'file'  THEN subject_key !~ '^/'
                    AND subject_key !~ '(^|/)\.\.(/|$)'
                    AND subject_key = btrim(subject_key)
                    AND length(subject_key) > 0
      ELSE false
    END
  )
);

COMMENT ON TABLE claims IS
  'Reservas con arriendo (lease) sobre issues y ficheros. Un claim esta VIVO si released_at IS NULL AND expires_at > now(); caduca solo, sin necesidad de ningun proceso de limpieza.';
COMMENT ON COLUMN claims.claim_group_id IS
  'Agrupa las filas de un mismo claim(): el issue y los ficheros que reservo. Liberar y renovar trabajan sobre el grupo entero.';
COMMENT ON COLUMN claims.subject_key IS
  'Numero de issue (como texto) o ruta RELATIVA a la raiz del repo. Nunca una ruta absoluta: filtraria la maquina del desarrollador al grafo compartido.';
COMMENT ON COLUMN claims.holder_label IS
  'Nombre legible del titular. Es lo que se le ensena a quien choca con el claim; holder_id no se le puede ensenar a nadie.';
COMMENT ON COLUMN claims.expires_at IS
  'Fuente de verdad del arriendo. Pasado este instante el claim deja de contar AUNQUE released_at siga a NULL: si el agente muere, el claim se libera solo.';
COMMENT ON COLUMN claims.released_reason IS
  '`released` = alguien lo solto a proposito. `expired` = se le acabo el TTL y lo sego la siguiente operacion de reclamar. Distinguirlos es lo que permite supervisar sin leer el diff.';

-- ----------------------------------------------------------------------------
-- Unicidad de los claims sin liberar. Ver la cabecera: el predicado NO puede
-- llevar `now()`, y por eso la caducidad se materializa en `released_at`
-- durante la propia transaccion que reclama.
-- ----------------------------------------------------------------------------
CREATE UNIQUE INDEX claims_live_subject_idx
  ON claims (tenant_id, repo_id, subject_kind, subject_key)
  WHERE released_at IS NULL;

COMMENT ON INDEX claims_live_subject_idx IS
  'Como mucho un claim SIN LIBERAR por sujeto. Es la red del motor: aunque el codigo se saltase el advisory lock, dos reclamaciones simultaneas del mismo sujeto no pueden coexistir.';

-- Listado de claims vivos de un repo (la "vista de claims activos" de T04) y
-- segado de los caducados: los dos entran por (tenant_id, repo_id) y filtran
-- por expires_at.
CREATE INDEX claims_tenant_id_repo_id_expires_at_idx
  ON claims (tenant_id, repo_id, expires_at DESC)
  WHERE released_at IS NULL;

-- "Que tiene cogido Ana ahora mismo".
CREATE INDEX claims_tenant_id_holder_id_expires_at_idx
  ON claims (tenant_id, holder_id, expires_at DESC)
  WHERE released_at IS NULL;

-- Liberar y renovar trabajan sobre el grupo entero.
CREATE INDEX claims_tenant_id_claim_group_id_idx
  ON claims (tenant_id, claim_group_id);

CREATE TRIGGER claims_set_updated_at BEFORE UPDATE ON claims
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, con la MISMA politica que el resto del esquema.
-- Un claim dice quien de que equipo esta tocando que fichero de que repo: es
-- justo el tipo de dato que no puede cruzar la frontera entre clientes.
-- ----------------------------------------------------------------------------
ALTER TABLE claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE claims FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON claims
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Permisos de app_runtime, explicitos como en 0002, 0006 y 0007.
GRANT SELECT, INSERT, UPDATE, DELETE ON claims TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS claims;
