import { ValidationError } from '@coord/core'
import { describe, expect, it } from 'vitest'

import { decideNudge, NUDGE_COOLDOWN_MS, parseTelemetry } from '../src/heartbeat-classify.js'

/**
 * De la telemetria cruda al empujon (epic 04 / T03, criterio 3).
 *
 * Dos cosas que es facil estropear sin que se note: que basura en la telemetria
 * genere una ALARMA en vez de un "no se sabe", y que un agente atascado reciba
 * un empujon en cada latido.
 */

const AHORA = new Date('2026-09-13T12:00:00Z')

describe('la telemetria es entrada no confiable', () => {
  it('lo que viene bien, se lee', () => {
    const t = parseTelemetry({
      lastToolCall: 'Bash(pnpm test)',
      repeatedToolCalls: 4,
      lastFileChangeAt: '2026-09-13T11:00:00Z',
      finished: false,
      consecutiveFailures: 1,
      securityEvent: false,
    })

    expect(t.lastToolCall).toBe('Bash(pnpm test)')
    expect(t.repeatedToolCalls).toBe(4)
    expect(t.lastFileChangeAt?.toISOString()).toBe('2026-09-13T11:00:00.000Z')
  })

  it.each([
    ['una cadena', 'muchas'],
    ['un negativo', -3],
    ['un decimal', 2.5],
    ['ausente', undefined],
  ])('un contador que es %s cuenta como cero, no como atasco', (_caso, repeatedToolCalls) => {
    // El valor neutro nunca es el alarmante. Inventarse una alarma con datos
    // que no se entienden es la forma mas rapida de que nadie se las crea.
    expect(parseTelemetry({ repeatedToolCalls }).repeatedToolCalls).toBe(0)
  })

  it('una cadena "false" NO cuenta como terminado', () => {
    // Es truthy. Darla por terminada dejaria de vigilar a un agente que sigue
    // trabajando.
    expect(parseTelemetry({ finished: 'false' }).finished).toBe(false)
  })

  it('un evento de seguridad solo cuenta si es exactamente `true`', () => {
    expect(parseTelemetry({ securityEvent: 'true' }).securityEvent).toBe(false)
    expect(parseTelemetry({ securityEvent: true }).securityEvent).toBe(true)
  })

  it.each([
    ['no es fecha', 'el martes'],
    ['es un numero', 123],
    ['falta', undefined],
  ])('un ultimo cambio que %s se ignora', (_caso, lastFileChangeAt) => {
    expect(parseTelemetry({ lastFileChangeAt }).lastFileChangeAt).toBeUndefined()
  })

  it('una telemetria vacia produce un agente que va bien, no uno roto', () => {
    const t = parseTelemetry({})
    expect(t.repeatedToolCalls).toBe(0)
    expect(t.securityEvent).toBe(false)
  })
})

const ATASCADO = {
  repeatedToolCalls: 5,
  lastToolCall: 'Bash(pnpm test)',
  finished: false,
  consecutiveFailures: 0,
  securityEvent: false,
}

describe('cuando se empuja', () => {
  it('un agente atascado y sin empujon previo, se empuja', () => {
    const decision = decideNudge(ATASCADO, undefined, AHORA)
    expect(decision.enqueue).toBe(true)
    expect(decision.reason).toContain('Bash(pnpm test)')
  })

  it('un agente que va bien no se empuja', () => {
    const decision = decideNudge(
      { ...ATASCADO, repeatedToolCalls: 0, lastFileChangeAt: AHORA },
      undefined,
      AHORA,
    )
    expect(decision.enqueue).toBe(false)
  })

  it('NO se empuja dos veces seguidas: el daemon late cada 45 segundos', () => {
    // Sin esto, un agente atascado recibiria veinte empujones en un cuarto de
    // hora, y a la tercera vez quien los lea deja de leerlos.
    const decision = decideNudge(ATASCADO, new Date(AHORA.getTime() - 60_000), AHORA)

    expect(decision.enqueue).toBe(false)
    expect(decision.reason).toContain('ya se le empujo')
  })

  it('pasado el enfriamiento, se vuelve a empujar', () => {
    const decision = decideNudge(ATASCADO, new Date(AHORA.getTime() - NUDGE_COOLDOWN_MS), AHORA)
    expect(decision.enqueue).toBe(true)
  })

  it('justo un milisegundo antes, todavia no', () => {
    const decision = decideNudge(ATASCADO, new Date(AHORA.getTime() - NUDGE_COOLDOWN_MS + 1), AHORA)
    expect(decision.enqueue).toBe(false)
  })

  it('un escalado NO encola empujon: no lo arregla un mensaje', () => {
    const decision = decideNudge({ ...ATASCADO, consecutiveFailures: 5 }, undefined, AHORA)
    expect(decision.enqueue).toBe(false)
    expect(decision.reason).toContain('escalate')
  })

  it.each([-1, 1.5])('un enfriamiento de %s se rechaza', (cooldownMs) => {
    expect(() => decideNudge(ATASCADO, undefined, AHORA, cooldownMs)).toThrow(ValidationError)
  })

  it('un enfriamiento de cero es valido: es "empuja siempre"', () => {
    const decision = decideNudge(ATASCADO, new Date(AHORA.getTime() - 1), AHORA, 0)
    expect(decision.enqueue).toBe(true)
  })
})
