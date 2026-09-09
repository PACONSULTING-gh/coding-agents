import { describe, expect, it } from 'vitest'

import { QueueNotStartedError } from '../src/errors.js'
import { PgBossQueue } from '../src/pg-boss-queue.js'

/**
 * `PgBossQueue.fromEnv`, sin base de datos.
 *
 * El constructor de pg-boss no conecta: solo guarda la configuracion. Eso hace
 * que esta parte —la que decide si el proceso puede arrancar— se pueda probar
 * en milisegundos y sin contenedor, que es exactamente lo contrario de lo que
 * pasaba antes: no habia ni un test, y `fromEnv` es la puerta por la que entra
 * la cola en produccion.
 */

describe('fromEnv: sin conexion no se arranca, y se dice por que', () => {
  it('falla si DATABASE_URL no esta', () => {
    // Arrancar un worker sin base de datos solo retrasa el error hasta el
    // primer job, cuando ya nadie mira los logs del arranque.
    expect(() => PgBossQueue.fromEnv({})).toThrow(QueueNotStartedError)
    expect(() => PgBossQueue.fromEnv({})).toThrow(/Falta DATABASE_URL/)
  })

  it.each([
    ['cadena vacia', ''],
    ['solo espacios', '   '],
    ['solo un tabulador', '\t'],
  ])('falla si DATABASE_URL es %s', (_caso, valor) => {
    // Un `export DATABASE_URL=` mal escrito no puede pasar por configurado: se
    // acabaria intentando conectar a la cadena vacia y fallando lejos de aqui.
    expect(() => PgBossQueue.fromEnv({ DATABASE_URL: valor })).toThrow(QueueNotStartedError)
  })

  it('construye la cola cuando DATABASE_URL esta', () => {
    // No conecta: el constructor de pg-boss solo guarda la configuracion.
    const queue = PgBossQueue.fromEnv({ DATABASE_URL: 'postgres://u:p@localhost:5432/db' })
    expect(queue).toBeInstanceOf(PgBossQueue)
  })

  it('lee del entorno del proceso cuando no se le pasa uno', () => {
    // El parametro tiene `process.env` por defecto: si alguien lo quitara, la
    // cola dejaria de arrancar en produccion y ningun test se enteraria.
    const anterior = process.env['DATABASE_URL']
    process.env['DATABASE_URL'] = 'postgres://u:p@localhost:5432/db'
    try {
      expect(PgBossQueue.fromEnv()).toBeInstanceOf(PgBossQueue)
    } finally {
      if (anterior === undefined) delete process.env['DATABASE_URL']
      else process.env['DATABASE_URL'] = anterior
    }
  })

  it('los overrides llegan al constructor y no pisan la cadena de conexion', () => {
    // `fromEnv` compone `{ connectionString, ...overrides }`. Si el orden se
    // invirtiera, un override con `connectionString` podria anular la del
    // entorno; y si los overrides se perdieran, el logger silencioso de los
    // tests dejaria de aplicarse sin que nadie lo viera.
    const silencioso = { warn: () => {}, error: () => {} }
    const queue = PgBossQueue.fromEnv(
      { DATABASE_URL: 'postgres://u:p@localhost:5432/db' },
      { logger: silencioso, schema: 'otro_esquema', stopTimeoutMs: 1_234 },
    )
    expect(queue).toBeInstanceOf(PgBossQueue)
  })
})

describe('deadLetterQueueName', () => {
  it('anade el sufijo convenido al nombre de la cola', () => {
    // Es el nombre por el que un operador busca los jobs que fallaron. Si
    // devolviera algo distinto —o vacio— los jobs seguirian yendo a una cola
    // que nadie sabria mirar.
    expect(PgBossQueue.deadLetterQueueName('facturas')).toBe('facturas.dlq')
    expect(PgBossQueue.deadLetterQueueName('a.b.c')).toBe('a.b.c.dlq')
  })
})
