# Estado del Epic 01 — Cimientos técnicos

**Fecha del informe:** 2026-09-08
**Alcance:** `.claude/epics/epic-01-cimientos.md`, tareas T01–T07.
**Quién lo firma:** agente de gate final, en contexto propio. No ha escrito ninguna de las
features que evalúa; se ha limitado a ejecutar los gates, leer el árbol y arreglar una
referencia muerta en un comentario de configuración (ver §8).

> Este informe está escrito para poder decidir **sin abrir el diff**. Todo lo que aquí se
> afirma como "verificado" se ha ejecutado de verdad en esta máquina y su salida está
> resumida en §3. Lo que no se ha ejecutado se dice explícitamente.

---

## 1. Veredicto en una línea

El árbol está **en verde de punta a punta** (instalación, tipos, lint, formato, arquitectura,
build y 138 tests contra Postgres real). El epic **no se puede cerrar todavía**: T05 depende
de un registro en GitHub que solo puede hacer una persona, T06 tiene tres criterios que solo
se pueden comprobar cuando haya PRs de verdad (el remoto existe, pero está vacío), y **T07 no
está empezado**.

---

## 2. Estado por tarea

| Tarea                                | Estado                   | Por qué                                                                                                                                                                            |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T01** Scaffolding y convenciones   | **Completo**             | Monorepo pnpm con 6 paquetes, TS estricto, ESLint+Prettier, los tres hooks de husky y `docs/adr/0000-plantilla.md`; los tres criterios verificados ejecutando los hooks.           |
| **T02** Esquema multi-tenant con RLS | **Completo**             | 6 migraciones, RLS **forzada** en todas las tablas, `audit_log` append-only por privilegios _y_ por trigger, cero columnas `is_admin`; 66 tests contra Postgres real en verde.     |
| **T03** PgBouncer y capa de acceso   | **Completo**             | Pooler en modo transacción en el compose; el contexto de tenant lo fija la capa, no el llamante; test real de 200 clientes concurrentes que no pasan de 25 backends.               |
| **T04** Cola tras una interfaz       | **Completo**             | Puerto `enqueue/process/schedule/start/stop` en `packages/core`, pg-boss solo detrás; exactly-once, backoff con jitter, DLQ y propagación de tenant, todo probado.                 |
| **T05** GitHub App y webhooks        | **Parcial (código: sí)** | Todo el código existe y está probado (firma, dedupe por GUID, mapeo instalación→tenant, renovación de token, <500 ms). **Falta registrar la App en GitHub**: es acción humana.     |
| **T06** Gates de calidad y seguridad | **Parcial (repo: sí)**   | Los 8 jobs de CI, dependabot, gitleaks, semgrep, trivy y los hooks están escritos. **Nunca han corrido**: el remoto está vacío, así que 3 de los 4 criterios no están verificados. |
| **T07** CCPM, ponytail y piloto      | **No hecho**             | `.claude/` solo contiene el PRD y este epic. No hay CCPM instalado, ni ponytail, ni proyecto piloto elegido, ni baseline de métricas medido.                                       |

---

## 3. Salida real de los gates

Ejecutado en este árbol, hoy, en la raíz del repo. Node 22.14.0, pnpm 10.33.0, Docker 29.4.0.

| Comando                          | Resultado | Salida resumida                                                             |
| -------------------------------- | --------- | --------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | ✅ 0      | "Lockfile is up to date, resolution step is skipped" / "Already up to date" |
| `pnpm -r typecheck`              | ✅ 0      | 6 de 6 proyectos, todos "Done". Cero errores                                |
| `pnpm lint`                      | ✅ 0      | Sin salida: cero errores y cero warnings                                    |
| `pnpm format:check`              | ✅ 0      | "All matched files use Prettier code style!"                                |
| `pnpm arch`                      | ✅ 0      | "no dependency violations found (76 modules, 192 dependencies cruised)"     |
| `pnpm -r build`                  | ✅ 0      | 6 de 6 paquetes compilados                                                  |
| `pnpm -r test`                   | ✅ 0      | **13 ficheros, 138 tests, 138 en verde, 0 saltados**                        |

