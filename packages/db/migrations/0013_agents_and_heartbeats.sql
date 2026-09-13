-- Up Migration
-- ============================================================================
-- 0013 — Agentes, sus latidos y la cola de comandos (epic 04 / T01).
--
-- PUSH, NO POLLING. El hub no puede alcanzar los portatiles: duermen, estan
-- tras NAT y cambian de red. El daemon empuja cada 30-60 s y los comandos del
-- hub viajan de vuelta EN LA RESPUESTA DEL PROPIO LATIDO. Por eso hay una cola
-- de comandos por agente y no un canal abierto: no hay canal que abrir.
--
-- UNA FILA POR AGENTE, NO UN HISTORICO DE LATIDOS. El estado se deriva del
-- TIEMPO DESDE EL ULTIMO latido, asi que guardar los anteriores seria acumular
-- millones de filas para no leer ninguna. Lo que merezca historico va al
-- `audit_log`, que ya existe para eso.
-- ============================================================================

CREATE TABLE agents (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

  -- Identidad del agente DENTRO del tenant. Es la que usan los claims como
  -- `holder_id`, para que la vista de equipo pueda cruzar "quien tiene que" con
  -- "como va".
  agent_key   text        NOT NULL,
  label       text        NOT NULL,

  -- SHA-256 del token, NUNCA el token. Si esta tabla se filtra, lo que se lleva
  -- el atacante no sirve para latir en nombre de nadie. El token se enseña una
  -- sola vez, al crear el agente, y no se puede volver a leer.
  token_hash  text        NOT NULL,

  -- Revocacion INDIVIDUAL, que es el segundo criterio de aceptacion de T01.
  -- Se marca en vez de borrar la fila: un agente revocado sigue teniendo
  -- historia que alguien puede querer mirar.
  revoked_at  timestamptz,

  -- El ultimo latido. NULL = nunca ha latido, que NO es lo mismo que "lleva
  -- mucho sin latir": un agente recien dado de alta no esta desaparecido.
  last_beat_at timestamptz,

  -- Lo que venia en el ultimo latido: tarea, rama, tokens, coste, ultima
  -- llamada a herramienta. Es jsonb y no columnas porque la telemetria de cada
  -- agente de codigo es distinta y va a cambiar mas que el esquema.
  telemetry   jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agents_tenant_key_unique UNIQUE (tenant_id, agent_key)
);

-- Para la vista de equipo: "quien esta vivo y desde cuando", por tenant.
CREATE INDEX agents_tenant_last_beat_idx ON agents (tenant_id, last_beat_at DESC NULLS LAST);

-- El token se busca por su hash en cada latido. Va acotado por tenant, y puede
-- estarlo porque el TOKEN LLEVA EL TENANT DELANTE (`<tenantId>.<secreto>`): el
-- prefijo dice donde buscar y el hash del token entero es lo que autentica.
--
-- Se llego aqui por el gate de aislamiento, que exige `tenant_id` como primera
-- columna de todo indice. La primera version era un indice GLOBAL sobre el hash
-- —habria hecho falta declarar una excepcion— y resulto ser innecesaria: si el
-- prefijo ya dice el tenant, el indice tambien puede llevarlo.
CREATE UNIQUE INDEX agents_tenant_token_hash_idx ON agents (tenant_id, token_hash);

-- ----------------------------------------------------------------------------
-- La cola de comandos. Se vacia en la respuesta del latido.
-- ----------------------------------------------------------------------------
CREATE TABLE agent_commands (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  agent_id     uuid        NOT NULL REFERENCES agents (id) ON DELETE CASCADE,

  -- Que se le pide. `nudge` es el aviso que encola el clasificador cuando ve un
  -- atasco (T03, criterio 3).
  kind         text        NOT NULL CHECK (kind IN ('nudge', 'stop', 'message')),
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Cuando se ENTREGO en una respuesta de latido. NULL = pendiente.
  --
  -- Se marca y no se borra a proposito: si el daemon no llega a aplicarlo,
  -- borrarlo dejaria sin rastro un comando que nadie ejecuto, y el hub creeria
  -- que se hizo.
  delivered_at timestamptz
);

-- La consulta de cada latido: los pendientes de ESTE agente, en orden.
CREATE INDEX agent_commands_pending_idx
  ON agent_commands (tenant_id, agent_id, created_at)
  WHERE delivered_at IS NULL;

-- ----------------------------------------------------------------------------
-- RLS: habilitada Y forzada, igual que el resto del esquema.
-- Quien tiene un agente corriendo y que esta haciendo no cruza entre clientes.
-- ----------------------------------------------------------------------------
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

ALTER TABLE agent_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_commands FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_commands
  FOR ALL
  USING      (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON agents         TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_commands TO app_runtime;

-- Down Migration
DROP TABLE IF EXISTS agent_commands;
DROP TABLE IF EXISTS agents;
