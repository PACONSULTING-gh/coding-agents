import { describe, expect, it } from 'vitest'

import { decidePostgresAcquisition, TEST_DATABASE_URL_ENV } from './support/postgres-server.js'

/**
 * La politica del ADR 0007, probada sin levantar nada.
 *
 * Es la unica parte del helper que se puede probar en aislamiento, y es donde
 * esta la regla que impide que el gate de mutation vuelva a medir en falso.
 */

const STRYKER = { __stryker__: {} }
const NORMAL = {}

describe('de donde sale el Postgres de los tests (ADR 0007)', () => {
  it('con TEST_DATABASE_URL definida, se usa ese servidor', () => {
    const decision = decidePostgresAcquisition(
      { [TEST_DATABASE_URL_ENV]: 'postgres://u:p@host:5432/db' },
      NORMAL,
    )
    expect(decision).toEqual({ kind: 'external', url: 'postgres://u:p@host:5432/db' })
  })

  it('sin ella, se levanta un contenedor: `pnpm test` no exige arrancar nada', () => {
    // Es lo que evita el precio que pagaba la primera version del ADR.
    expect(decidePostgresAcquisition({}, NORMAL)).toEqual({ kind: 'container' })
  })

  it('una variable vacia o en blanco NO cuenta como servidor', () => {
    // Un `export TEST_DATABASE_URL=` mal escrito no debe pasar por configurado:
    // acabaria intentando conectar a la cadena vacia y fallando lejos de aqui.
    expect(decidePostgresAcquisition({ [TEST_DATABASE_URL_ENV]: '' }, NORMAL).kind).toBe(
      'container',
    )
    expect(decidePostgresAcquisition({ [TEST_DATABASE_URL_ENV]: '   ' }, NORMAL).kind).toBe(
      'container',
    )
  })

  it('bajo Stryker y sin servidor externo, SE NIEGA a medir', () => {
    // Esta es la linea que sostiene el ADR entero. Un contenedor por mutante
    // hace que la puntuacion salga de los timeouts: client.ts marcaba 90,34 con
    // CERO mutantes muertos. Degradar aqui en silencio seria repetir el fallo.
    const decision = decidePostgresAcquisition({}, STRYKER)

    expect(decision.kind).toBe('refuse')
    // Y el motivo tiene que traer el comando: un gate que se niega sin decir
    // como arreglarlo acaba desactivado.
    if (decision.kind !== 'refuse') throw new Error('inalcanzable')
    expect(decision.reason).toContain('docker compose')
    expect(decision.reason).toContain(TEST_DATABASE_URL_ENV)
    expect(decision.reason).toContain('issue #26')
  })

  it('bajo Stryker CON servidor externo, mide con normalidad', () => {
    expect(
      decidePostgresAcquisition({ [TEST_DATABASE_URL_ENV]: 'postgres://x/y' }, STRYKER).kind,
    ).toBe('external')
  })

  it('la deteccion es por el global que inyecta Stryker, no por una heuristica', () => {
    // Si esto se hiciera mirando variables de entorno con "stryker" dentro,
    // cualquier renombrado del runner lo desactivaria sin avisar.
    expect(decidePostgresAcquisition({}, { STRYKER_MUTATOR: '1' }).kind).toBe('container')
    expect(decidePostgresAcquisition({}, { __stryker__: undefined }).kind).toBe('refuse')
  })
})
