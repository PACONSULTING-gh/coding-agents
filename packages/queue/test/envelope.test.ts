import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  buildEnvelope,
  ENVELOPE_VERSION,
  parseEnvelope,
  tenantContextFrom,
} from '../src/envelope.js'
import { InvalidJobEnvelopeError } from '../src/errors.js'

/**
 * El envelope es una FRONTERA DE CONFIANZA: lo que hay en la columna `data` de
 * la tabla de jobs lo escribio otro proceso, posiblemente otra version del
 * codigo. CLAUDE.md 2.4 declara la validacion en fronteras de confianza como no
 * recortable, y este es el dato que reconstruye el aislamiento multi-tenant al
 * otro lado: si `tenantId` se colase mal formado, el worker procesaria el job
 * bajo un contexto que no es de nadie.
 *
 * Estos tests son unitarios a proposito: no necesitan base de datos porque lo
 * que se comprueba es el contrato del parser, no el motor de la cola.
 */

const tenantId = randomUUID()

describe('parseEnvelope: acepta lo valido', () => {
  it('devuelve el envelope con su payload intacto', () => {
    const envelope = buildEnvelope({ tenantId }, { hola: 'mundo' })
    const parsed = parseEnvelope<{ hola: string }>(JSON.parse(JSON.stringify(envelope)))

    expect(parsed.v).toBe(ENVELOPE_VERSION)
    expect(parsed.tenantId).toBe(tenantId)
    expect(parsed.payload).toEqual({ hola: 'mundo' })
  })

  it('conserva actorId y requestId cuando venian, y no los inventa cuando no', () => {
    const actorId = randomUUID()
    const requestId = randomUUID()

    const conContexto = parseEnvelope(buildEnvelope({ tenantId, actorId, requestId }, 1))
    expect(tenantContextFrom(conContexto)).toEqual({ tenantId, actorId, requestId })

    const sinContexto = parseEnvelope(buildEnvelope({ tenantId }, 1))
    expect(tenantContextFrom(sinContexto)).toEqual({ tenantId })
    expect('actorId' in sinContexto).toBe(false)
    expect('requestId' in sinContexto).toBe(false)
  })

  it('un payload null es un payload valido: el que no vale es el envelope roto', () => {
    const parsed = parseEnvelope(buildEnvelope({ tenantId }, null))
    expect(parsed.payload).toBeNull()
  })
})

describe('parseEnvelope: rechaza lo invalido con detalle util', () => {
  const casos: { nombre: string; data: unknown; esperado: string }[] = [
    {
      nombre: 'version distinta de la actual (productor con formato viejo)',
      data: { v: 99, tenantId, payload: {} },
      esperado: 'v',
    },
    { nombre: 'sin campo v', data: { tenantId, payload: {} }, esperado: 'v' },
    {
      nombre: 'tenantId que no es uuid',
      data: { v: ENVELOPE_VERSION, tenantId: 'no-soy-un-uuid', payload: {} },
      esperado: 'tenantId',
    },
    {
      nombre: 'sin tenantId: el job seria huerfano',
      data: { v: ENVELOPE_VERSION, payload: {} },
      esperado: 'tenantId',
    },
    {
      nombre: 'actorId vacio',
      data: { v: ENVELOPE_VERSION, tenantId, actorId: '', payload: {} },
      esperado: 'actorId',
    },
    { nombre: 'data null', data: null, esperado: '<raiz>' },
    { nombre: 'data que no es objeto', data: '{"roto":true}', esperado: '<raiz>' },
    { nombre: 'objeto ajeno', data: { roto: true }, esperado: 'v' },
  ]

  for (const { nombre, data, esperado } of casos) {
    it(`lanza InvalidJobEnvelopeError: ${nombre}`, () => {
      let lanzado: unknown
      try {
        parseEnvelope(data)
      } catch (error) {
        lanzado = error
      }

      expect(lanzado).toBeInstanceOf(InvalidJobEnvelopeError)
      const error = lanzado as InvalidJobEnvelopeError
      expect(error.code).toBe('INVALID_JOB_ENVELOPE')
      // El mensaje tiene que decir QUE campo falla: un "envelope invalido" a
      // secas obliga a adivinar delante de un job que ya esta en fallidos.
      expect(error.message).toContain(esperado)
      expect(error.cause, 'se pierde la causa original del fallo de validacion').toBeDefined()
    })
  }
})