Desglose de los tests, porque el número agregado esconde dónde está el esfuerzo:

| Paquete           | Ficheros | Tests | Duración | Qué cubre                                                      |
| ----------------- | -------: | ----: | -------- | -------------------------------------------------------------- |
| `packages/db`     |        4 |    66 | 18,3 s   | Aislamiento RLS, capa de acceso, PgBouncer, instalaciones      |
| `packages/github` |        3 |    23 | 0,6 s    | Firma HMAC, caché de tokens, parseo de instalaciones           |
| `packages/queue`  |        3 |    22 | 27,4 s   | Exactly-once, reintentos, DLQ, contexto de tenant, sin fugas   |
| `apps/webhook`    |        1 |    16 | 23,5 s   | Firma, dedupe por GUID, mapeo a tenant, latencia, `/health`    |
| `packages/core`   |        1 |     6 | 0,1 s    | `runWithTenant` / `requireTenant` y no filtración entre tareas |
| `apps/worker`     |        1 |     5 | 7,0 s    | Persistencia en `audit_log` y eventos de instalación           |

Los tests de `db`, `queue`, `webhook` y `worker` levantan **Postgres real con testcontainers**,
no mocks (CLAUDE.md §5). Por eso duran lo que duran.

### Escaneo de secretos

`gitleaks` **no está instalado en esta máquina**, así que no se pudo correr el binario local.
Para no dar por bueno lo que no se ha comprobado, se ejecutó el escáner en contenedor con la
misma configuración del repo:

```
docker run --rm -v "$PWD":/repo:ro -w /repo zricethezav/gitleaks:latest \
  dir . --no-banner --redact --config .gitleaks.toml
→ INF scanned ~1277178 bytes (1.28 MB) in 111ms
→ INF no leaks found          (exit 0)
```

### Hooks de git, ejecutados de verdad

| Hook         | Escenario                  | Resultado                                                      |
| ------------ | -------------------------- | -------------------------------------------------------------- |
| `pre-commit` | árbol actual               | **Sale 1**: lint-staged pasa, pero gitleaks no está en el PATH |
| `commit-msg` | `"arreglos varios"`        | Rechazado con el mensaje de la convención `Issue #N:`          |
| `commit-msg` | `"Issue #12: mensaje ..."` | Aceptado (sale 0)                                              |
| `pre-push`   | árbol actual               | Sale 0: el lockfile está sincronizado                          |

Que `pre-commit` bloquee **es el comportamiento correcto**, no un fallo: el escaneo de
secretos es obligatorio (CLAUDE.md §2.5) y el hook falla ruidosamente en vez de saltárselo.
Pero implica que **hoy, en esta máquina, no se puede commitear** hasta instalar gitleaks
(paso de onboarding documentado en `docs/runbook.md`).

---

## 4. Higiene del árbol

- `git status` limpio de basura: 116 entradas (este informe incluido), **ninguna** de `node_modules/`, `dist/`,
  `*.tsbuildinfo`, `.env` ni ficheros temporales. No hay ningún `*.tmp.ts` ni resto de
  pruebas de agentes anteriores. No hay directorios vacíos.
- `.env` **no existe en disco** y está ignorado (`.gitignore:5`).
- `.env.example` **no** está ignorado (la negación `!.env.example` de `.gitignore:7` funciona;
  aparece como `?? .env.example` en `git status`). Sus valores son todos `changeme*`.
- **No se ha hecho ningún commit, ni rama, ni tocado ningún remoto**, a propósito: la
  convención `Issue #N:` exige issues que todavía no existen (§5).

---

## 5. Qué requiere decisión o acción humana antes de cerrar el epic

Ordenado por lo que bloquea a más cosas.

### 5.1 Crear los issues y hacer el primer push — bloquea todo lo demás

