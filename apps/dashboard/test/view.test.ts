import { describe, expect, it } from 'vitest'

import { cuantoLeQueda, haceCuanto, tonoDeFlujo, tonoDeLiveness } from '../src/lib/view.js'

/**
 * Como se pinta cada cosa en el panel.
 *
 * Lo que se fija: que el COLOR NUNCA sea la unica señal, y que los dos casos
 * que se leen mal —un futuro y una reserva caducada— salgan con palabras que
 * signifiquen lo que pasa.
 */

describe('el color nunca es la unica señal', () => {
  it.each([
    ['fresh', 'al día'],
    ['stale', 'dormido'],
    ['missing', 'sin señal'],
    ['clock_skew', 'reloj descuadrado'],
  ] as const)('%s lleva su palabra: %s', (liveness, etiqueta) => {
    // Un panel que distingue "dormido" de "caido" solo por el tono deja fuera a
    // quien no distingue esos tonos, y a cualquiera que lo mire en una captura
    // en blanco y negro — que es como acaban viajando por un chat.
    expect(tonoDeLiveness(liveness).etiqueta).toBe(etiqueta)
  })

  it('quien no ha latido nunca tiene su propia palabra, no la de "caido"', () => {
    expect(tonoDeLiveness(undefined).etiqueta).toBe('sin estrenar')
  })

  it('cada estado del flujo tambien', () => {
    expect(tonoDeFlujo('human').etiqueta).toContain('escalado')
    expect(tonoDeFlujo('criteria_phase').etiqueta).toContain('criterios')
    expect(tonoDeFlujo('done').etiqueta).toBe('superada')
  })

  it('dos estados distintos no comparten etiqueta', () => {
    // Si dos compartieran texto, el color volveria a ser la unica diferencia.
    const etiquetas = (['fresh', 'stale', 'missing', 'clock_skew'] as const).map(
      (l) => tonoDeLiveness(l).etiqueta,
    )
    expect(new Set(etiquetas).size).toBe(etiquetas.length)
  })
})

describe('cuanto hace', () => {
  it.each([
    [0, 'ahora mismo'],
    [59_000, 'ahora mismo'],
    [60_000, 'hace 1 min'],
    [3_600_000, 'hace 1 h'],
    [86_400_000, 'hace 1 d'],
  ])('%s ms → %s', (ms, esperado) => {
    expect(haceCuanto(ms)).toBe(esperado)
  })

  it('un futuro se dice, en vez de salir en negativo', () => {
    // "hace -3 min" es ruido que nadie sabe interpretar, y aqui significa algo
    // concreto: un reloj descuadrado.
    expect(haceCuanto(-60_000)).toBe('en el futuro')
  })
})

describe('cuanto le queda a una reserva', () => {
  const ahora = new Date('2026-09-13T12:00:00Z')

  it('lo caducado se dice CADUCADO, no "hace 3 min"', () => {
    // Un arriendo vencido no es uno reciente: es uno que ya no vale, y quien
    // mire la lista tiene que distinguirlo de un vistazo.
    expect(cuantoLeQueda(new Date(ahora.getTime() - 180_000), ahora)).toBe('caducada')
  })

  it('justo al vencer ya esta caducada', () => {
    expect(cuantoLeQueda(ahora, ahora)).toBe('caducada')
  })

  it.each([
    [30_000, 'caduca en menos de un minuto'],
    [600_000, 'caduca en 10 min'],
    [7_200_000, 'caduca en 2 h'],
  ])('%s ms por delante → %s', (ms, esperado) => {
    expect(cuantoLeQueda(new Date(ahora.getTime() + ms), ahora)).toBe(esperado)
  })
})
