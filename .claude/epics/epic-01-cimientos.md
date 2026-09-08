# Epic 01 — Cimientos técnicos

**PRD origen:** `prd-plataforma-coordinacion.md`
**Fase de la hoja de ruta:** 0
**Objetivo:** que exista el esqueleto multi-tenant sobre el que se apoya todo lo
demás, y que Liberion gestione ya un proyecto real propio encima.

---

## Enfoque técnico

Backend TypeScript/Node en monorepo. Postgres único con RLS forzada como almacén
de todo (datos, cola de trabajos, y más adelante el grafo y los embeddings).
GitHub App como única vía de integración. El listener de webhooks no procesa
nada: verifica firma, encola, y devuelve 200 en menos de 10 segundos.

Las decisiones de arquitectura ya están fijadas en `CLAUDE.md` §3. Este epic las
implementa, no las revisa.

**Lo que este epic deliberadamente NO hace:** nada de Redis, nada de agentes de
IA, nada de UI. Solo el esqueleto.

---

## Tareas

### T01 — Scaffolding del monorepo y convenciones
**Paralelizable:** no (bloquea a todo lo demás)
**Depende de:** —
**Toca:** raíz del repo

Estructura de paquetes, TypeScript configurado, formateo y linting, `CLAUDE.md`
en la raíz, plantilla de ADR en `docs/adr/`, y `.env.example`.

**Criterios de aceptación:**
- Dado un clone limpio, cuando ejecuto la instalación y el build, entonces
  compila sin errores y sin warnings de lint.
- Dado un commit que viola las reglas de formato, cuando se ejecuta el hook de
  pre-commit, entonces el commit se rechaza.
- Dado el repo, cuando busco `docs/adr/0000-plantilla.md`, entonces existe.

---

### T02 — Esquema de base de datos multi-tenant con RLS
**Paralelizable:** no (bloquea T03, T04, T05)
**Depende de:** T01
**Toca:** `packages/db/`

Migraciones iniciales. Tablas: `tenants`, `users`, `teams`, `skills`,
`audit_log`, `roles`, `permissions`. Toda tabla de datos lleva `tenant_id`.
RLS forzada (`FORCE ROW LEVEL SECURITY`). Índices con `tenant_id` como columna
líder. Usuario de migraciones separado del usuario de runtime.

**Criterios de aceptación:**
- Dada una sesión con el tenant A activo, cuando consulto cualquier tabla,
  entonces solo veo filas del tenant A.
- Dada una query mal escrita sin filtro de tenant, cuando se ejecuta bajo RLS,
  entonces sigue sin devolver filas de otros tenants.
- Dado el modelo de permisos, cuando reviso el esquema, entonces NO existe
  ninguna columna booleana tipo `is_admin`.
- Dada la tabla `audit_log`, cuando intento un UPDATE o DELETE sobre ella,
  entonces la operación es rechazada.
- Existe un test automatizado de aislamiento entre tenants y pasa.

---

### T03 — PgBouncer y capa de acceso a datos
**Paralelizable:** sí (con T04)
**Depende de:** T02
**Conflicto con:** —
**Toca:** `packages/db/`, `infra/`

PgBouncer en modo transacción. Capa de acceso que fija automáticamente el
contexto de tenant en cada sesión — que ningún desarrollador tenga que
acordarse de hacerlo a mano.

**Criterios de aceptación:**
- Dadas 200 conexiones de cliente simultáneas, cuando pasan por PgBouncer,
  entonces el número de conexiones reales a Postgres se mantiene bajo el pool
  configurado.
- Dado cualquier acceso a datos a través de la capa, cuando se ejecuta, entonces
  el contexto de tenant queda fijado sin intervención manual.
- Dado un intento de acceso sin contexto de tenant, cuando se ejecuta, entonces
  falla de forma explícita y ruidosa (nunca devuelve datos de todos).

---

### T04 — Cola de trabajos tras una interfaz
**Paralelizable:** sí (con T03)
**Depende de:** T02
**Conflicto con:** —
**Toca:** `packages/queue/`

