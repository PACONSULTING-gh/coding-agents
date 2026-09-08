import { AsyncLocalStorage } from 'node:async_hooks'

import {
  currentTenant,
  DomainError,
  requireTenant,
  uuidSchema,
  ValidationError,
  type TenantId,
  runWithTenant,
} from '@coord/core'
import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { z } from 'zod'

import { appendAuditEntry } from './audit.js'
import { getPool } from './pool.js'
import type { Queryable } from './queryable.js'

/**
 * Capa de acceso a datos con contexto de tenant automatico.
 *
 * Esto es lo que hace que ningun desarrollador tenga que acordarse de filtrar
 * por tenant: `withTenantConnection` toma el tenant de `runWithTenant`
 * (AsyncLocalStorage, packages/core) y lo fija en la transaccion antes de
 * ejecutar nada. Si no hay contexto, falla ruidosamente ANTES de tocar la base
 * de datos. Nunca devuelve "todo" ni "nada en silencio".
 *
 * ---------------------------------------------------------------------------
 * POR QUE `set_config(..., true)` Y NO `SET app.tenant_id = ...`
 * ---------------------------------------------------------------------------
 * LEE ESTO ANTES DE "SIMPLIFICAR" NADA DE AQUI ABAJO.
 *
 * Corremos detras de PgBouncer en MODO TRANSACCION. En ese modo, una conexion
 * logica de cliente no esta atada a un backend fisico de Postgres: PgBouncer
 * devuelve el backend al pool en cuanto acaba cada transaccion, y la siguiente
 * transaccion del mismo cliente puede caer en OTRO backend, mientras que ese
 * backend puede pasar a servir a OTRO cliente, de otro tenant.
 *
 * Por lo tanto, fijar el tenant a nivel de SESION (`SET app.tenant_id = ...`
 * fuera de transaccion) es un BUG DE SEGURIDAD, no un atajo:
 *
 *   - En el mejor caso se pierde, porque la siguiente consulta cae en otro
 *     backend, y la RLS deja de devolver filas: fallo ruidoso, molesto.
 *   - En el peor caso SE QUEDA PEGADO en el backend, PgBouncer se lo entrega a
 *     un cliente de otro tenant, y ese cliente lee datos ajenos. Ese es el
 *     fallo silencioso que destruye el producto.
 *
 * La unica forma correcta, y la que implementa este modulo, es:
 *
 *     BEGIN;
 *     SELECT set_config('app.tenant_id', $1, true);  -- true = LOCAL a la tx
 *     ...
 *     COMMIT;
 *
 * El tercer argumento `true` hace el ajuste local a la transaccion: al
 * terminar (COMMIT o ROLLBACK) Postgres lo revierte solo, asi que el backend
 * vuelve al pool de PgBouncer SIN tenant. Y el valor viaja como PARAMETRO
 * (`$1`), nunca interpolado en el texto del SQL: `set_config` es una funcion
 * normal y admite parametros, asi que no hay excusa para concatenar.
 *
 * El test `packages/db/test/tenant-access-layer.test.ts` (bloque 3) verifica
 * exactamente esto: dos transacciones seguidas sobre la MISMA conexion fisica
 * y una tercera sin contexto que confirma que no quedo nada pegado.
 */

/**
 * Lo unico contra lo que se puede consultar desde fuera de este paquete. No
 * expone `release()`, ni `BEGIN`, ni el `Pool`: quien lo recibe puede lanzar
 * consultas y nada mas, y todas ellas corren con el tenant ya fijado.
 *
 * La firma acepta `(text, values)` y NO un objeto de consulta de `pg`. Es
 * deliberado: el objeto es la unica via de `pg` para pedir un prepared
 * statement CON NOMBRE, que en modo transaccion se rompe (ver pool.ts). Al no
 * existir en el tipo, la prohibicion la comprueba el compilador.
 */
export interface TenantQuery extends Queryable {
  /** Tenant fijado en esta transaccion. Coincide con `app.tenant_id` en el servidor. */
  readonly tenantId: TenantId
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>
}

