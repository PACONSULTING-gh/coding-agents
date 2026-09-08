/**
 * Vocabulario de dominio de los CLAIMS: reservas con arriendo (lease) sobre
 * issues y ficheros. Es la pieza que evita que dos agentes de dos personas
 * distintas trabajen sobre lo mismo (problema 2 de CLAUDE.md 1).
 *
 * Aqui viven SOLO los tipos. La implementacion —la tabla `claims`, el advisory
 * lock transaccional que serializa la reclamacion, las consultas— esta en
 * `packages/graph/src/claims.ts`, porque el dominio no conoce la
 * infraestructura (CLAUDE.md 5) y `packages/core` no importa de nadie.
 */

/** Que se reserva. Un issue (por numero) o un fichero (por ruta relativa). */
export const CLAIM_SUBJECT_KINDS = ['issue', 'file'] as const
export type ClaimSubjectKind = (typeof CLAIM_SUBJECT_KINDS)[number]

/** Quien reserva. Una persona o un agente de codigo. */
export const CLAIM_HOLDER_KINDS = ['user', 'agent'] as const
export type ClaimHolderKind = (typeof CLAIM_HOLDER_KINDS)[number]

/** Por que dejo de estar vivo un claim. `expired` = se le acabo el TTL. */
export const CLAIM_RELEASE_REASONS = ['released', 'expired'] as const
export type ClaimReleaseReason = (typeof CLAIM_RELEASE_REASONS)[number]

export interface ClaimSubject {
  readonly kind: ClaimSubjectKind
  /** Numero de issue como texto, o ruta RELATIVA a la raiz del repo. */
  readonly key: string
}

export interface ClaimHolder {
  readonly kind: ClaimHolderKind
  /** Identificador estable del titular. No se le ensena a nadie: para eso esta `label`. */
  readonly id: string
  /**
   * Nombre legible. Sin esto no se puede cumplir el criterio de aceptacion de
   * T04, que exige avisar de QUIEN tiene el sujeto reclamado.
   */
  readonly label: string
}

/**
 * Una fila viva (o ya cerrada) del arriendo. Un `claim()` sobre un issue mas N
 * ficheros produce N+1 `Claim` que comparten `groupId`: liberar o renovar
 * trabaja sobre el grupo entero, nunca deja ficheros colgando.
 */
export interface Claim {
  readonly claimId: string
  readonly groupId: string
  readonly repoId: string
  readonly subject: ClaimSubject
  readonly holder: ClaimHolder
  /** El "desde cuando" que hay que poder responderle a quien choca con el. */
  readonly claimedAt: Date
  /** Fuente de verdad del arriendo: pasado este instante el claim deja de contar. */
  readonly expiresAt: Date
  readonly releasedAt: Date | null
  readonly releasedReason: ClaimReleaseReason | null
  readonly metadata: Readonly<Record<string, unknown>>
}

/**
 * Un choque contra un claim ajeno. Se usa tanto en el rechazo de `claim()` como
 * en la respuesta de `checkOverlap()`: el rechazo NUNCA es un booleano, siempre
 * dice quien lo tiene y desde cuando.
 */
export interface ClaimConflict {
  /** El sujeto que esta reclamado por otro. */
  readonly subject: ClaimSubject
  readonly holder: ClaimHolder
  readonly claimedAt: Date
  readonly expiresAt: Date
  readonly claimId: string
  /**
   * Como se detecto:
   *   - `exact` — es literalmente el mismo sujeto. Es el criterio de aceptacion.
   *   - `graph` — no es el mismo fichero, pero el grafo de dependencias los
   *     conecta: tocar lo tuyo afecta a lo suyo, o al reves.
   */
  readonly signal: 'exact' | 'graph'
  /** Ficheros TUYOS implicados. En `exact` es el propio sujeto. */
  readonly relatedFiles: readonly string[]
  /** Saltos en el grafo hasta el sujeto reclamado. 0 en `exact`. */
  readonly distance: number
}
