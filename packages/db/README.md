# @coord/db — esquema, migraciones y aislamiento entre tenants

Este paquete define el esquema de Postgres y la garantía de que **ningún cliente
puede ver los datos de otro**. Si algo de aquí se rompe, el producto filtra
código de un cliente a otro: trátalo en consecuencia.

La capa de acceso que hace cumplir esa garantía en tiempo de ejecución (pool,
cliente con contexto de tenant, PgBouncer) está en la sección 6.

---

## 1. Los dos roles de base de datos

| Rol            | Para qué                                     | Atributos                                               |
| -------------- | -------------------------------------------- | ------------------------------------------------------- |
| `app_migrator` | Aplica las migraciones. Dueño de las tablas. | `NOSUPERUSER NOBYPASSRLS NOCREATEROLE`                  |
| `app_runtime`  | El que usa la aplicación.                    | `NOSUPERUSER NOBYPASSRLS`, sin DDL, no es dueño de nada |

Los crea la migración `0001`. Es la única que necesita privilegios elevados
(`CREATEROLE`), así que se aplica una vez con un rol de administración; a partir
de ahí todas las demás corren como `app_migrator`. El bloque `DO` que los crea es
idempotente, de modo que si un DBA los creó antes a mano, la migración es un
no-op.

`app_runtime` **no tiene `BYPASSRLS`**, y la migración lo reafirma en cada
despliegue. Es la pieza que hace que las políticas de la sección 3 signifiquen
algo: un rol con `BYPASSRLS` (o un superusuario) se las salta enteras.

### Contraseñas

**Nunca están en el repositorio**, ni en las migraciones, ni en los tests (los
tests generan una aleatoria por ejecución). Se asignan fuera de banda leyéndolas
del entorno:

```bash
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE app_migrator WITH PASSWORD '$APP_MIGRATOR_PASSWORD'" \
  -c "ALTER ROLE app_runtime  WITH PASSWORD '$APP_RUNTIME_PASSWORD'"
```

y después se componen `DATABASE_MIGRATION_URL` (con la de `app_migrator`) y
`DATABASE_URL` (con la de `app_runtime`). Ver `.env.example`.

---

## 2. Migraciones

SQL plano, numerado, con secciones `-- Up Migration` / `-- Down Migration`.

```bash
pnpm --filter @coord/db migrate:up       # aplica las pendientes
pnpm --filter @coord/db migrate:down     # revierte la última
pnpm --filter @coord/db migrate:create nombre_en_ingles
```

`migrate:up` y `migrate:down` leen `DATABASE_MIGRATION_URL` y **fallan
ruidosamente** si no está: nunca caen al usuario de runtime.

La tabla de control (`pgmigrations`) vive en el schema `migrations`, no en
`public`. Así `public` contiene exclusivamente tablas de dominio y se puede
exigir sin excepciones que todas tengan RLS forzada — lo comprueba un test que
recorre el catálogo.

| Migración | Qué hace                                                           |
| --------- | ------------------------------------------------------------------ |
| `0001`    | Extensión `pgcrypto`, roles `app_migrator` / `app_runtime`, grants |
| `0002`    | Las 11 tablas del núcleo, índices y claves ajenas compuestas       |
| `0003`    | `ENABLE` + `FORCE ROW LEVEL SECURITY` y una política por tabla     |
| `0004`    | `audit_log` append-only (grants + trigger)                         |
| `0005`    | Semilla del RBAC base, por tenant, vía trigger sobre `tenants`     |

---

## 3. Aislamiento: cómo funciona

Cada tabla tiene una política `FOR ALL` con `USING` **y** `WITH CHECK`:

```sql
tenant_id = app_current_tenant_id()
```

donde `app_current_tenant_id()` lee `current_setting('app.tenant_id', true)`.

- Sin `WITH CHECK`, un `INSERT` podría colar una fila con el `tenant_id` de otro
  cliente: `USING` no mira los valores nuevos.
- Sin contexto, `current_setting(..., true)` devuelve `NULL`, y
  `tenant_id = NULL` no es `TRUE` sino `NULL`: **no se devuelve ninguna fila**.
  El modo degradado es "no devuelvo datos", nunca "los devuelvo todos".
- `FORCE` hace que la política aplique también al **dueño** de la tabla. Sin él,
  cualquier script que se conectara como `app_migrator` vería todos los tenants.

La aplicación fija el contexto por transacción:

```sql
BEGIN;
SELECT set_config('app.tenant_id', $1, true);  -- true = solo esta transacción
-- ... consultas ...
COMMIT;
```

`is_local = true` es importante con un pool: al terminar la transacción la
conexión vuelve a quedarse sin contexto, y la siguiente petición que la reutilice
no hereda el tenant de la anterior.

