import { randomUUID } from 'node:crypto'

import type { Claim } from '@coord/core'
import { describe, expect, it } from 'vitest'

import { computeWorkload, type OpenIssueAssignment } from '../src/workload/score.js'

/**
 * La señal de carga (epic 03 / T01), sin base de datos.
 *
 * Lo que se prueba aquí son las tres formas de mentir con una cuenta de carga
 * —contar dos veces, contar lo muerto, y dar por completa una lista recortada—
 * porque el criterio de aceptación es justo eso: "refleja issues en curso y
 * claims activos, no issues cerrados".
 */

const AHORA = new Date('2026-09-10T12:00:00Z')
const DENTRO_DE_UNA_HORA = new Date('2026-09-10T13:00:00Z')
const HACE_UNA_HORA = new Date('2026-09-10T11:00:00Z')

function claim(
  holderId: string,
  subject: { kind: 'issue' | 'file'; key: string },
  opciones: { expiresAt?: Date; releasedAt?: Date | null; label?: string } = {},
): Claim {
  return {
    claimId: randomUUID(),
    groupId: randomUUID(),
    repoId: randomUUID(),
    subject,
    holder: { kind: 'user', id: holderId, label: opciones.label ?? holderId },
    claimedAt: HACE_UNA_HORA,
    expiresAt: opciones.expiresAt ?? DENTRO_DE_UNA_HORA,
    releasedAt: opciones.releasedAt ?? null,
    releasedReason: opciones.releasedAt === undefined ? null : 'released',
    metadata: {},
  }
}

function issue(issueKey: string, assigneeId: string): OpenIssueAssignment {
  return { issueKey, assigneeId }
}

describe('no se cuenta dos veces el mismo trabajo', () => {
  it('un claim sobre el issue 42 y el issue 42 asignado son UNA cosa', () => {
    // Contarlas por separado haría que quien usa bien la herramienta parezca
    // el doble de ocupado que quien no la usa. El peor incentivo posible.
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' })],
      openIssues: [issue('42', 'ana')],
      now: AHORA,
    })

    const ana = resultado.people[0]
    expect(ana?.claimedIssues).toBe(1)
    expect(ana?.assignedIssuesWithoutClaim).toBe(0)
    expect(ana?.total).toBe(1)
  })

  it('un issue asignado SIN claim sí suma', () => {
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' })],
      openIssues: [issue('42', 'ana'), issue('99', 'ana')],
      now: AHORA,
    })

    expect(resultado.people[0]?.total).toBe(2)
    expect(resultado.people[0]?.assignedIssuesWithoutClaim).toBe(1)
  })

  it('los claims sobre FICHEROS no suman como unidades de trabajo', () => {
    // Reservar tres ficheros para tocar una cosa no es tener tres tareas.
    // Sumarlos haría que quien trabaja con cuidado parezca desbordado.
    const resultado = computeWorkload({
      claims: [
        claim('ana', { kind: 'issue', key: '42' }),
        claim('ana', { kind: 'file', key: 'src/a.ts' }),
        claim('ana', { kind: 'file', key: 'src/b.ts' }),
        claim('ana', { kind: 'file', key: 'src/c.ts' }),
      ],
      now: AHORA,
    })

    const ana = resultado.people[0]
    expect(ana?.total).toBe(1)
    // Pero se reportan, porque decirle a alguien QUÉ tiene reservado sí sirve.
    expect(ana?.claimedFiles).toBe(3)
  })
})

describe('lo que ya no está vivo no es carga', () => {
  it('un claim caducado no cuenta', () => {
    // El criterio dice "claims activos". Un lease vencido es exactamente lo
    // contrario: significa que el agente murió y nadie lo recogió.
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' }, { expiresAt: HACE_UNA_HORA })],
      now: AHORA,
    })

    // Ni siquiera aparece: quien no tiene nada vivo no tiene carga, y la
    // ausencia ES la respuesta. Un cero explícito obligaría a esta función a
    // saber quién existe, que es una pregunta de otro sitio.
    expect(resultado.people).toEqual([])
  })

  it('un claim liberado no cuenta', () => {
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' }, { releasedAt: HACE_UNA_HORA })],
      now: AHORA,
    })

    expect(resultado.people).toEqual([])
  })

  it('un claim que caduca dentro de un segundo todavía cuenta', () => {
    // El corte es el instante de caducidad, no "por si acaso, ya no".
    const dentroDeUnSegundo = new Date(AHORA.getTime() + 1_000)
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' }, { expiresAt: dentroDeUnSegundo })],
      now: AHORA,
    })

    expect(resultado.people[0]?.total).toBe(1)
  })
})

describe('una cuenta incompleta se dice, no se disimula', () => {
  it('sin issues, `includesOpenIssues` es false', () => {
    // Alguien sin claims NO está necesariamente libre: puede tener cinco
    // issues asignados que nadie ha mirado. Si esto se diera por completo, el
    // router mandaría trabajo al más cargado creyendo que es el más libre.
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' })],
      now: AHORA,
    })

    expect(resultado.includesOpenIssues).toBe(false)
  })

  it('una lista de issues VACÍA no es lo mismo que no poder consultarla', () => {
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' })],
      openIssues: [],
      now: AHORA,
    })

    expect(resultado.includesOpenIssues).toBe(true)
  })

  it('propaga que la lista de claims venía recortada', () => {
    // Una carga calculada sobre una lista recortada es un SUELO, no la cifra.
    const resultado = computeWorkload({
      claims: [claim('ana', { kind: 'issue', key: '42' })],
      truncated: true,
      now: AHORA,
    })

    expect(resultado.truncated).toBe(true)
  })
})

describe('el orden', () => {
  it('más cargado primero', () => {
    const resultado = computeWorkload({
      claims: [
        claim('ana', { kind: 'issue', key: '1' }),
        claim('bruno', { kind: 'issue', key: '2' }),
        claim('bruno', { kind: 'issue', key: '3' }),
      ],
      now: AHORA,
    })

    expect(resultado.people.map((p) => p.holderId)).toEqual(['bruno', 'ana'])
  })

  it('es determinista aunque todo empate', () => {
    // Sin desempate final, dos ejecuciones sobre los mismos datos pueden dar
    // órdenes distintos según cómo se construyó el Map.
    const zeta = claim('zeta', { kind: 'issue', key: '1' })
    const alfa = claim('alfa', { kind: 'issue', key: '2' })

    expect(
      computeWorkload({ claims: [zeta, alfa], now: AHORA }).people.map((p) => p.holderId),
    ).toEqual(['alfa', 'zeta'])
    expect(
      computeWorkload({ claims: [alfa, zeta], now: AHORA }).people.map((p) => p.holderId),
    ).toEqual(['alfa', 'zeta'])
  })

  it('quien solo tiene issues asignados también aparece', () => {
    // Si solo se listara a quien tiene claims, alguien con tres issues y cero
    // claims sería invisible para el router: el candidato perfecto para
    // recibir más trabajo, justo al revés de lo que toca.
    const resultado = computeWorkload({
      claims: [],
      openIssues: [issue('1', 'ana'), issue('2', 'ana')],
      now: AHORA,
    })

    expect(resultado.people[0]?.holderId).toBe('ana')
    expect(resultado.people[0]?.total).toBe(2)
  })
})
