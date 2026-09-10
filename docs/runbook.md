# Runbook

Qué hacer cuando algo falla. Solo documenta lo que existe hoy; no se inventan
aquí procedimientos de componentes que todavía no existen.

---

## Onboarding: pasos obligatorios antes del primer commit

`git clone` + `pnpm install` **no basta**. Faltan dos cosas:

1. **Instalar `gitleaks`.** El hook de pre-commit lo exige y aborta el commit si
   no está en el `PATH` — falla cerrado, que es lo que debe hacer un gate de
   seguridad, pero significa que sin él no se puede commitear.

   ```bash
   # Linux x64
   curl -sSfL -o /tmp/gitleaks.tar.gz \
     https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz
   echo '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb  /tmp/gitleaks.tar.gz' | sha256sum -c -
   tar -xzf /tmp/gitleaks.tar.gz -C /tmp gitleaks && sudo install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks

   # macOS
   brew install gitleaks
   ```

   El CI usa esa misma versión y ese mismo checksum (job `secrets` de
   `ci.yml`), así que lo que pasa en local pasa en CI.

2. **Copiar `.env.example` a `.env`** y rellenarlo. `infra/docker-compose.yml`
   exige las credenciales por variable (`:?`) y no arranca sin ellas: es
   deliberado, no hay ninguna contraseña literal en el repositorio.

Comprobación de que el entorno está listo:

```bash
pnpm install --frozen-lockfile && pnpm -r build && pnpm lint && pnpm -r typecheck && pnpm arch
```

---

## Arranque local completo, de cero a un webhook procesado

Verificado de punta a punta el 8 de septiembre de 2026. El orden **importa**: el
paso 3 no puede ir antes del 2, y el 4 no puede ir antes del 3.

```bash
# 1. Configuracion. Si ya tienes un Postgres del sistema en el 5432, cambia
#    POSTGRES_HOST_PORT / PGBOUNCER_HOST_PORT en el .env; las URLs de conexion
#    del mismo fichero tienen que apuntar a esos puertos.
cp .env.example .env && chmod 600 .env
# rellena las contrasenas con valores generados (openssl rand -hex 16), no con
# los placeholders

# 2. Infraestructura
docker compose --env-file .env -f infra/docker-compose.yml up -d

# 3. Base de datos. La migracion 0001 CREA los roles, asi que es la unica que
#    necesita el rol de administracion; las demas ya corren como app_migrator.
set -a; . ./.env; set +a
DATABASE_MIGRATION_URL="$DATABASE_ADMIN_URL" pnpm --filter @coord/db migrate:up --count=1
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_migrator WITH PASSWORD '$APP_MIGRATOR_PASSWORD'" \
  -c "ALTER ROLE app_runtime  WITH PASSWORD '$APP_RUNTIME_PASSWORD'"
pnpm --filter @coord/db migrate:up

# 4. Esquema de la cola. NO es opcional y NO lo hace el arranque de la
#    aplicacion: ver la seccion siguiente.
pnpm --filter @coord/queue queue:install

# 5. Arrancar
pnpm -r build
node apps/webhook/dist/index.js &
node apps/worker/dist/index.js &
curl -s "http://localhost:$WEBHOOK_PORT/health"
# {"status":"ok","checks":{"database":true,"queue":true}}
```

---

## `permission denied for database` al arrancar el worker o el listener

**Sintoma:** el proceso muere en el arranque con `error: permission denied for
database coord`, codigo SQLSTATE `42501`, con la traza pasando por
`Contractor.create` de pg-boss.

**Causa:** falta el paso 4 del arranque local. pg-boss crea su propio esquema la
primera vez que arranca, y `app_runtime` **no tiene CREATE sobre la base** — la
migracion 0001 se lo revoca a proposito. El esquema lo instala `app_migrator`.

**Arreglo:** `pnpm --filter @coord/queue queue:install` (necesita
`DATABASE_MIGRATION_URL`). Es idempotente: se puede correr en cada despliegue, y
conviene hacerlo, porque tambien aplica las migraciones de esquema de pg-boss
cuando se sube de version.

**Por que no lo hace la aplicacion sola:** porque entonces `app_runtime`
necesitaria DDL sobre la base, y eso es exactamente lo que el modelo de minimo
privilegio de este proyecto existe para impedir. Ver el comentario de cabecera de
`packages/queue/src/install.ts`.

---

## El hook de pre-commit rechaza mi commit

- **"hay ficheros staged que no pasan formato o lint"** → el hook VERIFICA, no
  reescribe. Ejecuta `pnpm format` (que sí aplica `prettier --write` y
  `eslint --fix`), revisa el diff y vuelve a `git add`. El hook no reformatea
  por su cuenta a propósito: commitear contenido reescrito que no has visto es
  la mutación silenciosa que CLAUDE.md §7 pide no ocultar.