El repositorio remoto **ya existe**: `origin` apunta a
`https://github.com/PACONSULTING-gh/coding-agents.git` y `git ls-remote` confirma que está
**vacío** (cero refs). Lo que falta son los issues: el hook `commit-msg` exige
`Issue #N: descripción` y no hay ni uno. **Todo el trabajo de este epic está sin commitear**
por esa razón, no por descuido. Hace falta que una persona:

1. Cree el issue del epic y los sub-issues T01–T07.
2. Decida cómo se atribuyen los commits del trabajo ya hecho (un commit por tarea con su
   issue, o un commit inicial referenciando el issue del epic).
3. Haga el primer push, con lo que el CI se ejecutará por primera vez (§7, última fila).

Ojo con un detalle real: Dependabot está configurado con prefijo `deps`/`ci`, que **no**
cumple la convención. El hook es local (cliente) y no afecta a sus PRs, pero si algún día se
mueve esa comprobación a CI, hay que exceptuar a Dependabot o el bot quedará bloqueado.

### 5.2 Registrar la GitHub App — cierra T05

`docs/github-app-setup.md` tiene el procedimiento paso a paso (permisos mínimos por evento,
clave privada, instalación en la organización, vinculación instalación→tenant). Nadie lo ha
ejecutado. Hasta que exista la App real no se pueden verificar los criterios de T05 contra
GitHub de verdad, solo contra los tests (que sí pasan).

### 5.3 Instalar gitleaks en cada máquina del equipo — desbloquea commitear

Paso de onboarding de `docs/runbook.md`. Hasta entonces `pre-commit` bloquea todo commit.

> **Resuelto.** El hook recomendaba 8.24.3 y el CI fijaba 8.30.1. Se unificó en **8.30.1**
> (la del CI), y antes de cambiar el número se **repitió la prueba empírica** del allowlist
> con esa versión, en un repo aislado, con `ghp_changeme…` en un `.ts` normal y en
> `.env.example`:
>
> | config                                         | ¿detecta en `normal.ts`?      |
> | ---------------------------------------------- | ----------------------------- |
> | sin allowlist                                  | sí                            |
> | `paths` + `regexes`                            | **no** ← el agujero           |
> | `paths` + `regexes` + `matchCondition = "AND"` | **no** ← sigue sin arreglarlo |
> | solo `paths` (la config del repo)              | **sí**                        |
>
> Mismo resultado que con 8.24.3, así que la evidencia del comentario de `.gitleaks.toml`
> sigue respaldada. El checksum del binario 8.30.1 descargado
> (`551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`) coincide con el que
> el job de CI tiene fijado.

### 5.4 T07 completo — es lo que más falta

Nada de esto está hecho y ninguna parte la puede decidir un agente:

- Instalar CCPM y el plugin `ponytail` en los agentes del equipo.
- **Elegir el proyecto piloto de Liberion.** Es una decisión de negocio.
- Correr el flujo `Discovery → PRD → Epic → Tasks → Issues` de verdad sobre ese piloto.
- **Medir y registrar las cuatro métricas baseline del PRD §3.** Sin baseline, el epic no
  cumple su propia Definition of Done y la fase 1 arranca sin nada contra lo que comparar.

### 5.5 Aprobar (o rechazar) `@vitest/coverage-v8`

No está en el stack aprobado. Sin ella no hay informe de cobertura: el paso de subida ya
existe en `ci.yml` y hoy no produce nada. Es una dependencia nueva, así que la decide una
persona (CLAUDE.md §7).

### 5.6 Verificación independiente (CLAUDE.md §2.3 y DoD)

Este informe comprueba que **los gates están en verde**, que no es lo mismo que comprobar que
**el código cumple el spec**. Falta que un Verifier en contexto limpio —preferiblemente otro
modelo— contraste cada criterio de aceptación contra el diff, y que un humano apruebe.

---

## 6. Criterios de aceptación del epic que quedan sin cumplir

