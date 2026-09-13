import type { AgentLiveness } from '@coord/core'
import type { FlowState } from '@coord/db'

/**
 * Como se pinta cada cosa (front end del panel).
 *
 * ===========================================================================
 * EL COLOR NUNCA ES LA UNICA SEÑAL
 * ===========================================================================
 * Cada estado lleva su PALABRA. Un panel que distingue "dormido" de "caido"
 * solo por el tono deja fuera a quien no distingue esos dos tonos, y a
 * cualquiera que lo mire en una captura en blanco y negro — que es como acaban
 * viajando estas cosas por un chat.
 *
 * Es la misma regla que ya aplica la vista por CLI, y por el mismo motivo.
 *
 * ===========================================================================
 * ESTE PANEL SOLO LEE
 * ===========================================================================
 * No hay ni un boton que cambie nada, y es deliberado: los agentes proponen y
 * los humanos deciden (CLAUDE.md 2.1), pero decidir DESDE AQUI exigiria
 * autenticacion, permisos y audit_log, y hoy no hay ninguna de las tres. Un
 * panel de solo lectura sin login es una vista; uno con acciones seria un
 * agujero.
 */

export interface Tono {
  /** Texto que SIEMPRE acompaña al color. */
  readonly etiqueta: string
  /** Clases de Tailwind. Solo refuerzan lo que ya dice la etiqueta. */
  readonly clase: string
}

const SIN_LATIR: Tono = { etiqueta: 'sin estrenar', clase: 'text-[var(--color-apagado)]' }

const POR_LIVENESS: Record<AgentLiveness, Tono> = {
  fresh: { etiqueta: 'al día', clase: 'text-[var(--color-tinta)]' },
  stale: { etiqueta: 'dormido', clase: 'text-[var(--color-oro)]' },
  missing: { etiqueta: 'sin señal', clase: 'text-[var(--color-alarma)]' },
  clock_skew: { etiqueta: 'reloj descuadrado', clase: 'text-[var(--color-alarma)]' },
}

export function tonoDeLiveness(liveness: AgentLiveness | undefined): Tono {
  return liveness === undefined ? SIN_LATIR : POR_LIVENESS[liveness]
}

const POR_ESTADO_DE_FLUJO: Record<FlowState, Tono> = {
  awaiting_verification: {
    etiqueta: 'entregado, sin juzgar',
    clase: 'text-[var(--color-apagado)]',
  },
  same_agent: { etiqueta: 'de vuelta al agente', clase: 'text-[var(--color-oro)]' },
  criteria_phase: { etiqueta: 'de vuelta a criterios', clase: 'text-[var(--color-alarma)]' },
  human: { etiqueta: 'escalado a una persona', clase: 'text-[var(--color-alarma)]' },
  done: { etiqueta: 'superada', clase: 'text-[var(--color-tinta)]' },
}

export function tonoDeFlujo(state: FlowState): Tono {
  return POR_ESTADO_DE_FLUJO[state]
}

/**
 * Cuanto hace, en palabras.
 *
 * Un futuro sale como "en el futuro" en vez de "hace -3 min": un numero
 * negativo en la cara de alguien es ruido que nadie sabe interpretar, y aqui
 * significa algo concreto —un reloj descuadrado— que conviene poder leer.
 */
export function haceCuanto(ms: number): string {
  if (ms < 0) return 'en el futuro'
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 1) return 'ahora mismo'
  if (minutos < 60) return `hace ${String(minutos)} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${String(horas)} h`
  const dias = Math.floor(horas / 24)
  return `hace ${String(dias)} d`
}

/**
 * Cuanto le queda a una reserva.
 *
 * Lo caducado se dice CADUCADO y no "hace 3 min": un arriendo vencido no es un
 * arriendo reciente, es uno que ya no vale, y quien mire la lista tiene que
 * poder distinguirlo de un vistazo.
 */
export function cuantoLeQueda(expiresAt: Date, ahora: Date): string {
  const ms = expiresAt.getTime() - ahora.getTime()
  if (ms <= 0) return 'caducada'
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 1) return 'caduca en menos de un minuto'
  if (minutos < 60) return `caduca en ${String(minutos)} min`
  return `caduca en ${String(Math.floor(minutos / 60))} h`
}
