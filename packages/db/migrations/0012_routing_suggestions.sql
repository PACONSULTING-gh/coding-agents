-- Up Migration
-- ============================================================================
-- 0012 — Sugerencias del router y lo que paso con ellas (epic 03 / T04).
--
-- Una fila por tarea: que sugirio el router, a quien se asigno al final, y
-- cuando. Es la validacion del supuesto del PRD §6 —que el reparto asistido
-- acierta lo bastante como para que el lead lo use en vez de ignorarlo— y por
-- tanto la unica evidencia de si el epic 03 valia la pena.
--
-- LO QUE AQUI NO SE DECIDE: como se cuenta. La regla (que entra en el
-- denominador, cuando salta la alerta, que muestra minima hace falta) vive en
-- packages/core/src/routing-accuracy.ts y es pura. Esta tabla solo guarda los
-- hechos; discutir la metrica es discutir aquel fichero, no esta consulta.
-- ============================================================================

CREATE TABLE routing_suggestions (
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Misma forma que en el resto del esquema: numero de issue como texto, o un
  -- slug de la fase de diseño cuando todavia no hay issue.
  task_ref       text        NOT NULL,

  -- El candidato del PUESTO 1, y solo ese. NULL cuando el router dijo
  -- `no_match`, que es una respuesta legitima y NO un fallo suyo.
  suggested_first text,
  -- Por que se rindio. Solo tiene sentido cuando `suggested_first` es NULL.
  no_match_reason text,

  -- El shortlist entero tal como se publico. Se guarda aunque la metrica solo
  -- mire el puesto 1: el dia que alguien pregunte "¿y estaba el segundo?", el
  -- dato tiene que existir ya. Reconstruirlo despues es imposible.
  entries        jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Con que modelo se sugirio. Sin esto, comparar tasas entre semanas mezcla
  -- cambios de modelo con cambios de calidad.
  model          text,

  suggested_at   timestamptz NOT NULL DEFAULT now(),

  -- A quien se asigno DE VERDAD. NULL mientras nadie haya decidido: eso NO es
  -- una anulacion, es que no hay decision todavia (ver routing-accuracy.ts).
  assigned_to    text,
  assigned_at    timestamptz,

  -- Una sugerencia por tarea. Si el router vuelve a correr sobre el mismo
  -- issue, sustituye a la anterior: lo que se mide es "que se sugirio para
  -- esta tarea", no un historico de intentos.
  CONSTRAINT routing_suggestions_tenant_task_key UNIQUE (tenant_id, task_ref),

  -- Coherencia de los dos campos que van juntos: o hay candidato, o hay motivo
  -- de rendicion. Ni las dos cosas ni ninguna.
  CONSTRAINT routing_suggestions_first_or_reason CHECK (
    (suggested_first IS NOT NULL AND no_match_reason IS NULL) OR
    (suggested_first IS NULL     AND no_match_reason IS NOT NULL)
  ),

  -- Y si hay asignado, hay fecha.
  CONSTRAINT routing_suggestions_assigned_pair CHECK (
    (assigned_to IS NULL AND assigned_at IS NULL) OR
    (assigned_to IS NOT NULL AND assigned_at IS NOT NULL)
  )
);

-- La consulta de la metrica es siempre "las de la ultima semana".
CREATE INDEX routing_suggestions_tenant_suggested_at_idx
  ON routing_suggestions (tenant_id, suggested_at DESC);

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, con la MISMA politica que el resto del esquema.
-- Esto dice a quien se le sugiere el trabajo de un cliente y quien lo acaba
-- cogiendo: no cruza la frontera entre clientes.
-- ----------------------------------------------------------------------------
ALTER TABLE routing_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE routing_suggestions FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON routing_suggestions
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Permisos de app_runtime, explicitos como en 0002, 0006, 0007, 0008, 0010 y 0011.
GRANT SELECT, INSERT, UPDATE, DELETE ON routing_suggestions TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS routing_suggestions;