**Crear un tenant** también exige contexto, porque el `FORCE` alcanza a la propia
tabla `tenants`: se genera el uuid, se fija `app.tenant_id` a ese valor y se
inserta la fila con ese `id`. No existe ningún camino, ni para el dueño del
esquema, que escriba en `tenants` sin declarar sobre qué tenant trabaja.

---

## 4. Convenciones del esquema

- PK `uuid` con `gen_random_uuid()`; todos los instantes en `timestamptz`.
- Toda tabla lleva `tenant_id uuid NOT NULL REFERENCES tenants(id)`.
- **`tenant_id` es la columna líder de todo índice**, incluidos los de unicidad:
  las claves naturales son únicas _por tenant_ (`UNIQUE (tenant_id, email)`).
- Las relaciones usan **claves ajenas compuestas** contra `(tenant_id, id)`, así
  que mezclar entidades de dos tenants es imposible a nivel de motor, no solo
  desaconsejado.
- **RBAC real**: los permisos son filas `recurso:accion` en `permissions`,
  agrupadas por `roles` y asignadas con `user_roles`. No existe ninguna columna
  booleana de permisos, y un test lo comprueba contra `information_schema`.
- `tenants.database_url` va **siempre a NULL** hoy: significa "este tenant vive
  en el esquema compartido". Existe ya porque añadirla después obligaría a
  reescribir la capa de acceso (CLAUDE.md §4).

---

## 5. `audit_log`

Append-only con **dos cerrojos independientes**:

1. **Grants**: `app_runtime` solo tiene `SELECT` e `INSERT`. Un `UPDATE` o
   `DELETE` desde la aplicación muere con `42501` antes de tocar una fila.
2. **Trigger**: `BEFORE UPDATE OR DELETE OR TRUNCATE ... FOR EACH STATEMENT`
   lanza excepción. Esto cubre al **dueño** de la tabla, al que los grants no
   frenan. Es `FOR EACH STATEMENT` para que salte aunque la sentencia no case
   ninguna fila: se rechaza la intención, no solo el efecto.

API en `src/audit.ts`:

- `appendAuditEntry(db, entrada)` — toma tenant, actor y `request_id` del
  contexto (`runWithTenant`) si no se pasan.
- `readAuditLog(db, filtros)` — filtros por acción, actor, recurso y ventana
  temporal, con **paginación por keyset** `(occurred_at, id)`. No se usa `OFFSET`
  porque en un log activo las páginas se solaparían o se saltarían eventos.

Ambas exigen contexto de tenant y además filtran por `tenant_id` de forma
explícita. Ese filtro no es la defensa —la defensa es la RLS— sino una segunda
capa.

---

## 6. Capa de acceso: `withTenantConnection`

Todo el acceso a datos del producto pasa por una sola función:

```ts
import { runWithTenant } from '@coord/core'
import { withTenantConnection } from '@coord/db'

await runWithTenant({ tenantId, actorId, requestId }, () =>
  withTenantConnection(async (db) => {
    // El SQL no lleva filtro de tenant y aun así solo ve datos de este tenant.
    const { rows } = await db.query('SELECT id, email FROM users')
    return rows
  }),
)
```

El `Pool` de `pg` **no se exporta**. Si se exportara, `withTenantConnection`
pasaría de ser la única vía a ser la vía recomendada, y no es lo mismo.

Qué hace, en orden:

1. `requireTenant()`. Sin contexto lanza `MissingTenantContextError` **antes de
   pedir conexión**: no se abre transacción, no se ejecuta ninguna consulta. El
   modo degradado es un error ruidoso, nunca "devuelvo todo" ni "devuelvo nada".
2. Valida que el `tenantId` del contexto es un uuid. Es frontera de confianza:
   `runWithTenant` acepta cualquier `string`.
3. `BEGIN` y `SELECT set_config('app.tenant_id', $1, true)` — el valor va como
   **parámetro**, nunca interpolado.
4. Ejecuta el callback con un `TenantQuery`, que solo sabe hacer `query()`.
5. `COMMIT` al salir bien, `ROLLBACK` al fallar, y `release()` de la conexión
   **siempre**. El error original se propaga tal cual, sin envolver.

### La restricción que gobierna todo este diseño

PgBouncer corre en **modo transacción**, y ahí una conexión lógica de cliente no
está atada a un backend físico: dos consultas seguidas del mismo cliente pueden
caer en backends distintos, y un backend puede pasar a servir a un cliente de
otro tenant.

Por eso `SET app.tenant_id = ...` a nivel de **sesión** sería un bug de
seguridad: en el mejor caso se pierde, y en el peor se queda pegado en un
backend que después reutiliza otro tenant. La única forma correcta es
`set_config(..., true)` (local a la transacción) dentro de una transacción
explícita — que es lo que hace el punto 3 de arriba.

Está explicado largo y tendido en la cabecera de `src/client.ts`. **Léelo antes
de "simplificar" nada de ahí**, y antes de cambiar `POOL_MODE` en
`infra/docker-compose.yml`.

Consecuencias prácticas, todas en `src/pool.ts`:

