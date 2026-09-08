# @coord/queue

Implementación de `QueuePort` (el puerto de cola que define `@coord/core`) sobre
**pg-boss**, usando el mismo Postgres que el resto de la plataforma.

## Por qué existe la indirección

`pg-boss` es una decisión reversible: está en `CLAUDE.md` §3 como "cola de trabajos,
**detrás de una interfaz para poder cambiar**". El puerto vive en el dominio
(`packages/core/src/ports/queue.ts`) y esta es su única implementación.

La regla operativa, que además es criterio de aceptación de T04:

> No puede existir ni un solo `import` de `pg-boss` fuera de `packages/queue/`.

Nada de lo que sale por `src/index.ts` está expresado en tipos de pg-boss: ni sus
opciones, ni su clase, ni sus tipos de job. Cambiar de motor de cola debe ser un
cambio confinado a este directorio.

Lo comprueban dos cosas independientes:

- `dependency-cruiser`, regla `pg-boss-solo-en-queue` (CI).
- `test/no-pg-boss-imports.test.ts`, que recorre el código fuente del repo. Sigue
  fallando aunque alguien relaje la configuración de dependency-cruiser.

## Uso

```ts
import { runWithTenant } from '@coord/core'
import { PgBossQueue } from '@coord/queue'

const queue = PgBossQueue.fromEnv() // lee DATABASE_URL

// Los handlers pueden registrarse antes de start(): se enganchan al arrancar.
await queue.process<{ issueNumber: number }>('github.sync-issue', async (job) => {
  // Aquí dentro currentTenant() ya devuelve el tenant en el que se encoló.
  // No hay que fijarlo a mano y no se puede olvidar.
  await syncIssue(job.payload.issueNumber)
})

await queue.start()

// Encolar SIEMPRE dentro de un contexto de tenant.
await runWithTenant({ tenantId }, async () =>
  queue.enqueue('github.sync-issue', { issueNumber: 42 }),
)

// Apagado ordenado: espera a los jobs en vuelo.
await queue.stop()
```

### Contexto de tenant

`enqueue` y `schedule` llaman a `requireTenant()`: **encolar sin contexto de tenant
lanza `MissingTenantContextError`**, nunca crea un job huérfano. El `tenantId` (y
`actorId` / `requestId` si los hay) viajan dentro del payload, en un _envelope_
versionado, y `process` restaura el contexto con `runWithTenant` antes de invocar al
handler.

El envelope se valida con zod al recibirlo: es una frontera de confianza y lo que hay
en la tabla `job` lo escribió otro proceso. Un envelope inválido no se procesa "a ver
si cuela" — va directo a la cola de fallidos, sin reintentos, porque reintentar no lo
va a hacer válido.

En `schedule`, el tenant se congela en el momento de programar: cada disparo del cron
reproduce el contexto de quien creó la programación.

## Qué garantiza la cola (y qué no)

**Garantiza** que dos workers no procesan el mismo job A LA VEZ: `fetch` toma el job
bajo bloqueo y lo pasa a `active`. Eso es lo que verifica el test de
"exactly-once con varios workers".

**No garantiza** que un handler no pueda ejecutarse dos veces. Un job tiene un
_arriendo_ (`expireInSeconds`, 15 minutos por defecto en pg-boss): si el handler tarda
más que eso, la cola da el job por abandonado y vuelve a ponerlo disponible. Es decir,
en rigor la entrega es **al menos una vez**.

Consecuencias prácticas, las dos obligatorias:

1. **Los handlers deben ser idempotentes.** Volver a procesar no puede duplicar un
   efecto.
2. **Un handler lento tiene que declararlo**, con `expireInSeconds` en `EnqueueOptions`.

Y una trampa relacionada: **`singletonKey` no deduplica** con la política de cola que
usa esta implementación (`standard`). Dos `enqueue` con la misma clave crean dos jobs
—hay un test que lo fija—. Para deduplicar de verdad se usa una restricción única en
la base de datos, como hace `apps/webhook` con `webhook_deliveries.delivery_id`.

## Reintentos y cola de fallidos

Cada cola `X` se crea junto a su cola de fallidos `X.dlq`. Cuando un job agota sus
reintentos, se copia allí (con `source_id` apuntando al original).

Valores por defecto (sobreescribibles por cola en el constructor y job a job en
`EnqueueOptions`):

| Opción                 | Defecto | Motivo                                           |
| ---------------------- | ------- | ------------------------------------------------ |
| `retryLimit`           | 5       | Aguanta un despliegue o un corte breve de GitHub |
| `retryDelaySeconds`    | 5       | El primer reintento llega rápido                 |
| `retryBackoff`         | `true`  | Backoff exponencial con jitter                   |
| `retryDelayMaxSeconds` | 3600    | Sin tope, `2^n` se va a días                     |

Las opciones de una cola se **reconcilian** en cada arranque: `createQueue` de pg-boss
es un `INSERT ... ON CONFLICT DO NOTHING`, así que sobre una cola que ya existía las
opciones nuevas se descartarían en silencio. Esta implementación las relee con
`getQueue`, avisa por el log de la deriva encontrada y aplica las suyas con
`updateQueue`.

**El jitter no lo añadimos nosotros: lo trae pg-boss.** Al fallar un job aplica, en SQL:

```
start_after = now() + LEAST(
    retry_delay_max,
    GREATEST(retry_delay, 1) * ( 2^n/2 + 2^n/2 * random() )
) * interval '1s'          con n = LEAST(16, retry_count + 1)
```

Es decir, el retraso del intento _n_ cae uniformemente en
`[retryDelay · 2^(n-1), retryDelay · 2^n)`: mitad determinista, mitad aleatoria.
Añadir jitter por encima sería jitter sobre jitter y desdibujaría el suelo garantizado
del intervalo.

## ⚠️ PgBouncer: conexión directa, NUNCA modo transacción

**Esta clase se conecta directamente a Postgres (`DATABASE_URL`), no a PgBouncer
(`PGBOUNCER_URL`).**

La decisión de arquitectura de poner PgBouncer en modo transacción (`CLAUDE.md` §3)
aplica a la capa de datos de `packages/db`, **no a este paquete**. pg-boss gestiona su
propio pool y necesita conexiones con estado de sesión — en particular la conexión
dedicada de `LISTEN/NOTIFY`, que queda fijada a una sesión. PgBouncer en modo
transacción devuelve la conexión al pool en cada `COMMIT`, con lo que ese estado se
pierde y las notificaciones acaban en una sesión que ya no es la nuestra.

Los síntomas de equivocarse aquí son sutiles y tardíos: jobs que tardan en despertarse,
errores intermitentes de conexión, mantenimiento que no corre. Por eso está escrito
tanto aquí como en el comentario de cabecera de `src/pg-boss-queue.ts`.

## Esquema

pg-boss instala sus tablas en el esquema **`queue`**, no en `public`, para que el
esquema de la cola y el de dominio se puedan conceder, migrar y auditar por separado.
El rol con el que arranca necesita permiso para crear ese esquema la primera vez
(pg-boss migra su propio esquema al arrancar).

## Tests

```
pnpm --filter @coord/queue test
```

Postgres real levantado con testcontainers (hace falta Docker). Nada mockeado: lo que
se comprueba —un solo worker por job bajo concurrencia, backoff, cola de fallidos,
rechazo de envelopes corruptos, reconciliación de opciones— es
comportamiento del motor, y un doble solo demostraría que el doble hace lo que le hemos
dicho. Todas las evidencias se afirman leyendo la base de datos, nunca contadores en
memoria del proceso de test.
