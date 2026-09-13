import { describe, expect, it } from 'vitest'

import { ValidationError } from './errors.js'
import { buildTeamStatus, type TeamMemberStatus } from './team-status.js'

/**
 * La vista de "quien hace que y como va" (epic 04 / T05).
 *
 * Lo que se fija aqui es la distincion que justifica que esta vista exista:
 * LATIR NO ES PROGRESAR. Y el criterio de aceptacion que mas facil es
 * incumplir sin darse cuenta: un portatil dormido tiene que distinguirse de un
 * agente caido.
 */

const AHORA = new Date('2026-09-13T12:00:00Z')

function haceMs(ms: number): Date {
  return new Date(AHORA.getTime() - ms)
}

function miembro(overrides: Partial<TeamMemberStatus> = {}): TeamMemberStatus {
  return { label: 'Ana', lastBeatAt: haceMs(1_000), ...overrides }
}

describe('un portatil dormido NO es un agente caido', () => {
  it('se distinguen con palabras distintas, no con matices de color', () => {
    // Tercer criterio de aceptacion de T05. Quien lea esto por CLI en blanco y
    // negro, o con un lector de pantalla, tiene que poder distinguirlos igual.
    const dormido = buildTeamStatus([miembro({ lastBeatAt: haceMs(300_000) })], AHORA)
    const caido = buildTeamStatus([miembro({ lastBeatAt: haceMs(3_600_000) })], AHORA)

    expect(dormido.lines[0]?.liveness).toBe('stale')
    expect(caido.lines[0]?.liveness).toBe('missing')
    expect(dormido.text).toContain('dormido')
    expect(caido.text).toContain('sin señal')
    expect(dormido.text).not.toContain('sin señal')
  })

  it('un agente que nunca ha latido tampoco se confunde con uno caido', () => {
    const nuevo = buildTeamStatus([{ label: 'Recién' }], AHORA)
    expect(nuevo.lines[0]?.liveness).toBe('never')
    expect(nuevo.text).toContain('sin estrenar')
  })

  it('un agente retirado sale marcado, no desaparecido', () => {
    const retirado = buildTeamStatus([miembro({ revoked: true })], AHORA)
    expect(retirado.lines[0]?.liveness).toBe('revoked')
  })
})

describe('latir no es progresar', () => {
  it('un agente que late y no toca nada sale con su parada a la vista', () => {
    // Es el caso que hace util esta vista: la maquina esta perfectamente y el
    // trabajo lleva dos horas parado. Si solo se enseñara el latido, saldria en
    // verde.
    const informe = buildTeamStatus(
      [miembro({ lastBeatAt: haceMs(1_000), lastProgressAt: haceMs(7_200_000) })],
      AHORA,
    )

    expect(informe.lines[0]?.liveness).toBe('fresh')
    expect(informe.lines[0]?.sinceProgressMs).toBe(7_200_000)
    expect(informe.text).toContain('hace 2 h')
  })

  it('quien no ha tocado nada todavia lo dice, y no finge un progreso de cero', () => {
    const informe = buildTeamStatus([miembro()], AHORA)
    expect(informe.lines[0]?.sinceProgressMs).toBeUndefined()
    expect(informe.text).toContain('sin tocar nada todavía')
  })

  it('un progreso del futuro no produce un tiempo negativo', () => {
    // Mismo reloj descuadrado que en los latidos. Un "hace -5 min" en la vista
    // es ruido que nadie sabe interpretar.
    const informe = buildTeamStatus(
      [miembro({ lastProgressAt: new Date(AHORA.getTime() + 60_000) })],
      AHORA,
    )
    expect(informe.lines[0]?.sinceProgressMs).toBe(0)
  })
})

describe('quien hay que mirar', () => {
  it('atascado y escalado, si', () => {
    const informe = buildTeamStatus(
      [
        miembro({ label: 'Ana', activity: 'stuck' }),
        miembro({ label: 'Bruno', activity: 'escalate' }),
      ],
      AHORA,
    )
    expect(informe.needingAttention.map((l) => l.label)).toEqual(['Ana', 'Bruno'])
  })

  it('avanzando y terminado, no: no se molesta a nadie', () => {
    const informe = buildTeamStatus(
      [miembro({ activity: 'fine' }), miembro({ label: 'B', activity: 'done' })],
      AHORA,
    )
    expect(informe.needingAttention).toEqual([])
  })

  it('un agente SIN SEÑAL hay que mirarlo aunque su ultima clasificacion fuera buena', () => {
    // Un agente que deja de latir deja tambien de mandar telemetria, asi que su
    // clasificacion se queda CONGELADA en la que tuviera. Mirando solo la
    // actividad, un agente caido en `fine` seria invisible para siempre.
    const informe = buildTeamStatus(
      [miembro({ lastBeatAt: haceMs(3_600_000), activity: 'fine' })],
      AHORA,
    )
    expect(informe.needingAttention).toHaveLength(1)
  })

  it('un reloj descuadrado tambien', () => {
    const informe = buildTeamStatus(
      [miembro({ lastBeatAt: new Date(AHORA.getTime() + 86_400_000), activity: 'fine' })],
      AHORA,
    )
    expect(informe.needingAttention).toHaveLength(1)
    expect(informe.text).toContain('reloj descuadrado')
  })

  it('el encabezado dice cuantos hay que mirar', () => {
    const informe = buildTeamStatus(
      [miembro({ activity: 'stuck' }), miembro({ label: 'B', activity: 'fine' })],
      AHORA,
    )
    expect(informe.text).toContain('2 agente(s), 1 que mirar')
  })
})

describe('la vista se lee sin contexto', () => {
  it('cada linea lleva quien, que tarea, como va y desde cuando', () => {
    const informe = buildTeamStatus(
      [
        miembro({
          label: 'Ana',
          taskRef: 'issue-42',
          activity: 'stuck',
          lastProgressAt: haceMs(600_000),
        }),
      ],
      AHORA,
    )
    const linea = informe.lines[0]?.text ?? ''

    expect(linea).toContain('Ana')
    expect(linea).toContain('issue-42')
    expect(linea).toContain('ATASCADO')
    expect(linea).toContain('hace 10 min')
  })

  it('sin tarea lo dice en vez de dejar un hueco', () => {
    expect(buildTeamStatus([miembro()], AHORA).text).toContain('sin tarea')
  })

  it('sin nadie dado de alta, lo dice', () => {
    const informe = buildTeamStatus([], AHORA)
    expect(informe.text).toBe('No hay ningún agente dado de alta.')
    expect(informe.needingAttention).toEqual([])
  })
})

describe('entrada invalida', () => {
  it('un `now` que no es una fecha se rechaza', () => {
    expect(() => buildTeamStatus([miembro()], new Date('vaya'))).toThrow(ValidationError)
  })
})