/**
 * El handle `TenantQuery` que recibe un callback deja de servir en cuanto el
 * callback termina: su transaccion ya hizo COMMIT (o ROLLBACK) y su conexion ha
 * vuelto al pool, donde —detras de PgBouncer en modo transaccion— puede estar
 * sirviendo ya a OTRO tenant.
 *
 * Sin esta invalidacion, una consulta lanzada con un handle guardado fuera del
 * bloque se ejecutaba de verdad: la RLS falla cerrado y devuelve CERO filas,
 * asi que el sintoma era un cero silencioso en vez del fallo explicito que
 * exige el tercer criterio de T03, ademas de intercalar mensajes de protocolo
 * con el siguiente prestatario de la conexion.
 */
export class ClosedTransactionError extends DomainError {
  constructor() {
    super(
      'Esta transaccion ya termino: el handle solo es valido DENTRO del callback de ' +
        'withTenantConnection/withTenantTransaction. No lo guardes fuera del bloque; abre otra ' +
        'transaccion si necesitas seguir consultando.',
      'CLOSED_TRANSACTION',
    )
  }
}

/** Un handle de consulta mas la palanca para invalidarlo al salir de su bloque. */
interface QueryHandle<Q extends Queryable> {
  readonly db: Q
  close(): void
}

interface ActiveTransaction {
  readonly tenantId: TenantId
  /**
   * Conexion cruda de la transaccion exterior. Se guarda el cliente y no un
   * `TenantQuery` porque los handles que se entregan a los callbacks se
   * invalidan al salir de su bloque, y los SAVEPOINT de las anidadas tienen que
   * seguir emitiendose durante toda la transaccion exterior.
   */
  readonly client: PoolClient
  /** Contador monotono para nombrar SAVEPOINTs. Nunca se decrementa: no se reutilizan nombres. */
  nextSavepoint: number
  /**
   * Cola de exclusion mutua de la transaccion.
   *
   * LEE ESTO ANTES DE QUITARLA. Una transaccion es UNA conexion y UNA pila de
   * SAVEPOINTs. Dos llamadas anidadas CONCURRENTES (el `Promise.all` de dos
   * operaciones de repositorio, el patron mas normal del mundo) intercalaban
   * sus SAVEPOINTs sobre esa unica pila: la que fallaba hacia
   * `ROLLBACK TO SAVEPOINT` de un punto ANTERIOR al de la que habia tenido
   * exito y, como en Postgres eso deshace todo lo ejecutado despues del
   * savepoint, se llevaba por delante lo que la otra habia escrito — mientras
   * esa otra devolvia "ok" y el COMMIT exterior confirmaba. Perdida de datos
   * silenciosa con retorno de exito. La variante gemela: si la primera liberaba
   * antes, su `RELEASE SAVEPOINT` destruia tambien el savepoint de la segunda y
   * el `RELEASE` de esta reventaba.
   *
   * Serializar no cuesta concurrencia real: un `PoolClient` de `pg` ya ejecuta
   * sus consultas de una en una. Lo unico que se compra aqui es que cada
   * SAVEPOINT se abra y se cierre en orden LIFO estricto.
   */
  tail: Promise<void>
}

/**
 * Transaccion en curso en esta cadena asincrona. Sirve para que una llamada
 * anidada a `withTenantConnection` reutilice la conexion y abra un SAVEPOINT en
 * vez de pedir una segunda conexion del pool: dos conexiones serian dos
 * transacciones distintas, la interior no veria lo que escribio la exterior, y
 * bajo carga se llegaria al deadlock de pool clasico (cada llamada externa
 * reteniendo una conexion mientras espera otra).
 */
const activeTransaction = new AsyncLocalStorage<ActiveTransaction>()

/**
 * El tenant es frontera de confianza: entra por `runWithTenant`, que lo acepta
 * como `string` sin mirarlo. Se valida aqui, antes de mandarlo al servidor.
 */
function parseTenantId(tenantId: TenantId): TenantId {
  const parsed = uuidSchema.safeParse(tenantId)
  if (!parsed.success) {
    throw new ValidationError(
      `El tenantId del contexto no es un uuid valido: ${JSON.stringify(tenantId)}.`,
      { cause: parsed.error },
    )
  }
  return parsed.data
}

