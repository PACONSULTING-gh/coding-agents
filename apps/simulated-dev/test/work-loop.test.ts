import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import {
  decideNextAction,
  DEFAULT_RENEW_MARGIN_MS,
  type HeldClaim,
  type WorkLoopInput,
} from '../src/work-loop.js'

/**
 * La politica del desarrollador simulado (ADR 0010).
 *
 * Lo que se fija aqui es el ORDEN DE PRIORIDAD, que es toda la politica. Y en
 * particular los dos casos donde equivocarse no da ningun error: seguir
 * escribiendo con el arriendo caducado, y seguir con un issue que ya es de
 * otro. Las dos cosas terminan en un push que funciona y en una colision que se
 * descubre en el merge.
 */

const AHORA = new Date('2026-09-12T10:00:00Z')

function dentroDe(ms: number): Date {
  return new Date(AHORA.getTime() + ms)
}

/** Un arriendo con mucho margen: no dispara renovacion. */
function arriendo(taskRef: string, overrides: Partial<HeldClaim> = {}): HeldClaim {
  return {
    claimId: `claim-${taskRef}`,
    taskRef,
    expiresAt: dentroDe(DEFAULT_RENEW_MARGIN_MS * 10),
    ...overrides,
  }
}

function entrada(overrides: Partial<WorkLoopInput> = {}): WorkLoopInput {
  return { assigned: [], held: [], now: AHORA, ...overrides }
}

describe('lo primero de todo: no escribir sin arriendo', () => {
  it('un arriendo caducado se ABANDONA, no se suelta ni se renueva', () => {
    // `abandon` y `release` no son lo mismo y la diferencia importa: soltar es
    // terminar limpiamente, abandonar es PARAR SIN EMPUJAR lo que llevabas.
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }],
        held: [arriendo('10', { expiresAt: dentroDe(-1) })],
      }),
    )

    expect(accion.kind).toBe('abandon')
    expect(accion.reason).toContain('sin empujar')
  })

  it('caducar justo AHORA ya es caducado', () => {
    // El borde importa: `expiresAt > now()` es lo que usa el motor para decir
    // que un claim esta vivo. Con `<` aqui, habria un instante en el que este
    // dev se cree con arriendo y la base de datos dice que no.
    const accion = decideNextAction(
      entrada({ assigned: [{ taskRef: '10' }], held: [arriendo('10', { expiresAt: AHORA })] }),
    )

    expect(accion.kind).toBe('abandon')
  })

  it('abandonar gana a todo lo demas', () => {
    // Aunque haya otro issue por reclamar y otro arriendo por renovar.
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }, { taskRef: '20' }, { taskRef: '30' }],
        held: [
          arriendo('20', { expiresAt: dentroDe(1_000) }),
          arriendo('30', { expiresAt: dentroDe(-5_000) }),
        ],
      }),
    )

    expect(accion).toMatchObject({ kind: 'abandon', taskRef: '30' })
  })
})

describe('lo que ya no me toca se suelta', () => {
  it('un arriendo sobre un issue que me han reasignado', () => {
    // Un humano reasigno el issue mientras yo trabajaba. Retener el arriendo
    // bloquea a quien lo tiene ahora, y seguir trabajando le pisa el trabajo.
    const accion = decideNextAction(
      entrada({ assigned: [{ taskRef: '10' }], held: [arriendo('99')] }),
    )

    expect(accion).toMatchObject({ kind: 'release', taskRef: '99' })
  })

  it('soltar gana a renovar', () => {
    // Renovar un arriendo que hay que soltar seria alargar el bloqueo.
    const accion = decideNextAction(
      entrada({
        assigned: [],
        held: [arriendo('99', { expiresAt: dentroDe(1_000) })],
      }),
    )

    expect(accion.kind).toBe('release')
  })
})

