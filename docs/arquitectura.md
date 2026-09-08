# Arquitectura (arc42 ligero)

Este documento refleja lo que existe **de verdad** en el repo a fecha de T01. No
describe fases futuras como si ya estuvieran construidas.

## 1. Contexto

El sistema es una capa de coordinación que se sienta encima de GitHub (Issues,
PRs, webhooks) y de agentes de código. No sustituye a GitHub ni a CCPM: los usa
como fuente de verdad y como motor de ejecución.

Actores externos:

- **GitHub** — origen de eventos (`issues`, `pull_request`, `push`, ...) vía
  webhooks de una GitHub App, y destino de escritura (comentarios, estados).
- **Desarrolladores** — reciben tareas sugeridas, aprueban o rechazan lo que
  proponen los agentes.
- **Agentes de código** (Claude Code, Codex, Copilot CLI) — ejecutan tareas;
  este sistema los coordina, no los reemplaza.

## 2. Estrategia

- Backend TypeScript/Node en monorepo (pnpm workspaces).
- Postgres único como almacén de todo: datos de negocio, cola de trabajos
  (pg-boss), y en fases posteriores el grafo de dependencias y embeddings.
  Ver ADR 0001 y ADR 0002.
- GitHub App como única vía de integración con GitHub (no OAuth App): ver
  CLAUDE.md §3.
- Arquitectura de puertos: `packages/core` define los contratos
  (`QueuePort`, contexto de tenant, errores de dominio); la infraestructura
  concreta vive fuera y los implementa. Sin esto, cambiar pg-boss de sitio
  obligaría a tocar cada llamante.

## 3. Bloques de construcción

Estado real a día de T05:

```
packages/core     — IMPLEMENTADO. Contexto de tenant (AsyncLocalStorage),
                     errores de dominio, puerto QueuePort. Sin dependencias
                     de runtime salvo zod. No importa de ningún otro paquete.
packages/db       — IMPLEMENTADO. Esquema multi-tenant con RLS forzada,
                     migraciones, capa de acceso (withTenantConnection) y
                     API del audit_log.
packages/queue    — IMPLEMENTADO. QueuePort sobre pg-boss, con envelope que
                     propaga el tenant al job.
packages/github   — IMPLEMENTADO. Cliente de la GitHub App, verificación de
                     firma y caché de tokens de instalación.
apps/webhook      — IMPLEMENTADO. Listener HTTP fino: verifica, deduplica,
                     encola y responde. No procesa nada.
apps/worker       — IMPLEMENTADO (mínimo). Registra el evento en audit_log y
                     aplica los cambios de instalación. La lógica de dominio
                     de cada evento es de fases posteriores.
```

Dependencias entre paquetes (todas apuntan hacia dentro, hacia `core`):

```
apps/webhook  ──┐
apps/worker   ──┼──> packages/{db,queue,github} ──> packages/core
                └──────────────────────────────────> packages/core
```

`packages/core` no depende de ningún otro paquete del repo. Se comprueba con
dependency-cruiser en CI (regla `core-no-sale`), no solo por convención.

### Recorrido de un webhook de GitHub (T05)

```
GitHub ──HTTPS POST──> apps/webhook
                         1. verifica HMAC-SHA256 sobre el cuerpo CRUDO
                            (firma inválida -> 401 + log + audit_log)
                         2. instalación -> tenant  (github_installations,
                            lectura sin contexto de tenant, ver más abajo)
                         3. INSERT ... ON CONFLICT DO NOTHING en
                            webhook_deliveries  (dedup por GUID de entrega)
                         4. runWithTenant(...) -> QueuePort.enqueue
                         5. 200  (objetivo < 500 ms)
                                    │
                                    ▼
                             cola pg-boss (una cola por tipo de evento)
                                    │
                                    ▼
                              apps/worker
                                 restaura el tenant desde el envelope,
                                 escribe en audit_log y, si es un evento
                                 de instalación, actualiza github_installations
```

Todo lo que cuesta tiempo pasa detrás de la cola, donde hay reintentos con
backoff y cola de fallidos. En la petición HTTP solo cabe lo que no se puede
diferir, porque ahí el reloj lo lleva GitHub (corta a los 10 s).

**La única lectura del sistema que ocurre sin contexto de tenant** es el paso 2:
es imposible saber de quién es un webhook antes de mirar el mapeo de la
instalación. La migración `0006` la acota con una segunda política de RLS que
solo permite `SELECT`, solo fuera de contexto de tenant, y solo de la
instalación que el llamante declara por adelantado en
`app.github_installation_lookup`. El radio de exposición es una fila, no la
tabla.

### Por qué NO existen todavía `packages/graph`, `packages/agents` ni `apps/daemon`

Son de fases posteriores de la hoja de ruta (Fase 1 y Fases 2-4 según
`docs/quality-gates.md` §4). Crearlos vacíos ahora sería sobre-ingeniería
según el peldaño 1 de la escalera de pereza de CLAUDE.md §2.4 ("¿hace falta
que exista?"): no tienen consumidor todavía, y un paquete vacío no es
scaffolding útil, es ruido que hay que mantener sincronizado sin que aporte
nada. Se crean en el epic que primero los necesite.

## 4. Despliegue

Todavía no hay despliegue a ningún entorno remoto. Lo único que existe es
`infra/docker-compose.yml` con un contenedor de Postgres para desarrollo
local. PgBouncer, CI/CD y cualquier infraestructura de nube llegan en tareas
posteriores (T03 y T06 en adelante) y este documento se actualizará cuando
existan de verdad.
