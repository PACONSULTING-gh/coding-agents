import { ValidationError } from '@coord/core'
import { Pool } from 'pg'

/**
 * Pool de conexiones de `pg`, configurado para hablar con PgBouncer EN MODO
 * TRANSACCION (CLAUDE.md 3: "Pool de conexiones: PgBouncer, modo transaccion").
 *
 * ---------------------------------------------------------------------------
 * LA RESTRICCION QUE GOBIERNA TODO ESTE MODULO
 * ---------------------------------------------------------------------------
 * En modo transaccion PgBouncer multiplexa: una conexion logica de cliente NO
 * esta atada a una sesion fisica de Postgres. Dos consultas consecutivas del
 * mismo `pg.Client` pueden acabar en backends distintos. De ahi salen tres
 * prohibiciones que no son estilisticas, son de correccion:
 *
 *   1. NADA DE ESTADO DE SESION. Ni `SET` a nivel de sesion, ni `LISTEN`, ni
 *      tablas temporales, ni cursores WITH HOLD, ni advisory locks de sesion.
 *      Lo que se fije en una consulta puede no existir en la siguiente, o
 *      peor: puede quedarse pegado en un backend que despues reutiliza OTRO
 *      tenant. Por eso el contexto de tenant se fija con
 *      `set_config(..., true)` dentro de una transaccion (ver client.ts).
 *
 *   2. NADA DE PREPARED STATEMENTS CON NOMBRE. Un `PREPARE` vive en la sesion
 *      fisica; si la siguiente ejecucion cae en otro backend, falla con
 *      "prepared statement does not exist". `pg` solo usa el protocolo
 *      extendido con nombre cuando se le pasa `name` en el objeto de consulta,
 *      cosa que este paquete no hace nunca: `TenantQuery.query()` solo acepta
 *      `(text, values)`, asi que la prohibicion esta en el TIPO, no en la
 *      buena voluntad de quien llama.
 *
 *   3. NADA DE PARAMETROS DE ARRANQUE RAROS. PgBouncer rechaza los parametros
 *      del startup packet que no esten en `ignore_startup_parameters`. Por eso
 *      aqui NO se usan `statement_timeout`, `lock_timeout`, `options` ni
 *      `idle_in_transaction_session_timeout` de `pg`: se configuran en el
 *      servidor o por transaccion con `SET LOCAL`. `application_name` si se
 *      envia porque es un parametro estandar que PgBouncer entiende, y hace
 *      legible `pg_stat_activity`.
 *
 * El Pool crudo NO se exporta desde `index.ts`. La unica via de consulta que
 * este paquete ofrece hacia fuera es `withTenantConnection` (client.ts), que
 * garantiza que toda consulta corre con el tenant fijado.
 */

/** Numero de conexiones de CLIENTE (hacia PgBouncer), no de backends de Postgres. */
export const DEFAULT_POOL_MAX = 10

export interface DatabaseConfig {
  /**
   * Cadena de conexion. Debe apuntar a PgBouncer (puerto 6432), no a Postgres
   * directamente: ver `resolveRuntimeConnectionString`.
   */
  connectionString: string
  /**
   * Maximo de conexiones de cliente. Puede ser generoso: quien limita las
   * conexiones REALES a Postgres es `default_pool_size` de PgBouncer.
   */
  max?: number
  min?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
  /** Aparece en `pg_stat_activity`; muy util para saber quien satura el pool. */
  applicationName?: string
  /** Deja que el proceso termine con el pool ocioso (util en scripts y tests). */
  allowExitOnIdle?: boolean
}

export interface PoolStats {
  /** Clientes creados por el pool (ocupados + ociosos). */
  total: number
  idle: number
  /** Peticiones esperando un cliente libre. Si crece de forma sostenida, el pool es pequeno. */
  waiting: number
}

let config: DatabaseConfig | undefined
let pool: Pool | undefined

/**
 * Fija la configuracion del pool. Debe llamarse ANTES del primer acceso a
 * datos; si ya hay un pool abierto se rechaza en vez de reconfigurar en
 * caliente, porque eso dejaria conexiones vivas contra el destino anterior.
 * Para cambiar de destino: `await closeDatabase()` y volver a configurar.
 */
export function configureDatabase(next: DatabaseConfig): void {
  if (pool !== undefined) {
    throw new Error(
      'Ya hay un pool de base de datos abierto. Llama a closeDatabase() antes de reconfigurar.',
    )
  }
  if (next.connectionString.trim() === '') {
    throw new ValidationError('configureDatabase requiere una connectionString no vacia.')
  }
  config = next
}

