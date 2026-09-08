import { createHash } from 'node:crypto'

import { uuidSchema, ValidationError } from '@coord/core'

/**
 * `graph_*.repo_id` identifica un repositorio DENTRO de un tenant. Todavia no
 * existe una tabla `repositories` (lo dice la cabecera de la migracion 0007), y
 * crearla aqui seria inventar un modelo de datos sin consumidor.
 *
 * Mientras tanto el id se DERIVA de forma determinista del tenant y del nombre
 * completo del repositorio (`owner/repo`), como un UUID version 5. Determinista
 * significa que dos ingestas del mismo repositorio escriben sobre el mismo
 * grafo sin necesidad de guardar el mapeo en ningun sitio, y que el id de un
 * tenant nunca coincide con el de otro aunque el repositorio se llame igual.
 *
 * Cuando exista la tabla de repositorios, esta funcion se sustituye por una
 * lectura y el grafo no se entera.
 */
const NAMESPACE = Buffer.from('7b9f0f5c-2c1e-5a9d-9a5f-2f3b6c8d4e10'.replace(/-/g, ''), 'hex')

export function repoIdForRepository(tenantId: string, fullName: string): string {
  if (!uuidSchema.safeParse(tenantId).success) {
    throw new ValidationError(`tenantId no es un uuid: ${JSON.stringify(tenantId)}`)
  }
  const trimmed = fullName.trim()
  if (trimmed === '') {
    throw new ValidationError('El nombre del repositorio no puede estar vacio.')
  }

  const digest = createHash('sha1')
    .update(NAMESPACE)
    .update(`${tenantId}/${trimmed}`, 'utf8')
    .digest()

  // Bits de version (5) y de variante (RFC 4122), como manda el formato.
  const bytes = digest.subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
