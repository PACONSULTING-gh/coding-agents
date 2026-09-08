import { CLAIM_SUBJECT_KINDS, type Claim } from '@coord/core'
import { z } from 'zod'

import { activeClaims, MAX_ACTIVE_CLAIMS_LIMIT, MAX_CLAIM_FILES } from '../../claims.js'
import { repositorySchema } from '../../checkout.js'
import { fetchRankedPage, type RankedPage } from '../budget.js'
import { resolveRepoId } from '../resolve.js'

/**
 * `active_claims` (T05): "quien esta trabajando en que ahora mismo" (T04). Es
 * lectura pura de `claims.ts`; esta herramienta NO reclama, NO libera y NO
 * renueva -- eso exige decidir en nombre de un titular (`actorId` del
 * contexto, ver la cabecera de `claims.ts`) y un servidor MCP de solo
 * consulta no es el sitio para eso todavia.
 *
 * ---------------------------------------------------------------------------
 * RANKING: por que este orden
 * ---------------------------------------------------------------------------
 * Aqui no hay grafo que recorrer, asi que la distancia y el peso de T01-T03 no
 * aplican. La consulta de `activeClaims` ya ordena por `claimed_at DESC`: lo
 * mas RECIENTE primero. Es el eje de relevancia correcto para esta pregunta
 * en concreto -- un agente que quiere saber "en que esta metido todo el
 * mundo ahora mismo" le importa mas quien empezo hace 5 minutos que quien
 * reclamo hace 20 horas y esta a punto de caducar.
 */

const FETCH_LIMIT = MAX_ACTIVE_CLAIMS_LIMIT < 200 ? MAX_ACTIVE_CLAIMS_LIMIT : 200

export const activeClaimsInputShape = {
  repository: repositorySchema
    .optional()
    .describe('Limita a un repositorio ("owner/repo"). Omitelo para ver todos los del tenant.'),
  subjectKind: z
    .enum(CLAIM_SUBJECT_KINDS)
    .optional()
    .describe('Limita a claims de "issue" o de "file".'),
  subjectKeys: z
    .array(z.string().trim().min(1))
    .min(1)
    .max(MAX_CLAIM_FILES)
    .optional()
    .describe('Limita a estos numeros de issue o rutas de fichero.'),
  holderId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe('Limita a los claims de este titular.'),
}

export interface ActiveClaimsToolInput {
  readonly repository?: string | undefined
  readonly subjectKind?: 'issue' | 'file' | undefined
  /** No `readonly`: es el tipo real que produce el SDK al validar `subjectKeys`. */
  readonly subjectKeys?: string[] | undefined
  readonly holderId?: string | undefined
}

export interface CompactClaim {
  readonly claimId: string
  readonly repoId: string
  readonly subject: Claim['subject']
  readonly holder: Claim['holder']
  readonly claimedAt: string
  readonly expiresAt: string
}

function toCompactClaim(claim: Claim): CompactClaim {
  return {
    claimId: claim.claimId,
    repoId: claim.repoId,
    subject: claim.subject,
    holder: claim.holder,
    claimedAt: claim.claimedAt.toISOString(),
    expiresAt: claim.expiresAt.toISOString(),
  }
}

export async function runActiveClaims(
  input: ActiveClaimsToolInput,
): Promise<RankedPage<CompactClaim>> {
  const repoId = input.repository !== undefined ? resolveRepoId(input.repository) : undefined

  return fetchRankedPage({
    fetchLimit: FETCH_LIMIT,
    fetch: async (limit) => {
      const page = await activeClaims({
        repoId,
        subjectKind: input.subjectKind,
        subjectKeys: input.subjectKeys,
        holderId: input.holderId,
        limit,
      })
      return { hits: page.claims, truncated: page.truncated }
    },
    toOutput: toCompactClaim,
  })
}
