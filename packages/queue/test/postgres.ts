import {
  createTestDatabase,
  sweepOrphanTestDatabases,
  type TestDatabase,
} from '../../db/test/support/postgres-server.js'

/**
 * Postgres DE VERDAD para los tests de integracion. Nada de dobles: lo que se
 * comprueba (exactly-once bajo concurrencia, backoff, cola de fallidos) es
 * comportamiento del motor y de pg-boss, no de nuestro codigo, asi que un mock
 * solo demostraria que el mock hace lo que le hemos dicho (CLAUDE.md 5).
 *
 * ===========================================================================
 * DE DONDE SALE EL SERVIDOR, Y POR QUE NO LO LEVANTA ESTE FICHERO
 * ===========================================================================
 * La politica esta en `packages/db/test/support/postgres-server.ts` y la fija
 * el ADR 0007: `TEST_DATABASE_URL` si esta definida, un contenedor por proceso
 * si no, y un fallo ruidoso si estamos bajo Stryker sin servidor externo.
 *
 * Antes cada fichero de este paquete levantaba SU contenedor en `beforeAll`.
 * Bajo mutation testing eso salia a un contenedor por MUTANTE —medidos 28
 * Postgres vivos a la vez— y la puntuacion acababa saliendo de los timeouts en
 * vez de los tests (issue #26).
 *
 * VIVE EN packages/db A PROPOSITO: la fitness function `pg-solo-en-db` reserva
 * el driver `pg` a ese paquete, y con un servidor externo ya no vale el truco
 * de ejecutar `psql` dentro del contenedor. Este paquete NO adquiere acceso
 * directo a Postgres: importa un helper de test del paquete que si lo tiene,
 * igual que ya hace `packages/agents`.
 */

export type { TestDatabase }
export { sweepOrphanTestDatabases }

/**
 * Una base de datos aislada para un fichero de test.
 *
 * El aislamiento que estos tests necesitan es el de DATOS, no el de proceso:
 * `install.test.ts` exige una base SIN el esquema `queue` y `pg-boss-queue.test.ts`
 * lo crea. Una base por fichero da eso; compartir el servidor no lo rompe.
 */
export async function startTestDatabase(label: string): Promise<TestDatabase> {
  return createTestDatabase(label)
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
