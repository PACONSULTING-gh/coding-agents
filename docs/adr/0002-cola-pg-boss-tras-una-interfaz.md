# ADR 0002 — pg-boss sobre el mismo Postgres, oculto tras un puerto propio

**Estado:** Aceptada

## Contexto

El sistema necesita una cola de trabajos para desacoplar el listener de
webhooks (que solo puede tardar unos milisegundos en responder) del
procesamiento real. Hace falta decidir la tecnología de cola sin añadir un
sistema operativo nuevo si se puede evitar (CLAUDE.md 4: nada de Redis/Kafka
hasta miles de jobs/seg sostenidos, que no es el caso ahora).

## Decisión

pg-boss, corriendo sobre el mismo Postgres que ya tenemos, envuelto en un
puerto propio (`QueuePort` en `packages/core/src/ports/queue.ts`) con
`enqueue`, `process`, `schedule`, `start`, `stop`. Ningún código fuera de
`packages/queue` importa `pg-boss` directamente; se comprueba con una fitness
function en CI (dependency-cruiser, regla `pg-boss-solo-en-queue`).

## Consecuencias

- Un sistema menos que operar: sin Redis, sin cluster de Kafka, sin cuenta
  cloud adicional. Los backups y la alta disponibilidad de la cola son los
  mismos que los de Postgres.
- El techo de rendimiento de pg-boss sobre Postgres es más bajo que el de un
  bus de mensajes dedicado. Es un techo conocido y aceptado: el disparador
  para reconsiderar (miles de jobs/seg sostenidos) ya está en CLAUDE.md 4.
- Al ocultar pg-boss tras `QueuePort`, cambiar de implementación el día que se
  toque ese techo no obliga a tocar `apps/webhook` ni `apps/worker`, solo
  `packages/queue`.
- El contexto de tenant tiene que viajar explícitamente dentro del payload del
  job (`JobEnvelope.tenantId`) porque `AsyncLocalStorage` no sobrevive al
  cruce por la tabla de Postgres entre el productor y el consumidor: quien
  implemente `process()` debe restablecer el contexto de tenant antes de
  invocar el handler.

## Alternativas descartadas

- **Redis (BullMQ, etc.)** — mejor rendimiento pero añade un sistema entero
  para operar y un backup adicional, sin que exista todavía la carga que lo
  justifique.
- **Kafka / bus de eventos** — sobre-ingeniería clara a este volumen; pensado
  para streaming de eventos, no para colas de trabajo con reintentos.
- **Cola casera sobre una tabla de Postgres sin pg-boss** — reinventar
  backoff, jitter, colas de fallidos y locking que pg-boss ya resuelve y
  mantiene.