- Nada de estado de sesión: ni `SET`, ni `LISTEN`, ni tablas temporales, ni
  advisory locks de sesión.
- Nada de prepared statements **con nombre**. `TenantQuery.query()` solo acepta
  `(text, values)` y no un objeto de consulta de `pg`, así que la prohibición la
  comprueba el compilador.
- Nada de parámetros de arranque raros (`statement_timeout` y compañía): se
  configuran en el servidor o con `SET LOCAL` dentro de la transacción.

### Anidamiento

Llamar a `withTenantConnection` (o a su alias `withTenantTransaction`) dentro de
otra **reutiliza la misma conexión** y abre un `SAVEPOINT`. Si no lo hiciera,
la llamada interior sería otra transacción, no vería lo escrito por la exterior,
y bajo carga se llegaría al deadlock de pool clásico. Un fallo dentro del bloque
anidado deshace solo su savepoint; la transacción exterior sigue utilizable.

Cambiar de tenant dentro de una transacción abierta se **rechaza**: no hay forma
correcta de hacerlo, porque el `set_config` local pisaría el de la transacción
exterior.

### `unsafeWithoutTenantScope`

El nombre es feo a propósito: cada uso debe doler al leerlo en una revisión.
Abre una transacción **sin** fijar `app.tenant_id`, y deja constancia en
`audit_log` (en su propia transacción y **antes** de ejecutar, para que el
rastro sobreviva a un fallo).

Se permite para: inspección del catálogo, consultas al schema `migrations`, y
mantenimiento con la conexión de migraciones.

No se permite para leer o escribir datos de un tenant — bajo RLS forzada
devolvería cero filas de todas formas. Y **no hace falta para crear un tenant**:
para eso se genera el uuid y se usa
`runWithTenant({ tenantId: nuevoId }, () => withTenantConnection(...))`, porque
la política de `tenants` compara contra `id`.

### Configuración

```ts
import {
  configureDatabase,
  closeDatabase,
  getPoolStats,
  resolveRuntimeConnectionString,
} from '@coord/db'

configureDatabase({ connectionString: resolveRuntimeConnectionString(), max: 20 })
```

**Dos variables, dos destinos, y no son intercambiables:**

| Variable        | Apunta a                           | Quién la usa                                |
| --------------- | ---------------------------------- | ------------------------------------------- |
| `PGBOUNCER_URL` | PgBouncer, modo transacción (6432) | **Todo el acceso a datos de la aplicación** |
| `DATABASE_URL`  | Postgres directo (5432)            | pg-boss (`LISTEN/NOTIFY`) y las migraciones |

`resolveRuntimeConnectionString()` es el único sitio donde vive esa convención:
prefiere `PGBOUNCER_URL` y, si no está, cae a `DATABASE_URL` **avisando por
consola**. Saltarse el pooler sin enterarse era exactamente cómo se perdía la
garantía del primer criterio de T03.

Sin `configureDatabase`, el pool se crea perezosamente con esa misma función.
Si no hay ninguna de las dos variables, falla con un mensaje explícito.
`getPoolStats()` expone `total`/`idle`/`waiting` sin exponer el `Pool`.

---

## 7. Tests

```bash
pnpm --filter @coord/db test
```

`test/tenant-isolation.test.ts` levanta un Postgres real con testcontainers
(hace falta Docker). Nada está mockeado: lo que se comprueba es el
comportamiento del motor. El montaje reproduce la separación de roles, de forma
que las tablas son propiedad de `app_migrator` y el `FORCE` se ejerce de verdad.

Cubre: solo se ven filas del tenant activo; una consulta mal escrita sin
`WHERE tenant_id` sigue sin filtrar; sin contexto no se ve nada; `WITH CHECK`
rechaza escribir en otro tenant; `audit_log` rechaza `UPDATE`/`DELETE` tanto para
runtime como para el dueño; ninguna tabla de `public` se ha quedado sin RLS
forzada; y no existe ninguna columna `is_admin`.

`test/tenant-access-layer.test.ts` hace lo mismo con la capa de la sección 6:
aislamiento a través de la capa; sin contexto lanza y **no llega a crear ninguna
conexión** (se comprueba con el contador del pool, con un control que demuestra
que ese contador sabe subir); el `app.tenant_id` no se queda pegado en una
conexión física reutilizada (`max: 1`, y se verifica con `pg_backend_pid()` que
es la misma); 100 operaciones concurrentes de 20 tenants sobre un pool de 8 no
se cruzan; savepoints; y propagación de errores.

`test/pgbouncer.test.ts` levanta **PgBouncer de verdad** (`GenericContainer`)
delante de Postgres, abre 200 conexiones de cliente simultáneas y comprueba
contra `pg_stat_activity` —desde una conexión directa, sin pasar por el pooler—
que las conexiones reales no superan `default_pool_size`. Es el criterio de
aceptación literal de T03.
