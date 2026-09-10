import {
  bootstrapSchema,
  POSTGRES_IMAGE as SHARED_POSTGRES_IMAGE,
} from '../../../db/test/support/database.js'
import {
  createTestDatabase,
  sharedPostgresServer,
  type TestDatabase,
} from '../../../db/test/support/postgres-server.js'

/**
 * Postgres DE VERDAD para los tests del grafo, con la MISMA separacion de roles
 * que el despliegue real. Nada mockeado (CLAUDE.md 5): lo que se comprueba aqui
 * —que la RLS forzada aisla el grafo, que la CTE recursiva termina en un grafo
 * ciclico y que la consulta de dependencias inversas baja de 200 ms en p95— es
 * comportamiento del motor. Un doble solo demostraria que el doble hace lo que
 * le hemos dicho.
 *
 * ===========================================================================
 * UNA BASE DE DATOS POR FICHERO, NO UN CONTENEDOR (ADR 0007, issue #26)
 * ===========================================================================
 * Hasta ahora cada uno de los 13 ficheros de test de este paquete levantaba su
 * propio contenedor. Bajo mutation testing eso salia a UN CONTENEDOR POR
 * MUTANTE, y la consecuencia no era solo lentitud: medido sobre
 * `parse/python.ts` daban 0 mutantes muertos, 229 timeouts y una puntuacion de
 * 78,69 que superaba el umbral SIN QUE NINGUN TEST HUBIERA MATADO NADA. Un
 * gate que se supera por timeouts es peor que no medir, porque parece que mide.
 *
 * Ahora se comparte el servidor del proceso y cada fichero crea SU base de
 * datos dentro. El aislamiento entre ficheros sigue siendo total —son bases
 * distintas— y el coste de arranque pasa de N contenedores a uno.
 *
 * ===========================================================================
 * POR QUE SE REUSA EL SOPORTE DE packages/db
 * ===========================================================================
 * Porque el bootstrap de roles es delicado —advisory lock incluido, porque los
 * roles son objetos de CLUSTER y varios ficheros a la vez chocan con `tuple
 * concurrently updated`— y tenerlo en dos sitios significa que el dia que
 * cambie habra que acordarse de los dos.
 *
 * La fitness function `pg-solo-en-db` sigue cumpliendose: este fichero no
 * importa `pg`. El driver vive donde debe, en packages/db, y aqui se usa a
 * traves de su soporte de test.
 *
 * ===========================================================================
 * POR QUE HACEN FALTA DOS ROLES
 * ===========================================================================
 * `app_migrator` es el DUENO de las tablas y `app_runtime` el que consulta. Si
 * los tests se conectaran como el superusuario, se saltarian la RLS por
 * atributo de rol y el test de aislamiento entre tenants pasaria por
 * casualidad, sin comprobar nada.
 */

export const POSTGRES_IMAGE = SHARED_POSTGRES_IMAGE

export interface StartedDatabase {
  /** Conexion del rol de la aplicacion: la que usa `configureDatabase`. */
  readonly runtimeUrl: string
  /** Conexion del rol de migraciones (dueno del esquema). */
  readonly migratorUrl: string
  /**
   * SQL como superusuario sobre la base de este fichero.
   *
   * Solo para lo que la capa de acceso no puede hacer: hoy, un `ANALYZE` en el
   * test de rendimiento, que exige ser dueno de la tabla. NUNCA para comprobar
   * aislamiento — el superusuario se salta la RLS, asi que cualquier assert de
   * aislamiento hecho por aqui seria falso.
   */
  sql(text: string, values?: readonly unknown[]): Promise<Record<string, unknown>[]>
  /** Borra la base de datos de este fichero. Antes esto paraba un contenedor. */
  stop(): Promise<void>
}

export async function startDatabase(): Promise<StartedDatabase> {
  const server = await sharedPostgresServer()
  const test: TestDatabase = await createTestDatabase('graph')
  const { migratorUrl, runtimeUrl } = await bootstrapSchema(
    test.url,
    test.adminUrl,
    server.adminUrl,
  )

  return {
    runtimeUrl,
    migratorUrl,
    sql: (text, values) => test.sql(text, values),
    stop: () => test.drop(),
  }
}