- **"el mensaje de commit no referencia ningún issue"** → el hook `commit-msg`
  exige `Issue #N: descripción` (CLAUDE.md §2.2). Si la tarea no tiene issue,
  créalo antes. Merges, reverts y `fixup!`/`squash!` están exentos.
- **`gitleaks` encuentra algo** → NO lo silencies con un allowlist nuevo sin
  pensarlo. Si es un falso positivo, acótalo por ruta en `.gitleaks.toml` (y
  lee la cabecera de ese fichero antes: un `regexes` de allowlist se evalúa en
  OR con `paths` y exime en TODO el repositorio).

## El pre-push dice que el lockfile no está sincronizado

`pnpm install --lockfile-only` y commitea `pnpm-lock.yaml`. Un lockfile
desincronizado tumba los seis jobs de Node del CI en su primer paso.

## Postgres caído (desarrollo local)

Hoy Postgres solo existe como contenedor de desarrollo
(`infra/docker-compose.yml`), no hay entorno productivo todavía.

1. Comprobar estado: `docker compose -f infra/docker-compose.yml ps`.
2. Revisar logs: `docker compose -f infra/docker-compose.yml logs postgres`.
3. Si el healthcheck falla de forma persistente, recrear el contenedor:
   `docker compose -f infra/docker-compose.yml down && docker compose -f infra/docker-compose.yml up -d`.
   Esto NO borra el volumen nombrado (`postgres_data`), los datos persisten.
4. Si hace falta partir de cero: `docker compose -f infra/docker-compose.yml down -v`
   (esto sí borra el volumen — perdida de datos intencional, solo en local).

## Cola atascada

**Pendiente.** La cola (pg-boss tras `QueuePort`) se implementa en T04. Este
runbook se completa con procedimientos reales (cómo inspeccionar jobs
atascados, cómo purgar la cola de fallidos, cómo escalar workers) cuando
exista el código y se haya operado de verdad, no antes.

## Webhooks rechazados

**Pendiente.** El listener de webhooks se implementa en T05 (verificación de
firma HMAC, deduplicación por GUID de entrega). Este runbook se completa
cuando exista.

## Migración a medias

**Pendiente.** El esquema y las migraciones se implementan en T02, con
usuario de migraciones separado del de runtime. Este runbook se completa
cuando exista node-pg-migrate configurado de verdad, con el procedimiento
real de rollback.

## Principio general mientras el runbook está incompleto

Ante cualquier fallo no cubierto aquí todavía: no improvisar un `catch`
silencioso ni parchear en producción sin entender la causa (CLAUDE.md §5 y
§7). Escalar a un humano y, si el runbook debería haber cubierto el caso,
añadirlo aquí después de resolverlo.

---

## Cola atascada, webhooks, migraciones

Los procedimientos concretos se escriben cuando se hayan operado de verdad, no
antes. Lo que ya se puede hacer hoy:

- **Inspeccionar la cola:** las tablas de pg-boss viven en el esquema `queue`.
  `SELECT name, state, retry_count, output FROM queue.job ORDER BY created_on DESC LIMIT 50`.
- **Cola de fallidos:** cada cola `X` tiene su `X.dlq`, con `source_id`
  apuntando al job original.
- **Estado del pooler:** ver `infra/pgbouncer/README.md` (`SHOW POOLS`).

---

## Dependencias nuevas aprobadas

CLAUDE.md §7 dice que una dependencia nueva que no esté en el stack aprobado se
para y se escala. Cuando la aprobación ocurre, se anota aquí: si no, la próxima
persona que la vea no puede distinguir "aprobada" de "colada".