| Criterio                                                                     | Estado            | Qué falta                                                                                          |
| ---------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------- |
| T05 · "una instalación de la App queda mapeada a un tenant"                  | Solo en test      | La App no existe en GitHub. El código y sus tests están; falta el registro real (§5.2)             |
| T06 · "un PR con vulnerabilidad crítica queda bloqueado"                     | **No verificado** | El job `deps` (`pnpm audit --audit-level=high`) existe pero nunca ha corrido: el remoto está vacío |
| T06 · "un PR que rompe las fronteras de arquitectura falla"                  | Parcial           | `pnpm arch` sí se ha ejecutado y pasa; lo que no se ha probado es que **falle** ante una violación |
| T06 · "un PR limpio tarda menos de 10 minutos"                               | **No verificado** | Sin ejecuciones de CI no hay ni un dato de duración                                                |
| T07 · los tres criterios                                                     | **No hecho**      | Ver §5.4                                                                                           |
| DoD del epic · "un proyecto real de Liberion gestionándose con el esqueleto" | **No hecho**      | Depende de T07                                                                                     |
| DoD del epic · "baseline de métricas medido y anotado"                       | **No hecho**      | Depende de T07                                                                                     |
| DoD del epic · "el Verifier ha emitido informe en contexto limpio"           | **No hecho**      | Ver §5.6                                                                                           |

Lo que **sí** se puede afirmar del último punto de la DoD del epic: `pnpm arch` no encuentra
violaciones y no hay Redis, ni Neo4j, ni SSO, ni UI, ni `packages/graph`, ni `packages/agents`,
ni `apps/daemon`. **Ningún elemento de la tabla "no construir todavía" ha entrado por la puerta
de atrás.**

---

## 7. Deuda técnica asumida a propósito

Las cinco primeras ya estaban registradas con su disparador en `docs/runbook.md`; se repiten
aquí para que este informe se lea solo.

| Deuda                                                                                                                      | Motivo por el que se asume                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **`webhook_deliveries` no se purga nunca.** Crece sin límite, y su índice único es lo que sostiene la deduplicación.       | Sin tráfico real no hay volumen. Se resuelve con un job programado, y `schedule` ya existe.                   |
| **`disableRequestLogging` de Fastify está deprecada** (aviso `FSTDEP023` en cada arranque, visible en la salida de tests). | Migrar a `logController` obliga a reimplementar el controlador entero para cambiar un booleano.               |
| **No hay event trigger que exija RLS al crear tablas.** La única red es el test de catálogo.                               | Afecta a cómo se escriben todas las migraciones: va por ADR, no por decisión de un agente.                    |
| **Sin informe de cobertura.** Falta `@vitest/coverage-v8`, fuera del stack aprobado.                                       | Dependencia nueva ⇒ decide un humano (§5.5).                                                                  |
| **`singletonKey` no deduplica** con la política `standard` de pg-boss.                                                     | Hoy no hace falta: la deduplicación de webhooks la da la restricción única de la tabla.                       |
| **Mutation testing es no bloqueante** y su umbral (`break: 60`) está sin calibrar; corre semanal, no por PR.               | Umbral aspiracional en un módulo joven = ruido que la gente aprende a ignorar (T06 lo dice).                  |
| **El job de IaC no escanea nada hoy.** Trivy no parsea `docker-compose`, y es el único fichero de infra que existe.        | Se deja puesto para que el primer Dockerfile o Terraform quede cubierto desde su primer commit.               |
| **Los workflows de CI nunca se han ejecutado.** Están escritos contra la documentación, no contra una ejecución observada. | Nunca se ha empujado nada al remoto (§5.1). Es la deuda con más probabilidad de dar un susto en el primer PR. |

---

## 8. Cambios hechos por este gate

Uno solo, y no toca código ejecutable:

- `stryker.config.json`: el comentario `thresholds_comment` remitía a una sección
  "Estado real de los gates" de `docs/quality-gates.md` que **no existe**. Se ha corregido el
  puntero a la sección que sí existe (§2, capa 2). JSON validado y formato verificado.

No se ha borrado ni debilitado ningún test, ni se ha hardcodeado ningún valor esperado, ni se
ha añadido ningún `catch` que trague errores. No hacía falta: nada estaba en rojo.
