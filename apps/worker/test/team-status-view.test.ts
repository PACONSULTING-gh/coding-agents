import { describe, expect, it } from 'vitest'

import { toMemberStatus } from '../src/team-status-view.js'

/**
 * La traduccion de lo que hay en la base de datos a lo que pinta la vista.
 *
 * La telemetria es `jsonb`: la manda el daemon y es entrada NO confiable. Lo
 * que se fija aqui es que la basura se ignore en vez de romper la vista — un
 * agente que manda cualquier cosa no puede dejar al equipo sin poder mirar a
 * los demas.
 */

const BASE = {
  label: 'Ana',
  lastBeatAt: new Date('2026-09-13T12:00:00Z'),
  telemetry: {},
  revoked: false,
}

describe('lo que se saca de la telemetria', () => {
  it('la tarea y el ultimo cambio, cuando vienen bien', () => {
    const miembro = toMemberStatus({
      ...BASE,
      telemetry: { taskRef: 'issue-42', lastFileChangeAt: '2026-09-13T11:00:00Z' },
    })

    expect(miembro.taskRef).toBe('issue-42')
    expect(miembro.lastProgressAt?.toISOString()).toBe('2026-09-13T11:00:00.000Z')
  })

  it.each([
    ['un numero', 42],
    ['un objeto', { a: 1 }],
    ['null', null],
  ])('una tarea que es %s se ignora', (_caso, taskRef) => {
    expect(toMemberStatus({ ...BASE, telemetry: { taskRef } }).taskRef).toBeUndefined()
  })

  it.each([
    ['una fecha que no se parsea', 'el martes pasado'],
    ['un numero', 1_726_000_000],
    ['una cadena vacia', ''],
  ])('un ultimo cambio que es %s se ignora', (_caso, lastFileChangeAt) => {
    // Ignorarlo deja la linea diciendo "sin tocar nada todavía", que es cierto:
    // no sabemos cuando toco nada. Inventarse una fecha seria peor.
    expect(
      toMemberStatus({ ...BASE, telemetry: { lastFileChangeAt } }).lastProgressAt,
    ).toBeUndefined()
  })

  it('sin telemetria ninguna, la linea sigue saliendo', () => {
    const miembro = toMemberStatus(BASE)
    expect(miembro.label).toBe('Ana')
    expect(miembro.taskRef).toBeUndefined()
  })

  it('las claves ausentes NO viajan como undefined', () => {
    // La forma del objeto es el contrato: `'taskRef' in miembro` tiene que
    // poder distinguir "no hay tarea" de "hay una clave vacia".
    expect(Object.keys(toMemberStatus(BASE)).sort()).toEqual(['label', 'lastBeatAt', 'revoked'])
  })
})