type TenantQueryFn = TenantQuery['query']

/**
 * Fabrica una funcion de consulta ligada a `client` y a un flag de cierre. Una
 * vez cerrada, rechaza con `ClosedTransactionError` en vez de mandar la
 * consulta a una conexion que ya no es suya.
 */
function makeQueryFn(client: PoolClient, isClosed: () => boolean): TenantQueryFn {
  return <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> => {
    if (isClosed()) {
      return Promise.reject(new ClosedTransactionError())
    }
    // Se copia el array porque `pg` lo tipa mutable; asi el llamante puede
    // pasar un `readonly unknown[]` sin castings.
    return client.query<R>(text, values === undefined ? undefined : [...values])
  }
}

/** Sin `tenantId`: es lo que recibe la via administrativa, que no tiene tenant fijado. */
function makeQueryableHandle(client: PoolClient): QueryHandle<Queryable> {
  let closed = false
  return {
    db: { query: makeQueryFn(client, () => closed) },
    close: () => {
      closed = true
    },
  }
}

function makeTenantQueryHandle(client: PoolClient, tenantId: TenantId): QueryHandle<TenantQuery> {
  let closed = false
  return {
    db: { tenantId, query: makeQueryFn(client, () => closed) },
    close: () => {
      closed = true
    },
  }
}

/**
 * Intenta deshacer. Devuelve `false` si el ROLLBACK fallo, en cuyo caso la
 * conexion queda en estado desconocido y hay que destruirla en vez de
 * devolverla al pool.
 *
 * El error del ROLLBACK no se traga (CLAUDE.md 5): se reporta con su causa. Lo
 * que NO se hace es propagarlo en lugar del error original, porque el original
 * es el que explica por que estamos deshaciendo.
 */
async function tryRollback(client: PoolClient, sql: string, cause: unknown): Promise<boolean> {
  try {
    await client.query(sql)
    return true
  } catch (rollbackError) {
    console.error(
      `[@coord/db] fallo el "${sql}" tras un error en la transaccion de tenant. ` +
        'Se propaga el error original y se descarta la conexion.',
      { rollbackError, causaOriginal: cause },
    )
    return false
  }
}

async function runInNewTransaction<T>(
  tenantId: TenantId,
  fn: (tx: TenantQuery) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  let discardConnection = false
  try {
    await client.query('BEGIN')
    // Aqui, y solo aqui, se fija el tenant. `true` = local a esta transaccion
    // (ver el comentario largo de la cabecera del modulo). El valor va como
    // parametro $2, nunca interpolado.
    await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId])

    const handle = makeTenantQueryHandle(client, tenantId)
    const active: ActiveTransaction = {
      tenantId,
      client,
      nextSavepoint: 1,
      tail: Promise.resolve(),
    }
    let result: T
    try {
      result = await activeTransaction.run(active, () => fn(handle.db))
    } finally {
      // Al salir del bloque el handle deja de valer, pase lo que pase. Se cierra
      // ANTES del COMMIT para que ni siquiera un `finally` del llamante pueda
      // colar una consulta en la transaccion que se esta cerrando.
      handle.close()
    }

    await client.query('COMMIT')
    return result
  } catch (error) {
    discardConnection = !(await tryRollback(client, 'ROLLBACK', error))
    throw error
  } finally {
    // Siempre. Aunque el COMMIT haya fallado, aunque el ROLLBACK haya fallado.
    // Una conexion no devuelta es una fuga que acaba agotando el pool.
    client.release(discardConnection)
  }
}