| Dependencia                                                                             | Para qué                                                                                    | Aprobación                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-javascript`, `tree-sitter-python` | Parseo de la ingesta del grafo (epic 02, T02).                                              | Las manda el propio epic. Declaradas además en `pnpm.onlyBuiltDependencies` del `package.json` raíz.                                                                                        |
| `@modelcontextprotocol/sdk`                                                             | Servidor MCP del grafo (epic 02, T05).                                                      | La manda el propio epic.                                                                                                                                                                    |
| `p-limit`                                                                               | Limitador de concurrencia en la ingesta (lectura de ficheros y procesos `git` en paralelo). | Incluida en el stack fijado del epic 02, verificada en npm y en el lockfile. Alternativa si algún día molesta: son una docena de líneas propias (escalera de CLAUDE.md §2.4, peldaños 6-7). |

---

## Deuda técnica registrada, con su disparador

Esto no es una lista de deseos: cada entrada dice cuándo deja de poder
aplazarse.

| Deuda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Disparador                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retención de `webhook_deliveries`.** Se inserta una fila por entrega aceptada y nada las borra nunca. La tabla y su índice único —que es lo que sostiene la deduplicación— crecen sin límite. GitHub reintenta durante horas, no meses, así que una ventana de retención del orden de 30 días es de sobra.                                                                                                                                                                                                                                                                                                                                            | Cuando el listener reciba tráfico real de forma sostenida. La cola ya tiene `schedule`, así que la purga es un job programado, no un cron externo.                                                                                                                                                                                                                                                                          |
| **`disableRequestLogging` de Fastify.** Deprecada en Fastify 5 (aviso `FSTDEP023` en cada arranque). No se migra a `logController` porque esa opción no admite un objeto parcial: exige las diez propiedades del controlador, es decir, reimplementar el que Fastify ya trae para cambiar un booleano.                                                                                                                                                                                                                                                                                                                                                  | La subida a Fastify 6, que la elimina.                                                                                                                                                                                                                                                                                                                                                                                      |
| **Event trigger que exija RLS al crear tablas.** Hoy, si una migración crea una tabla en `public` y se olvida de activar RLS forzada, `app_runtime` la ve entera y nada falla en runtime; la única red es el test de catálogo. Un event trigger `ddl_command_end` haría fallar la migración en vez del CI.                                                                                                                                                                                                                                                                                                                                              | Cuando alguien de fuera del equipo actual escriba migraciones, o al primer susto. Afecta a cómo se escriben todas las migraciones: va por ADR.                                                                                                                                                                                                                                                                              |
| **Cobertura de tests como artefacto.** Falta `@vitest/coverage-v8`, que no está en el stack aprobado (CLAUDE.md §7). El paso de subida ya está en `ci.yml`, sin producir nada.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Aprobación humana de la dependencia.                                                                                                                                                                                                                                                                                                                                                                                        |
| **Mutation testing de `packages/graph/src/parse/*`.** El paquete ya está en la lista `mutate` desde el 11 de septiembre de 2026 (issue #26), pero `parse/*` sigue fuera. Y ahora se sabe por qué con un número honesto: adoptado el ADR 0007, `parse/python.ts` pasa de **0 muertos / 229 timeouts / 78,69** a **145 muertos / 0 timeouts / 49,83**. La nota baja treinta puntos porque la anterior era falsa. El problema ya no es la instrumentación sino la cobertura: 85 supervivientes y 61 mutantes que ningún test toca, porque no hay tests de parse — se ejercita de refilón desde `ingest` y `parse-large-files`, 40 tests para 291 mutantes. | Escribir tests de parse que miren el árbol que devuelve tree-sitter, no la cuenta de nodos que acaba en la base de datos.                                                                                                                                                                                                                                                                                                   |
|                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **RESUELTO el 11 de septiembre de 2026 (issue #26).** `packages/graph` adoptó el ADR 0007: sus 13 ficheros de test comparten el servidor de Postgres del proceso y cada uno crea su base de datos. Cinco módulos entran al gate con cifras reales — `cochange/git.ts` 85,37, `queries.ts` 80,00, `ownership/score.ts` 79,17, `ingest/ingest.ts` 68,14 (10 timeouts sobre 368, algo inflada), `claims.ts` 67,62 (1 timeout). | Hecho. Queda `parse/*`, en la fila de arriba. |
| **Ranking de `blastRadius` con escalas mezcladas.** Ordena por `weight DESC` juntando aristas `static`/`build` (1.0 fijo) y `cochange` (el _lift_, sin cota superior; ver ADR 0005). Un par que coincidió tres veces en el historial puede quedar por delante de un import estático directo. Arreglarlo cambia el criterio de ranking documentado de T05 (normalizar el lift, o rankear por distancia y señal y dejar el peso como desempate).                                                                                                                                                                                                          | Decisión humana explícita: es un cambio de semántica de la respuesta, no una corrección.                                                                                                                                                                                                                                                                                                                                    |
| **`ANALYZE` durante la ingesta inicial del grafo.** Las tablas del grafo pasan de vacías a grandes dentro de una sola ingesta, y el autoanalyze de Postgres no llega a tiempo: el planner trabaja con estadísticas frías. Medido: con un `ANALYZE` entre lotes, 2.000 ficheros bajan de **62,7 s a 4,5 s**. El rol `app_runtime` no es dueño de las tablas, así que no puede lanzar `ANALYZE` por sí mismo (haría falta `GRANT MAINTAIN`, que es PostgreSQL ≥ 16, o que lo lance el rol de migraciones).                                                                                                                                                | El primer repositorio de cliente por encima de unos pocos miles de ficheros. Hoy el peor plan ya está arreglado en la consulta (`deleteStaticEdgesFrom`), que era el que hacía superlineal la ingesta.                                                                                                                                                                                                                      |
| **Política de cola con deduplicación.** `singletonKey` no deduplica con la política `standard`. Hoy no hace falta: la deduplicación de webhooks la da la restricción única de `webhook_deliveries`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | El primer caso de uso que necesite "este job, uno solo, aunque se pida diez veces".                                                                                                                                                                                                                                                                                                                                         |