describe('renovar antes de perderlo', () => {
  it('se renueva dentro del margen, antes de seguir trabajando', () => {
    // Perder el arriendo A MITAD del trabajo obliga a tirar lo hecho: es el
    // caso caro, y por eso renovar va antes que trabajar.
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }],
        held: [arriendo('10', { expiresAt: dentroDe(DEFAULT_RENEW_MARGIN_MS - 1) })],
      }),
    )

    expect(accion).toMatchObject({ kind: 'renew', taskRef: '10' })
  })

  it('justo en el margen ya se renueva', () => {
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }],
        held: [arriendo('10', { expiresAt: dentroDe(DEFAULT_RENEW_MARGIN_MS) })],
      }),
    )

    expect(accion.kind).toBe('renew')
  })

  it('con margen de sobra se trabaja, no se renueva', () => {
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }],
        held: [arriendo('10', { expiresAt: dentroDe(DEFAULT_RENEW_MARGIN_MS + 1) })],
      }),
    )

    expect(accion.kind).toBe('work')
  })
})

describe('coger trabajo nuevo', () => {
  it('un issue asignado sin arriendo se reclama', () => {
    const accion = decideNextAction(entrada({ assigned: [{ taskRef: '10' }] }))
    expect(accion).toMatchObject({ kind: 'claim', taskRef: '10' })
  })

  it('con el tope alcanzado NO se reclama, y el motivo lo dice', () => {
    // Es la palanca de coste del ADR 0010: cinco agentes sobre una suscripcion.
    // Un dev parado con issues delante parece un fallo si no se explica.
    const accion = decideNextAction(
      entrada({ assigned: [{ taskRef: '10' }, { taskRef: '20' }], held: [arriendo('10')] }),
    )

    expect(accion).toMatchObject({ kind: 'work', taskRef: '10' })
    expect(accion.reason).toContain('el tope es 1')
  })

  it('con un tope mayor si se coge el segundo', () => {
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }, { taskRef: '20' }],
        held: [arriendo('10')],
        maxConcurrent: 2,
      }),
    )

    expect(accion).toMatchObject({ kind: 'claim', taskRef: '20' })
  })
})

describe('el orden es estable, no el de llegada', () => {
  it('se reclama siempre el mismo issue, venga como venga la lista', () => {
    // Un banco de pruebas que elige al azar no se puede repetir: la colision
    // que salio el martes no vuelve a salir, y no se puede saber si un cambio
    // la arreglo o simplemente no la toco.
    const desordenado = decideNextAction(
      entrada({ assigned: [{ taskRef: '30' }, { taskRef: '10' }, { taskRef: '20' }] }),
    )
    const ordenado = decideNextAction(
      entrada({ assigned: [{ taskRef: '10' }, { taskRef: '20' }, { taskRef: '30' }] }),
    )

    expect(desordenado).toEqual(ordenado)
    expect(desordenado).toMatchObject({ taskRef: '10' })
  })

  it('y tambien al elegir cual abandonar', () => {
    const a = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }, { taskRef: '20' }],
        held: [
          arriendo('20', { expiresAt: dentroDe(-1) }),
          arriendo('10', { expiresAt: dentroDe(-1) }),
        ],
      }),
    )
    expect(a).toMatchObject({ taskRef: '10' })
  })
})

describe('no hay nada que hacer', () => {
  it('sin issues asignados, se espera', () => {
    const accion = decideNextAction(entrada())
    expect(accion).toEqual({ kind: 'idle', reason: 'No hay ningun issue asignado a este dev.' })
  })
})

describe('configuracion incoherente: se lanza', () => {
  it.each([0, -1, 1.5])('un tope de %s', (maxConcurrent) => {
    // Un tope de cero es un banco parado que parece funcionar.
    expect(() => decideNextAction(entrada({ maxConcurrent }))).toThrow(ValidationError)
  })

  it.each([-1, 1.5])('un margen de renovacion de %s', (renewMarginMs) => {
    expect(() => decideNextAction(entrada({ renewMarginMs }))).toThrow(ValidationError)
  })

  it('un margen de cero es valido: renovar justo al caducar es una politica', () => {
    const accion = decideNextAction(
      entrada({
        assigned: [{ taskRef: '10' }],
        held: [arriendo('10', { expiresAt: dentroDe(1) })],
        renewMarginMs: 0,
      }),
    )
    expect(accion.kind).toBe('work')
  })
})
