/**
 * Instalacion del esquema de la cola.
 *
 * POR QUE ESTO EXISTE COMO PASO APARTE
 *
 * pg-boss crea su propio esquema y sus tablas la primera vez que arranca. Bajo
 * el modelo de minimo privilegio de este proyecto eso no puede pasar en tiempo
 * de ejecucion: `app_runtime` no tiene CREATE sobre la base (la migracion 0001
 * se lo revoca a proposito), asi que `PgBossQueue.start()` moria con
 * `permission denied for database`. El esquema lo instala `app_migrator`, una
 * vez, igual que las migraciones del dominio, y despues se le conceden a
 * `app_runtime` los permisos justos para operarlo.
 *
 * QUE SE LE CONCEDE A app_runtime, Y QUE NO
 *
 * Se le concede USAGE y **CREATE sobre el esquema `queue` y solo ahi**, porque
 * pg-boss crea una particion por cola la primera vez que se usa, y eso ocurre
 * en tiempo de ejecucion. NO se le concede CREATE sobre la base ni sobre
 * `public`: las tablas de dominio protegidas por RLS siguen fuera de su
 * alcance, que es la garantia que importa.
 *
 * El coste de esta concesion es acotado: para funcionar, `app_runtime` ya
 * necesita SELECT sobre las tablas de la cola, donde viajan payloads de todos
 * los tenants. Poder crear particiones en ese mismo esquema no amplia el radio.
 * Lo que si conviene recordar es que **las tablas de pg-boss no llevan RLS**:
 * el aislamiento entre tenants dentro de un job lo da el envelope y
 * `runWithTenant`, no la base de datos.
 */
import { PgBoss } from 'pg-boss'

import { DEFAULT_QUEUE_SCHEMA } from './pg-boss-queue.js'

/** Rol de aplicacion por defecto, el que crea la migracion 0001 de @coord/db. */
export const DEFAULT_RUNTIME_ROLE = 'app_runtime'

/**
 * Identificadores SQL seguros. Un nombre de rol o de esquema no se puede pasar
 * como parametro ($1) a Postgres, hay que interpolarlo, asi que se valida
 * antes: cualquier cosa que no sea un identificador simple se rechaza en vez de
 * escaparse a medias.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeIdentifier(value: string, what: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${what} no es un identificador SQL simple: ${JSON.stringify(value)}. ` +
        'Se admiten letras, digitos y guion bajo, empezando por letra o guion bajo.',
    )
  }
  return value
}

export interface InstallQueueSchemaOptions {
  /**
   * Conexion con permisos de DDL. Es `DATABASE_MIGRATION_URL` (app_migrator),
   * NUNCA `DATABASE_URL`. Va directa a Postgres, no a PgBouncer.
   */
  connectionString: string
  /** Esquema de pg-boss. Por defecto `queue`. */
  schema?: string
  /** Rol de la aplicacion al que se le conceden los permisos de operacion. */
  runtimeRole?: string
}

export interface InstallQueueSchemaResult {
  schema: string
  runtimeRole: string
}

/**
 * Instala (o migra) el esquema de la cola y concede a `runtimeRole` los
 * permisos minimos para operarlo. Idempotente: se puede correr en cada
 * despliegue.
 */
export async function installQueueSchema(
  options: InstallQueueSchemaOptions,
): Promise<InstallQueueSchemaResult> {
  const schema = assertSafeIdentifier(options.schema ?? DEFAULT_QUEUE_SCHEMA, 'El esquema')
  const runtimeRole = assertSafeIdentifier(
    options.runtimeRole ?? DEFAULT_RUNTIME_ROLE,
    'El rol de runtime',
  )

  const boss = new PgBoss({
    connectionString: options.connectionString,
    schema,
    // Nada de supervisor ni de planificador: esto instala y se va. Arrancarlos
    // dejaria trabajo de mantenimiento corriendo en un proceso efimero.
    supervise: false,
    schedule: false,
  })

  // No se distingue "instalado ahora" de "ya estaba": `isInstalled()` exige la
  // conexion abierta, y quien la abre es `start()`, que para entonces ya lo ha
  // creado. Afirmar cual de los dos casos fue seria inventarlo, y la operacion
  // es idempotente, asi que la distincion no aporta nada.
  //
  // `start()` es lo que crea el esquema si no existe, o lo migra si esta en una
  // version anterior. Corre como app_migrator, que si tiene CREATE.
  await boss.start()
  try {
    const db = boss.getDb()
    // Los identificadores ya estan validados arriba; se citan igualmente.
    const s = `"${schema}"`
    const r = `"${runtimeRole}"`
    await db.executeSql(`
      GRANT USAGE, CREATE ON SCHEMA ${s} TO ${r};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${r};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ${r};
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ${r};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${s}
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${r};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${s}
        GRANT USAGE, SELECT ON SEQUENCES TO ${r};
      ALTER DEFAULT PRIVILEGES IN SCHEMA ${s}
        GRANT EXECUTE ON FUNCTIONS TO ${r};
    `)
  } finally {
    // Se cierra pase lo que pase; si los GRANT fallan, el error se propaga.
    await boss.stop({ graceful: true, close: true })
  }

  return { schema, runtimeRole }
}

/** Entrada de linea de comandos: `tsx src/install.ts`. */
async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_MIGRATION_URL']
  if (connectionString === undefined || connectionString.trim() === '') {
    throw new Error(
      'Falta DATABASE_MIGRATION_URL. La instalacion del esquema de la cola necesita ' +
        'el rol de migraciones (app_migrator); no cae al de runtime a proposito. Ver .env.example.',
    )
  }

  const schema = process.env['QUEUE_SCHEMA']
  const runtimeRole = process.env['DATABASE_RUNTIME_ROLE']
  const result = await installQueueSchema({
    connectionString,
    ...(schema === undefined ? {} : { schema }),
    ...(runtimeRole === undefined ? {} : { runtimeRole }),
  })

  console.log(
    `Esquema "${result.schema}" instalado o actualizado; ` +
      `permisos de operacion concedidos a "${result.runtimeRole}".`,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main().catch((error: unknown) => {
    console.error('No se pudo instalar el esquema de la cola:', error)
    process.exitCode = 1
  })
}