async function runOneSavepoint<T>(
  active: ActiveTransaction,
  fn: (tx: TenantQuery) => Promise<T>,
): Promise<T> {
  // Nombre generado desde un contador interno, no desde datos del llamante: no
  // hay forma de inyectar SQL por aqui. Se reserva DENTRO del turno de la cola,
  // para que el orden de los nombres sea el orden real de apertura.
  const name = `coord_sp_${String(active.nextSavepoint)}`
  active.nextSavepoint += 1

  const handle = makeTenantQueryHandle(active.client, active.tenantId)
  await active.client.query(`SAVEPOINT ${name}`)
  try {
    const result = await fn(handle.db)
    handle.close()
    await active.client.query(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch (error) {
    handle.close()
    // Si esto falla, la transaccion exterior queda abortada y su COMMIT
    // reventara: el error sale igualmente, nunca se queda dentro.
    await active.client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch((rollbackError: unknown) => {
      console.error(
        `[@coord/db] fallo el "ROLLBACK TO SAVEPOINT ${name}". La transaccion exterior ` +
          'quedara abortada y su COMMIT fallara.',
        { rollbackError, causaOriginal: error },
      )
    })
    throw error
  }
}

/**
 * Encola el bloque anidado detras de los que ya estan en vuelo sobre esta misma
 * transaccion (ver `ActiveTransaction.tail`). El encolado es lo que garantiza el
 * orden LIFO estricto de la pila de SAVEPOINTs.
 */
function runInSavepoint<T>(
  active: ActiveTransaction,
  fn: (tx: TenantQuery) => Promise<T>,
): Promise<T> {
  const turn = async (): Promise<T> => runOneSavepoint(active, fn)
  // Se encadena tanto en exito como en fallo: que la anterior haya fallado no
  // exime a la siguiente de esperar a que su SAVEPOINT este cerrado.
  const result = active.tail.then(turn, turn)
  // La cola nunca guarda una promesa rechazada: si lo hiciera, el rechazo de una
  // anidada se convertiria en un unhandledRejection al no tener mas consumidores
  // que la propia cola. El error real ya viaja por `result`, hacia el llamante.
  active.tail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Ejecuta `fn` con una conexion cuyo `app.tenant_id` ya esta fijado al tenant
 * del contexto activo (`runWithTenant`).
 *
 * - Sin contexto de tenant lanza `MissingTenantContextError` SIN tocar la base
 *   de datos: no se pide conexion, no se ejecuta ninguna consulta.
 * - Si ya hay una transaccion de tenant en curso en esta cadena asincrona,
 *   reutiliza su conexion y anida con un SAVEPOINT.
 * - `COMMIT` al salir bien, `ROLLBACK` al fallar, `release()` siempre.
 * - El error original se propaga tal cual, sin envolver y sin perder la causa.
 */
export async function withTenantConnection<T>(fn: (tx: TenantQuery) => Promise<T>): Promise<T> {
  // Paso 1, antes de cualquier E/S: si no hay contexto, esto lanza
  // MissingTenantContextError.
  const tenantId = parseTenantId(requireTenant().tenantId)

  const active = activeTransaction.getStore()
  if (active === undefined) {
    return runInNewTransaction(tenantId, fn)
  }

  if (active.tenantId !== tenantId) {
    // Cambiar de tenant a mitad de una transaccion es imposible de hacer bien:
    // `set_config` local pisaria el de la transaccion exterior y lo que quede
    // de ella leeria con el tenant equivocado. Se rechaza en vez de intentarlo.
    throw new ValidationError(
      `Cambio de tenant dentro de una transaccion abierta: la transaccion se abrio para ` +
        `${active.tenantId} y ahora el contexto dice ${tenantId}. Cierra la transaccion ` +
        'exterior antes de trabajar con otro tenant.',
    )
  }

  return runInSavepoint(active, fn)
}

/**
 * Mismo comportamiento que `withTenantConnection`, con otro nombre para cuando
 * al llamante le importa subrayar que su bloque es atomico (tipicamente, una
 * anidacion que se resuelve con SAVEPOINT).
 *
 * Es deliberadamente un alias y no una segunda implementacion: si hubiera dos,
 * habria dos sitios donde se fija el tenant, y tarde o temprano solo uno de los
 * dos se arreglaria (CLAUDE.md 2.4).
 */
export const withTenantTransaction = withTenantConnection

const unsafeJustificationSchema = z.object({
  /** Identificador estable de la operacion, p.ej. `tenant.provision`. */
  operation: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  /** Por que hace falta salirse del scope. Va literal al audit_log. */
  reason: z.string().min(20),
  /** Tenant bajo cuyo registro queda constancia. Por defecto, el del contexto activo. */
  auditTenantId: uuidSchema.optional(),
})
export type UnsafeScopeJustification = z.infer<typeof unsafeJustificationSchema>

/**
 * Abre una transaccion SIN fijar `app.tenant_id`. El nombre es feo a proposito:
 * cada uso debe doler al leerlo en una revision.
 *
 * ## Cuando esta permitido usarla
 *
 * Solo para operaciones ADMINISTRATIVAS que, por definicion, no pertenecen a un
 * tenant concreto:
 *
 *   - Inspeccion del catalogo (`pg_catalog`, `information_schema`) en arranques
 *     y comprobaciones de salud del esquema.
 *   - Consultas al schema `migrations` (estado del historial de migraciones).
 *   - DDL y mantenimiento ejecutados con la conexion de migraciones.
 *
 * ## Cuando NO
 *
 *   - Para leer o escribir datos de un tenant. Bajo RLS forzada, sin
 *     `app.tenant_id` las tablas de dominio devuelven CERO filas: si lo que
 *     buscabas eran datos, esta funcion no te los va a dar, y si algun dia te
 *     los diera seria porque alguien concedio BYPASSRLS y el aislamiento entre
 *     clientes ya estaria roto.
 *   - Para crear un tenant. Eso NO necesita esta funcion: genera el uuid y usa
 *     `runWithTenant({ tenantId: nuevoId }, () => withTenantConnection(...))`.
 *     La politica de `tenants` compara contra `id`, asi que la insercion pasa.
 *
 * ## Rastro
 *
 * Cada uso deja una entrada en `audit_log`, en su PROPIA transaccion y ANTES de
 * ejecutar el callback: asi la constancia sobrevive aunque la operacion falle o
 * se deshaga. Como `audit_log` tambien esta bajo RLS, la entrada se atribuye a
 * un tenant: `auditTenantId`, o el del contexto activo si lo hay. Si no hay
 * ninguno de los dos, la llamada se rechaza — antes se para la operacion que se
 * ejecuta sin dejar rastro.
 */
export async function unsafeWithoutTenantScope<T>(
  justification: UnsafeScopeJustification,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const parsed = unsafeJustificationSchema.parse(justification)

  if (activeTransaction.getStore() !== undefined) {
    throw new ValidationError(
      'unsafeWithoutTenantScope no puede llamarse dentro de una transaccion de tenant: la ' +
        'conexion ya tiene un tenant fijado y el resultado seria enganoso. Saca la operacion ' +
        'administrativa fuera del bloque withTenantConnection.',
    )
  }

  const ambient = currentTenant()
  const auditTenantId = parsed.auditTenantId ?? ambient?.tenantId
  if (auditTenantId === undefined) {
    throw new ValidationError(
      'unsafeWithoutTenantScope exige saber bajo que tenant registrar el uso: pasa ' +
        'auditTenantId, o llama dentro de runWithTenant. Sin rastro no se sale del scope.',
    )
  }

  await runWithTenant(
    {
      tenantId: auditTenantId,
      ...(ambient?.actorId !== undefined ? { actorId: ambient.actorId } : {}),
      ...(ambient?.requestId !== undefined ? { requestId: ambient.requestId } : {}),
    },
    () =>
      withTenantConnection((tx) =>
        appendAuditEntry(tx, {
          action: 'db.unsafe_without_tenant_scope',
          resourceType: 'database',
          resourceId: parsed.operation,
          metadata: { operation: parsed.operation, reason: parsed.reason },
        }),
      ),
  )

  const client = await getPool().connect()
  let discardConnection = false
  try {
    await client.query('BEGIN')
    const handle = makeQueryableHandle(client)
    let result: T
    try {
      result = await fn(handle.db)
    } finally {
      handle.close()
    }
    await client.query('COMMIT')
    return result
  } catch (error) {
    discardConnection = !(await tryRollback(client, 'ROLLBACK', error))
    throw error
  } finally {
    client.release(discardConnection)
  }
}
