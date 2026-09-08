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

## Deuda técnica registrada, con su disparador

Esto no es una lista de deseos: cada entrada dice cuándo deja de poder
aplazarse.

| Deuda                                                                                                                                                                                                                                                                                                        | Disparador                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Retención de `webhook_deliveries`.** Se inserta una fila por entrega aceptada y nada las borra nunca. La tabla y su índice único —que es lo que sostiene la deduplicación— crecen sin límite. GitHub reintenta durante horas, no meses, así que una ventana de retención del orden de 30 días es de sobra. | Cuando el listener reciba tráfico real de forma sostenida. La cola ya tiene `schedule`, así que la purga es un job programado, no un cron externo. |
| **`disableRequestLogging` de Fastify.** Deprecada en Fastify 5 (aviso `FSTDEP023` en cada arranque). No se migra a `logController` porque esa opción no admite un objeto parcial: exige las diez propiedades del controlador, es decir, reimplementar el que Fastify ya trae para cambiar un booleano.       | La subida a Fastify 6, que la elimina.                                                                                                             |
| **Event trigger que exija RLS al crear tablas.** Hoy, si una migración crea una tabla en `public` y se olvida de activar RLS forzada, `app_runtime` la ve entera y nada falla en runtime; la única red es el test de catálogo. Un event trigger `ddl_command_end` haría fallar la migración en vez del CI.   | Cuando alguien de fuera del equipo actual escriba migraciones, o al primer susto. Afecta a cómo se escriben todas las migraciones: va por ADR.     |
| **Cobertura de tests como artefacto.** Falta `@vitest/coverage-v8`, que no está en el stack aprobado (CLAUDE.md §7). El paso de subida ya está en `ci.yml`, sin producir nada.                                                                                                                               | Aprobación humana de la dependencia.                                                                                                               |
| **Política de cola con deduplicación.** `singletonKey` no deduplica con la política `standard`. Hoy no hace falta: la deduplicación de webhooks la da la restricción única de `webhook_deliveries`.                                                                                                          | El primer caso de uso que necesite "este job, uno solo, aunque se pida diez veces".                                                                |
