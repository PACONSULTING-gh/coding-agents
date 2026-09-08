import { createHmac, randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { createSignatureVerifier } from '../src/verify-signature.js'

/**
 * La verificacion de firma es LA frontera de confianza del listener: todo lo
 * que hay detras (deduplicacion, encolado, worker) confia en que el cuerpo
 * viene de GitHub porque esta funcion lo ha dicho.
 *
 * Ningun secreto vive en el repositorio, ni siquiera de test (CLAUDE.md 5): se
 * generan aleatorios en cada ejecucion.
 */

function newSecret(): string {
  return randomBytes(32).toString('hex')
}

/** Firma de referencia, calculada aparte del codigo que se esta probando. */
function sign(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`
}

const BODY = JSON.stringify({ action: 'opened', issue: { number: 7 }, installation: { id: 42 } })

describe('createSignatureVerifier', () => {
  it('acepta una firma valida', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)

    await expect(verify(Buffer.from(BODY, 'utf8'), sign(secret, BODY))).resolves.toEqual({
      valid: true,
    })
  })

  it('rechaza una firma calculada con otro secreto', async () => {
    const verify = createSignatureVerifier(newSecret())

    await expect(verify(Buffer.from(BODY, 'utf8'), sign(newSecret(), BODY))).resolves.toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('rechaza si se altera UN SOLO BYTE del cuerpo', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)
    const signature = sign(secret, BODY)

    const tampered = Buffer.from(BODY, 'utf8')
    // Se cambia un byte del interior del JSON, no del principio ni del final:
    // el objetivo es un cuerpo que sigue siendo JSON valido y solo difiere en
    // un caracter, que es la forma realista del ataque.
    const index = Math.floor(tampered.length / 2)
    const original = tampered[index]
    expect(original).toBeDefined()
    tampered[index] = (original ?? 0) ^ 0x01

    await expect(verify(tampered, signature)).resolves.toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('rechaza cuando no viene firma', async () => {
    const verify = createSignatureVerifier(newSecret())

    await expect(verify(Buffer.from(BODY, 'utf8'), undefined)).resolves.toEqual({
      valid: false,
      reason: 'missing_signature',
    })
    await expect(verify(Buffer.from(BODY, 'utf8'), '')).resolves.toEqual({
      valid: false,
      reason: 'missing_signature',
    })
  })

  it('rechaza una firma sha1 aunque el HMAC sha1 sea correcto', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)
    const sha1 = `sha1=${createHmac('sha1', secret).update(BODY, 'utf8').digest('hex')}`

    await expect(verify(Buffer.from(BODY, 'utf8'), sha1)).resolves.toEqual({
      valid: false,
      reason: 'unsupported_algorithm',
    })
  })

  it('rechaza firmas con formato imposible sin llegar a calcular el HMAC', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)

    for (const bogus of ['no-es-una-firma', 'sha256=', 'sha256=zz', `sha256=${'a'.repeat(63)}`]) {
      await expect(verify(Buffer.from(BODY, 'utf8'), bogus)).resolves.toEqual({
        valid: false,
        reason: 'malformed_signature',
      })
    }
  })

  it('rechaza un cuerpo vacio en vez de lanzar', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)

    await expect(verify(Buffer.alloc(0), sign(secret, ''))).resolves.toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('verifica sobre los BYTES CRUDOS: reserializar el JSON invalida la firma', async () => {
    const secret = newSecret()
    const verify = createSignatureVerifier(secret)
    const signature = sign(secret, BODY)

    // Mismo objeto, distinto texto (espacios). Si alguien parsease y volviese a
    // serializar antes de verificar, esto pasaria y no deberia.
    const reserialized = JSON.stringify(JSON.parse(BODY), null, 2)
    expect(reserialized).not.toBe(BODY)

    await expect(verify(Buffer.from(reserialized, 'utf8'), signature)).resolves.toEqual({
      valid: false,
      reason: 'signature_mismatch',
    })
  })

  it('no se puede construir un verificador sin secreto', () => {
    expect(() => createSignatureVerifier('')).toThrow(/secreto de webhook esta vacio/i)
    expect(() => createSignatureVerifier('   ')).toThrow(/secreto de webhook esta vacio/i)
  })
})
