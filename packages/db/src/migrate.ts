import { fileURLToPath, pathToFileURL } from 'node:url'

import { runner } from 'node-pg-migrate'

/**
 * Directorio de migraciones, resuelto respecto a ESTE modulo y no respecto al
 * cwd: `node-pg-migrate` resuelve `dir` desde `process.cwd()`, asi que confiar
 * en el cwd haria que el runner funcionase o no segun desde donde se invoque.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url))

/**
 * La tabla de control vive en su propio schema, fuera de `public`. Asi `public`
 * contiene EXCLUSIVAMENTE tablas de dominio y se puede exigir, sin excepciones,
 * que todas tengan RLS forzada (ver el test de catalogo en
 * test/tenant-isolation.test.ts). Una excepcion que hay que recordar es una
 * excepcion que algun dia se olvida.
 */
export const MIGRATIONS_SCHEMA = 'migrations'
export const MIGRATIONS_TABLE = 'pgmigrations'

export interface MigrateOptions {
  /** `up` aplica las pendientes; `down` revierte. */
  direction: 'up' | 'down'
  /**
   * Numero de migraciones a aplicar. Por defecto: todas las pendientes hacia
   * arriba, una sola hacia abajo (comportamiento de node-pg-migrate).
   */
  count?: number
  /**
   * Cadena de conexion del usuario de MIGRACIONES. Si se omite se lee de
   * `DATABASE_MIGRATION_URL`. Nunca se cae al usuario de runtime: el rol que
   * aplica DDL y el que sirve peticiones estan separados a proposito.
   */
  databaseUrl?: string
}

/** Nombres de las migraciones efectivamente aplicadas, en orden. */
export async function migrate(options: MigrateOptions): Promise<string[]> {
  const databaseUrl = options.databaseUrl ?? process.env['DATABASE_MIGRATION_URL']
  if (!databaseUrl) {
    throw new Error(
      'Falta DATABASE_MIGRATION_URL: es la cadena de conexion del usuario de migraciones ' +
        '(app_migrator), distinta de DATABASE_URL. Ver .env.example y packages/db/README.md.',
    )
  }

  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    schema: 'public',
    migrationsSchema: MIGRATIONS_SCHEMA,
    createMigrationsSchema: true,
    migrationsTable: MIGRATIONS_TABLE,
    direction: options.direction,
    // Todas las migraciones pendientes en una sola transaccion: si una falla,
    // la base de datos no se queda a medio migrar.
    singleTransaction: true,
    checkOrder: true,
    ...(options.count !== undefined ? { count: options.count } : {}),
  })

  return applied.map((migration) => migration.name)
}

/**
 * Entrada de linea de comandos: `tsx src/migrate.ts up [--count=N]`.
 * Los errores no se tragan: se imprimen enteros y el proceso sale con codigo 1.
 */
async function main(argv: readonly string[]): Promise<void> {
  const direction = argv[0]
  if (direction !== 'up' && direction !== 'down') {
    throw new Error(`Uso: migrate <up|down> [--count=N]. Recibido: ${String(direction)}`)
  }

  const countArg = argv.find((arg) => arg.startsWith('--count='))?.slice('--count='.length)
  const count = countArg === undefined ? undefined : Number.parseInt(countArg, 10)
  if (count !== undefined && !Number.isInteger(count)) {
    throw new Error(`--count debe ser un entero. Recibido: ${countArg ?? ''}`)
  }

  const applied = await migrate({ direction, ...(count !== undefined ? { count } : {}) })
  console.log(
    applied.length === 0
      ? 'Sin migraciones pendientes.'
      : `Aplicadas (${direction}): ${applied.join(', ')}`,
  )
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