pg-boss sobre el mismo Postgres, envuelto en una interfaz propia (`enqueue`,
`process`, `schedule`) para poder cambiar a otra implementación sin tocar los
llamantes. El contexto de tenant se propaga al job.

**Criterios de aceptación:**
- Dado un job encolado, cuando lo recoge un worker, entonces se ejecuta una sola
  vez aunque haya varios workers.
- Dado un job que falla, cuando se reintenta, entonces respeta backoff con jitter
  y acaba en una cola de fallidos tras N intentos.
- Dado un job encolado en el contexto del tenant A, cuando lo procesa el worker,
  entonces el contexto de tenant A está disponible dentro del job.
- Dado el código de la aplicación, cuando busco importaciones directas de
  `pg-boss` fuera de `packages/queue/`, entonces no hay ninguna.

---

### T05 — GitHub App y listener de webhooks
**Paralelizable:** no (depende de T03 y T04)
**Depende de:** T03, T04
**Toca:** `apps/webhook/`, `packages/github/`

Registro de la GitHub App, gestión de tokens de instalación (1h, renovables),
listener HTTP que verifica la firma HMAC, deduplica por GUID de entrega, encola
y responde. Suscripción a: `issues`, `issue_comment`, `pull_request`, `push`,
`check_run`, `workflow_run`, `installation`.

**Criterios de aceptación:**
- Dado un webhook entrante válido, cuando llega al listener, entonces responde
  2XX en menos de 500 ms y el trabajo real queda encolado.
- Dado un webhook con firma inválida, cuando llega, entonces se rechaza y se
  registra el intento.
- Dada una entrega repetida con el mismo GUID, cuando llega dos veces, entonces
  el trabajo se procesa una sola vez.
- Dada una instalación de la App en una organización, cuando se guarda, entonces
  queda mapeada a un tenant.
- Dado un token de instalación caducado, cuando se necesita llamar a la API,
  entonces se renueva de forma transparente.

---

### T06 — Gates de calidad y seguridad en CI
**Paralelizable:** sí (con T05)
**Depende de:** T01
**Conflicto con:** —
**Toca:** `.github/workflows/`, hooks de pre-commit

El andamiaje que hace cumplir de verdad lo que `CLAUDE.md` solo sugiere.
Escaneo de secretos, SCA de dependencias, SAST, escaneo de IaC, lint, type-check,
tests. Fitness functions de arquitectura. Se falla solo en severidad alta/crítica
al principio, para no generar ruido que la gente aprenda a ignorar.

**Criterios de aceptación:**
- Dado un commit con un secreto, cuando se intenta commitear, entonces el hook
  de pre-commit lo bloquea.
- Dado un PR con una vulnerabilidad crítica en dependencias, cuando corre el CI,
  entonces el PR queda bloqueado.
- Dado un PR que introduce una dependencia del dominio hacia infraestructura,
  cuando corren las fitness functions, entonces el CI falla.
- Dado un PR limpio, cuando corre el CI completo, entonces tarda menos de 10
  minutos.

---

### T07 — Instalación de CCPM y ponytail, y arranque del piloto
**Paralelizable:** no
**Depende de:** T01
**Toca:** `.claude/`, configuración de agentes

CCPM instalado y en uso. Plugin `ponytail` instalado en los agentes del equipo.
Elegir el proyecto real de Liberion que sirve de piloto y arrancar el flujo
`Discovery → PRD → Epic → Tasks → Issues` de verdad con él.

**Criterios de aceptación:**
- Dado el repo del piloto, cuando ejecuto el flujo de CCPM, entonces se crean
  el issue de epic y los sub-issues en GitHub.
- Dado un agente del equipo, cuando le pido una feature con una trampa de
  sobre-ingeniería conocida, entonces baja por la escalera de ponytail y produce
  la solución mínima.
- Dado el piloto, cuando arranca, entonces las cuatro métricas baseline del PRD
  §3 quedan medidas y registradas.

---

## Definition of Done del epic

- Todas las tareas T01–T07 cerradas con sus criterios verificados.
- Un proyecto real de Liberion gestionándose con este esqueleto.
- Baseline de métricas del PRD medido y anotado.
- Ningún elemento de la tabla "no construir todavía" ha entrado por la puerta de
  atrás.
