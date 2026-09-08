# Epic 04 — Heartbeats, estado de agentes y predicción de colisiones

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 3
**Depende de:** Epic 02 cerrado
**Objetivo:** saber si un agente está vivo, avanzando o atascado, sin mirar la
terminal — y avisar de una colisión antes de que alguien empiece a trabajar.

---

## Enfoque técnico

**Push, no polling.** El hub no puede alcanzar los portátiles: duermen, están
tras NAT, cambian de red. El daemon local empuja cada 30-60 segundos y los
comandos del hub viajan de vuelta en la respuesta del propio heartbeat. Esto
elimina la necesidad de túneles, VPN o brokers.

La ausencia de heartbeat es la señal de fallo, no una respuesta negativa a un
ping.

**Salud es más que "vivo":** bucles (misma llamada a herramienta repetida),
estancamiento (sin cambios en ficheros pese a actividad), quema anómala de
tokens, contexto casi agotado.

**La predicción de colisiones antes de codear es experimental.** La literatura
no llega a precisión de producción. Va como **aviso, nunca como bloqueo**, y se
mide su recall antes de endurecerla.

---

## Tareas

### T01 — Endpoint de heartbeat y modelo de estado
**Paralelizable:** no (bloquea T02)
**Depende de:** —
**Toca:** `apps/webhook/`, `packages/db/`

Endpoint HTTPS autenticado que recibe heartbeats, hace upsert idempotente y
devuelve comandos pendientes en la misma respuesta. Un token por agente,
revocable individualmente. Estados derivados del tiempo desde el último latido.

**Criterios de aceptación:**
- Dado un heartbeat válido, cuando llega, entonces se registra y la respuesta
  incluye los comandos encolados para ese agente.
- Dado un token revocado, cuando se usa, entonces se rechaza.
- Dado un agente sin latir durante 2-3 minutos, cuando consulto su estado,
  entonces figura como obsoleto, no como muerto.
- Dado un portátil que estuvo suspendido, cuando vuelve, entonces se reincorpora
  sin intervención manual.

---

### T02 — Daemon companion local
**Paralelizable:** no
**Depende de:** T01
**Toca:** `apps/daemon/`

Servicio (launchd/systemd) en la máquina de cada desarrollador. Empuja
heartbeats. Se engancha a los hooks de ciclo de vida del agente de código y a su
telemetría para enriquecer el latido: tokens consumidos, coste acumulado,
ficheros modificados, última llamada a herramienta.

**Criterios de aceptación:**
- Dado el daemon instalado, cuando arranca la máquina, entonces se levanta solo.
- Dada una sesión de agente en curso, cuando late, entonces el latido incluye
  tarea actual, rama, tokens, coste y momento del último cambio en ficheros.
- Dado un comando devuelto por el hub, cuando llega, entonces el daemon lo
  aplica sobre la sesión del agente.
- Dado un fallo de red, cuando ocurre, entonces reintenta con backoff y no
  bloquea el trabajo del desarrollador.

---

### T03 — Clasificador de estado
**Paralelizable:** sí (con T04)
**Depende de:** T02
**Toca:** `packages/agents/heartbeat/`

Agente clasificador sobre el modelo más barato disponible, sin extended
thinking, con salida estructurada de enum: FINE / NEEDS_NUDGE / STUCK / DONE /
ESCALATE. Prompt estático cacheado, con la telemetría cambiante siempre
**después** del punto de caché.

Definiciones operativas de cada etiqueta, no interpretaciones: STUCK es la misma
llamada a herramienta repetida N veces sin cambio de estado; NEEDS_NUDGE es
inactividad recuperable; ESCALATE es fallo repetido o evento de seguridad.

**Criterios de aceptación:**
- Dado un lote de sesiones etiquetadas a mano, cuando el clasificador las
  procesa, entonces coincide con la etiqueta humana en más del 90%.
- Dado el prompt, cuando mido el uso de caché, entonces la parte estática se
  cachea y la telemetría con timestamp queda fuera del punto de caché.
- Dado un estado STUCK, cuando se detecta, entonces se encola un mensaje de
  aviso que viajará en el siguiente heartbeat.
- Dado un coste por invocación, cuando lo mido, entonces es despreciable frente
  al presupuesto total.

---

### T04 — Predicción de afectados antes de codear
**Paralelizable:** sí (con T03)
**Depende de:** Epic 02 T05
**Toca:** `packages/agents/collision/`

Recuperación sobre el grafo desde el texto de la tarea, expansión de vecindario,
overlay de co-change, y una pasada de LLM que planifica y predice, restringida
al subgrafo recuperado para limitar alucinación. Salida: conjunto de ficheros
probables, con confianza y procedencia por fichero.

**Criterios de aceptación:**
- Dada una tarea, cuando se predicen afectados, entonces cada fichero indica por
  qué se incluyó (arista de import, llamada, o co-cambio histórico).
- Dada una predicción, cuando se cruza con los claims activos, entonces se avisa
  del solapamiento **como aviso, nunca bloqueando**.
- Dado un conjunto de PRs ya mergeados del repo, cuando mido recall de la
  predicción contra los ficheros realmente cambiados, entonces el número queda
  registrado.
- Dado un recall por debajo de 0.85, entonces la predicción permanece como aviso
  y no se promociona a gate.

---

### T05 — Vista de estado del equipo
**Paralelizable:** no
**Depende de:** T03
**Toca:** `apps/worker/`

La vista mínima que responde "quién está haciendo qué y cómo va". En la v1 puede
ser un comentario recurrente, un resumen por CLI o un canal — **no una UI
propia**, que está fuera de alcance del PRD.

**Criterios de aceptación:**
- Dado el equipo trabajando, cuando consulto el estado, entonces veo por persona:
  tarea, estado del agente, y tiempo desde el último progreso.
- Dado un agente en ESCALATE, cuando ocurre, entonces su responsable recibe
  aviso sin tener que consultar nada.
- Dado un portátil dormido, cuando aparece en la vista, entonces se distingue de
  un agente caído.

---

## Definition of Done del epic

- Todos los desarrolladores del piloto tienen el daemon corriendo.
- El sistema detecta agentes atascados antes de que la persona se dé cuenta, y
  ese porcentaje está medido (métrica del PRD §3).
- La predicción de colisiones tiene su recall medido y documentado.
- Ningún aviso de colisión bloquea a nadie todavía.

---

## Hueco conocido

**Sin decidir:** qué formato exacto tiene la vista de estado (T05). Las opciones
son comentario en el issue, resumen por CLI, o canal de mensajería. Es una
decisión de producto, no técnica, y hay que tomarla antes de empezar T05.