/**
 * UNA sola convencion sobre a donde se conecta la capa de datos, en un solo
 * sitio. Antes estaba repartida y se contradecia: este modulo decia que
 * `DATABASE_URL` apunta a PgBouncer, `.env.example` la definia contra el 5432
 * (Postgres directo) y cada app componia por su cuenta
 * `PGBOUNCER_URL ?? DATABASE_URL`. Con esos valores, olvidar `PGBOUNCER_URL`
 * conectaba directamente a Postgres, sin pooler y sin un solo mensaje: se
 * perdia la garantia del primer criterio de T03 en silencio.
 *
 * La convencion es:
 *   - `PGBOUNCER_URL`  -> PgBouncer en modo transaccion. Es el destino correcto.
 *   - `DATABASE_URL`   -> Postgres DIRECTO. Es de pg-boss y de las migraciones.
 *
 * Si falta `PGBOUNCER_URL` se cae a `DATABASE_URL` para no romper el desarrollo
 * local, pero AVISANDO: saltarse el pooler nunca puede pasar inadvertido.
 */
export function resolveRuntimeConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const pooled = env['PGBOUNCER_URL']
  if (pooled !== undefined && pooled.trim() !== '') {
    return pooled
  }

  const direct = env['DATABASE_URL']
  if (direct === undefined || direct.trim() === '') {
    throw new Error(
      'Falta PGBOUNCER_URL y DATABASE_URL: la capa de datos no sabe a donde conectarse. ' +
        'PGBOUNCER_URL apunta a PgBouncer en modo transaccion (6432) y es el destino correcto ' +
        'para el acceso a datos; DATABASE_URL apunta a Postgres directo (5432). Ver .env.example.',
    )
  }

  console.warn(
    '[@coord/db] PGBOUNCER_URL no esta definida: la capa de datos se conecta DIRECTAMENTE a ' +
      'Postgres (DATABASE_URL), sin pooler. En produccion esto es un error de despliegue: ' +
      'el limite de conexiones de Postgres es la primera pared que se toca (CLAUDE.md 3).',
  )
  return direct
}

function resolveConfig(): DatabaseConfig {
  if (config !== undefined) return config
  return { connectionString: resolveRuntimeConnectionString() }
}

/**
 * Pool perezoso. NO se exporta desde `index.ts`: es interno del paquete para
 * que nadie pueda saltarse `withTenantConnection` y consultar sin tenant.
 */
export function getPool(): Pool {
  if (pool !== undefined) return pool

  const resolved = resolveConfig()
  const created = new Pool({
    connectionString: resolved.connectionString,
    max: resolved.max ?? DEFAULT_POOL_MAX,
    // TCP keepalive: con PgBouncer u otro intermediario delante, una conexion
    // ociosa que muere sin FIN se detecta aqui en vez de en la consulta.
    keepAlive: true,
    ...(resolved.min !== undefined ? { min: resolved.min } : {}),
    ...(resolved.idleTimeoutMillis !== undefined
      ? { idleTimeoutMillis: resolved.idleTimeoutMillis }
      : {}),
    ...(resolved.connectionTimeoutMillis !== undefined
      ? { connectionTimeoutMillis: resolved.connectionTimeoutMillis }
      : {}),
    ...(resolved.applicationName !== undefined
      ? { application_name: resolved.applicationName }
      : {}),
    ...(resolved.allowExitOnIdle !== undefined
      ? { allowExitOnIdle: resolved.allowExitOnIdle }
      : {}),
  })

  // `pg` emite 'error' en clientes OCIOSOS (los que ya no estan en ninguna
  // consulta). Sin listener, Node convierte ese evento en una excepcion no
  // capturada y tumba el proceso. No se traga: se reporta y el pool descarta
  // el cliente por su cuenta. No hay a quien propagarlo, porque no hay ninguna
  // llamada en curso a la que corresponda.
  created.on('error', (error: Error) => {
    console.error('[@coord/db] error en un cliente ocioso del pool:', error)
  })

  pool = created
  return created
}

/** Estado del pool sin exponer el objeto Pool. Para metricas y para tests. */
export function getPoolStats(): PoolStats {
  if (pool === undefined) return { total: 0, idle: 0, waiting: 0 }
  return { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
}

/**
 * Comprobacion de vida de la base de datos para los endpoints de salud.
 *
 * Ejecuta `SELECT 1`: no toca ninguna tabla, asi que no necesita —ni podria
 * aprovechar— contexto de tenant, y no hay ninguna fila que la RLS tenga que
 * proteger. Sirve para lo unico que dice servir: confirmar que hay una conexion
 * viva contra Postgres.
 *
 * Los errores se propagan tal cual. Un health check que se traga el fallo y
 * responde "ok" es peor que no tener health check.
 */
export async function pingDatabase(): Promise<void> {
  const client = await getPool().connect()
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}

/**
 * Cierra el pool y espera a que terminen las conexiones en curso. Idempotente.
 * Los errores de cierre se propagan: un cierre que falla es informacion, no
 * ruido que tapar.
 */
export async function closeDatabase(): Promise<void> {
  const current = pool
  pool = undefined
  if (current !== undefined) {
    await current.end()
  }
}
