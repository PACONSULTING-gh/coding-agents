-- Up Migration
-- ============================================================================
-- 0011 — Estado del flujo de verificacion (epic 05 / T06, ADR 0008).
--
-- UNA FILA POR TAREA. Es ESTADO, no historico: dice DONDE esta la tarea, no lo
-- que le ha pasado. El historico vive en `audit_log`, que es append-only y ya
-- existe para eso.
--
-- POR QUE UNA TABLA Y NO DERIVARLO DEL LOG. "¿Cuantos intentos lleva esta
-- tarea?" es una consulta que se hace en CADA entrega, y derivarla contando
-- entradas de un log que crece sin limite convierte la lectura de una fila en
-- un recuento. Ademas el estado deja de verse de un vistazo, que es justo lo
-- que necesita quien opera esto.
-- ============================================================================

CREATE TABLE verification_flow (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Misma forma que en `acceptance_criteria`: numero de issue como texto, o un
  -- slug de la fase de diseño cuando todavia no hay issue.
  task_ref    text        NOT NULL,

  -- Intentos del AGENTE ya consumidos. Un fallo de infraestructura
  -- (`verifier_unavailable`) NO lo incrementa: no es trabajo mal hecho, y
  -- gastarle el presupuesto al agente por un rechazo del modelo escalaria
  -- tareas sanas con un diagnostico falso (ADR 0008, decision 1).
  attempts    integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),

  -- Donde esta la tarea. Los valores son los de `FlowDestination` en
  -- packages/core, mas `awaiting_verification` para "entregada y sin juzgar".
  state       text        NOT NULL
              CHECK (state IN ('awaiting_verification', 'same_agent', 'criteria_phase', 'human', 'done')),

  -- El ultimo resultado de verificacion. Valores de `VerificationOutcome`.
  last_outcome text
              CHECK (last_outcome IS NULL OR last_outcome IN (
                'gate_failed', 'verifier_fail', 'verifier_no_evidence',
                'verifier_unavailable', 'passed'
              )),

  -- SOBRE QUE codigo se emitio el ultimo veredicto. Sin esto, un estado pegado
  -- a una tarea no dice a que entrega se refiere.
  last_head_sha text,

  -- Quien responde de la tarea, resuelto por la cadena holder-del-claim ->
  -- assignee-del-issue. NULL es un valor legitimo y NO se rellena con alguien
  -- plausible: una tarea que falla sin dueño es en si misma un hallazgo, y el
  -- aviso lo dice en voz alta (ADR 0008, decision 4).
  responsible jsonb,

  -- Cuantas veces ha salido SIN_EVIDENCIA cada criterio, POR CRITERIO.
  -- {"tc01-dead-letter": 2}. Por criterio y no por tarea porque dos criterios
  -- distintos fallando una vez cada uno NO son un spec ambiguo: lo que delata
  -- un criterio imposible de observar es el MISMO repitiendo.
  no_evidence_by_criterion jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  -- Una sola fila por tarea y tenant: es estado, no bitacora.
  CONSTRAINT verification_flow_tenant_task_key UNIQUE (tenant_id, task_ref)
);

-- Para la vista de "que hay escalado ahora mismo", que es la consulta que hara
-- cualquier panel o resumen por CLI.
CREATE INDEX verification_flow_tenant_state_updated_at_idx
  ON verification_flow (tenant_id, state, updated_at DESC);

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, con la MISMA politica que el resto del esquema.
-- Este estado dice que tareas de un cliente estan atascadas y en manos de
-- quien: no cruza la frontera entre clientes.
-- ----------------------------------------------------------------------------
ALTER TABLE verification_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE verification_flow FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON verification_flow
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

-- Permisos de app_runtime, explicitos como en 0002, 0006, 0007, 0008 y 0010.
GRANT SELECT, INSERT, UPDATE, DELETE ON verification_flow TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS verification_flow;
