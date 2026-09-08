import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'

/**
 * Postgres DE VERDAD para los tests de integracion. Nada de dobles: lo que se
 * comprueba (exactly-once bajo concurrencia, backoff, cola de fallidos) es
 * comportamiento del motor y de pg-boss, no de nuestro codigo, asi que un mock
 * solo demostraria que el mock hace lo que le hemos dicho (CLAUDE.md 5).
 */
export const POSTGRES_IMAGE = 'postgres:16-alpine'

export async function startPostgres(): Promise<StartedPostgreSqlContainer> {
  return await new PostgreSqlContainer(POSTGRES_IMAGE).start()
}

/**
 * Ejecuta SQL con el `psql` que ya viene en la imagen, en vez de abrir un
 * cliente `pg` desde el test.
 *
 * Motivo arquitectonico, no de comodidad: la fitness function de
 * dependency-cruiser reserva el driver `pg` a packages/db (regla
 * `pg-solo-en-db`). Este paquete no debe adquirir acceso directo a Postgres ni
 * siquiera en sus tests.
 */
export async function sql(container: StartedPostgreSqlContainer, text: string): Promise<string[]> {
  const result = await container.exec(
    [
      'psql',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      container.getUsername(),
      '-d',
      container.getDatabase(),
      '-tA',
      '-c',
      text,
    ],
    { env: { PGPASSWORD: container.getPassword() } },
  )
  if (result.exitCode !== 0) {
    throw new Error(
      `psql termino con codigo ${result.exitCode}: ${result.stderr || result.output}\nSQL: ${text}`,
    )
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Primera celda del resultado, o `undefined` si no hubo filas. */
export async function sqlValue(
  container: StartedPostgreSqlContainer,
  text: string,
): Promise<string | undefined> {
  return (await sql(container, text)).at(0)
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Espera activa hasta que `condition` se cumpla. Falla con un mensaje util en
 * vez de dejar que el test muera por timeout sin explicacion.
 */
export async function waitFor(
  description: string,
  condition: () => Promise<boolean>,
  timeoutMs = 30_000,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) {
      return
    }
    await delay(intervalMs)
  }
  throw new Error(`Se agoto la espera de: ${description}`)
}
