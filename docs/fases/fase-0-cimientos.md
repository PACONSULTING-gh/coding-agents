# Fase 0 — Cimientos técnicos

**Epic 01** · issues [#1](https://github.com/PACONSULTING-gh/coding-agents/issues/1) y #2–#8 · **T01–T06 construidas, T07 bloqueada**

El esqueleto multi-tenant sobre el que se apoya todo lo demás. Deliberadamente
**no** hace nada de IA, ni de UI, ni de coordinación: solo fontanería.

Diagramas: [`arquitectura`](../diagrams/arquitectura.architecture.json) (módulos)
y [`webhook`](../diagrams/webhook.sequence.json) (ciclo de vida de una entrega).

---

## 1. Aislamiento entre clientes — la pieza que sostiene el producto

Si esto falla, el producto filtra código de un cliente a otro. Todo lo demás es
secundario.

**Esquema compartido con RLS forzada.** Las 19 tablas llevan `tenant_id`,
`ENABLE ROW LEVEL SECURITY` **y** `FORCE ROW LEVEL SECURITY`. El `FORCE` es lo
que hace que la política aplique también al dueño de la tabla; sin él, la defensa
se cae en cuanto algo corre como propietario.

Cada política es `FOR ALL` con `USING` **y** `WITH CHECK`:

```sql
tenant_id = app_current_tenant_id()
```

`current_setting('app.tenant_id', true)` devuelve `NULL` sin contexto, y
`tenant_id = NULL` es `NULL` — no devuelve filas. **Falla cerrado.** Sin el
`WITH CHECK`, un `INSERT` podría colar filas de otro tenant; ese es exactamente
el agujero que la política existe para tapar.

**Claves ajenas compuestas** contra `(tenant_id, id)`: mezclar tenants es
imposible a nivel de motor, no por disciplina del programador.

**Dos roles.** `app_migrator` es dueño del esquema y aplica migraciones;
`app_runtime` es el de la aplicación, `NOSUPERUSER NOBYPASSRLS`, y no es dueño de
nada. Un rol con `BYPASSRLS` se salta todas las políticas, así que la migración
lo reafirma en cada despliegue.

**`audit_log` es append-only por dos vías independientes:** `REVOKE UPDATE,
DELETE` a `app_runtime`, y un trigger `BEFORE UPDATE OR DELETE` que lanza
excepción — para que ni el dueño pueda.

### Verificado, no supuesto

Como `app_runtime`, a través de PgBouncer, con el contexto del tenant A:

| Prueba                                                 | Resultado                                    |
| ------------------------------------------------------ | -------------------------------------------- |
| `SELECT * FROM users` **sin ningún `WHERE tenant_id`** | solo filas del tenant A                      |
| Sin contexto de tenant                                 | 0 filas                                      |
| `INSERT` con `tenant_id` ajeno                         | `new row violates row-level security policy` |
| `UPDATE` sobre `audit_log`                             | `permission denied for table audit_log`      |
| `rolsuper` / `rolbypassrls` de `app_runtime`           | `f` / `f`                                    |

Hay además un test que recorre el catálogo (`pg_class`) y exige RLS forzada en el
**100%** de `public`, para que ninguna tabla futura entre sin protección. Por eso
la tabla de control de migraciones vive en el esquema `migrations` y no en
`public`: así la exigencia no necesita excepciones memorizadas.

---

## 2. PgBouncer y la restricción que gobierna la capa de datos

PgBouncer va en **modo transacción**: el backend se libera al terminar cada
transacción, y unos pocos sirven a cientos de clientes. El límite de conexiones
de Postgres es la primera pared que se toca.

El precio de ese modo, y la razón de que `packages/db` esté escrito como está:
**no hay estado de sesión**. Dos consultas seguidas del mismo cliente pueden caer
en backends distintos.

> Un `SET app.tenant_id` de sesión aquí **no es un bug de rendimiento, es un
> fallo de aislamiento**: se pierde, o peor, se queda pegado en una conexión que
> luego reutiliza otro tenant.

Por eso el contexto se fija con `set_config('app.tenant_id', $1, true)` — local a
la transacción, y con el valor **parametrizado**, nunca interpolado.

`withTenantConnection` es la única vía de consulta que expone el paquete. Llama a
`requireTenant()` **antes** de tocar la base: sin contexto lanza
`MissingTenantContextError` y no llega a ejecutar ninguna consulta. Hay test de
que no ejecutó nada, no solo de que lanzó.

Para las poquísimas operaciones administrativas legítimas —resolver
`installation_id → tenant` ocurre necesariamente antes de tener tenant— existe
`unsafeWithoutTenantScope`: nombre feo a propósito, auditada en `audit_log`, y
con una regla de ESLint que prohíbe importarla fuera de `packages/db`.

**Medido:** 200 conexiones de cliente simultáneas por PgBouncer mantienen las
conexiones reales a Postgres por debajo del pool configurado, comprobado
consultando `pg_stat_activity`.

---

## 3. Cola detrás de un puerto

`pg-boss` sobre el mismo Postgres, envuelto en `QueuePort` (definido en
`packages/core`). Nada de `pg-boss` sale del paquete: una fitness function
recorre el repo y falla si aparece un `import` fuera de `packages/queue`.

- `enqueue` toma el tenant de `requireTenant()`: encolar sin contexto **lanza**,
  en vez de crear un job huérfano.
- `process` restaura el contexto con `runWithTenant` **antes** de invocar el
  handler, así el job se procesa en el tenant donde se encoló.
- El envelope se valida con zod al recibirlo. Es frontera de confianza.

> **`pg-boss` NO pasa por PgBouncer.** Usa `LISTEN/NOTIFY` y estado de sesión,
> que el modo transacción rompe. Va por conexión directa, y está escrito en el
> código y en el README porque es el detalle que alguien rompe sin querer.

### Un fallo que solo apareció al arrancarlo de verdad

`pg-boss` crea su esquema la primera vez que arranca, y `app_runtime` no tiene
`CREATE` sobre la base — la migración 0001 se lo revoca **a propósito**. El
listener y el worker morían con `permission denied for database` (SQLSTATE
`42501`). La cola estaba entregada, con 22 tests en verde, **y no se podía
desplegar**.

Se escapó porque todos los tests de integración conectan con el superusuario del
contenedor. **Un test que solo prueba el camino privilegiado no prueba el camino
que se despliega.**

El esquema lo instala ahora `app_migrator`, una vez, con
`pnpm --filter @coord/queue queue:install`. A `app_runtime` se le conceden `USAGE`
y `CREATE` **solo sobre el esquema `queue`** —pg-boss crea una partición por cola
en runtime—, nunca sobre `public` ni sobre la base.

> **Límite conocido:** las tablas de pg-boss **no llevan RLS**. Dentro de un job,
> el aislamiento lo da el envelope y `runWithTenant`, no la base. Quien pueda
> leer `queue.job` ve payloads de todos los tenants.

---

## 4. GitHub App y el listener

**El listener no procesa nada.** Verifica firma, deduplica, encola y responde.
Toda la lógica vive en el worker. El diagrama de secuencia
[`webhook`](../diagrams/webhook.sequence.json) lo recorre entero.

**El HMAC se calcula sobre el cuerpo CRUDO.** Si se parsea el JSON y se
reserializa antes de verificar, los bytes cambian y la verificación pasa a ser
decorativa. Fastify va configurado para conservar el raw body, y la comparación
es en tiempo constante. Hay un test con el cuerpo indentado que delataría una
reserialización.

**La deduplicación se apoya en la restricción `UNIQUE` de la base**, con
`INSERT ... ON CONFLICT DO NOTHING`, no en un `SELECT` previo: eso tiene carrera y
dos entregas simultáneas la ganan. Hay test del caso concurrente, no solo del
secuencial.

**Medido en local, extremo a extremo:**

| Caso                                           | Resultado                                       |
| ---------------------------------------------- | ----------------------------------------------- |
| Webhook válido firmado                         | `200 queued` en **19 ms** (criterio: <500 ms)   |
| Mismo `x-github-delivery` otra vez             | `200 duplicate`, 1 solo job, estado `completed` |
| Firma inválida                                 | `401`, y el intento queda en `audit_log`        |
| Cuerpo alterado en **un byte**, firma original | `401`                                           |

### Lo que falta

La GitHub App **no está registrada**. `docs/github-app-setup.md` tiene los pasos
con la justificación de cada permiso; lo ejecuta una persona (`CLAUDE.md` §2.1).

Y `InstallationTokenCache` está implementada y probada, pero **no tiene ningún
consumidor en producción**: el 5º criterio de T05 no se ejerce en el sistema
entregado. O se declara diferido, o T05 no está cerrada.

---

## 5. Gates de calidad

Los detalles están en [`../quality-gates.md`](../quality-gates.md). Lo que importa
para esta fase es qué estaba **roto** al entregarse, porque es la lección:

| Gate                              | Parecía puesto                        | Estaba                                                                                                                                                |
| --------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fitness functions de arquitectura | sí, y la doc afirmaba haberlo probado | **inerte**: `dependency-cruiser` excluía `dist/`, y bajo pnpm los imports entre paquetes resuelven ahí, así que no quedaba ni una arista que analizar |
| Pre-commit de formato             | sí                                    | **reformateaba y dejaba pasar** el commit: el desarrollador commiteaba lo que no había visto                                                          |
| Mutation testing                  | sí                                    | **no arrancaba**: clave inválida en `thresholds`                                                                                                      |
| CI                                | sí                                    | habría fallado en el **primer checkout limpio**: ningún job construía el workspace y `dist/` está en `.gitignore`                                     |

Los cuatro los encontró la verificación en contexto aislado (`CLAUDE.md` §2.3).
En un caso la documentación afirmaba una verificación empírica que **nunca
ocurrió**.

**CI real:** 9 jobs en verde en 1,8 min (criterio: <10 min).

---

## 6. Deuda declarada

- **Las PK son `(id)`, no `(tenant_id, id)`**, así que 15 de 39 índices no llevan
  `tenant_id` de líder. Cubierto por un test con lista explícita de excepciones.
  Cambiarlas afecta a todas las FK: merece ADR, no cambio silencioso.
- **`packages/graph` queda fuera del mutation testing**, con la medición que lo
  justifica en `stryker.config.json`. Incluirlo daba 79% de mutantes estáticos,
  229 timeouts, **0 mutantes muertos** y una puntuación de 78,69 que superaba el
  umbral de 60 sin que ningún test matara nada. Un umbral superado en vacío es
  peor que no medir.
- **El escaneo de IaC no cubre `infra/`**: ni Trivy ni Checkov parsean
  docker-compose. El job está puesto para cubrir el primer Dockerfile o Terraform
  desde su primer commit.
