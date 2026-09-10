import type { Claim, ClaimHolderKind } from '@coord/core'

/**
 * Señal de CARGA para el routing (epic 03 / T01).
 *
 * Responde "cuanto tiene encima cada persona AHORA MISMO", que es lo segundo
 * que mira el agente de routing — y solo despues de la evidencia de skill, no
 * antes: invertir ese orden es el fallo de diseño que el epic 03 existe para
 * evitar, porque el modelo coge el atajo de "el que este mas libre" y la
 * sugerencia deja de aportar nada que un `ORDER BY carga` no diera ya.
 *
 * Puro: se le dan los claims y los issues, devuelve la cuenta. La lectura de la
 * base de datos esta en `read.ts`.
 *
 * ===========================================================================
 * TRES FORMAS DE MENTIR CON UNA CUENTA DE CARGA, Y COMO SE EVITAN
 * ===========================================================================
 * 1. CONTAR DOS VECES EL MISMO TRABAJO. Si alguien tiene un claim sobre el
 *    issue 42 y ademas el issue 42 esta asignado a el, eso es UNA cosa, no
 *    dos. Contarlas por separado hace que quien usa bien la herramienta
 *    parezca el doble de ocupado que quien no la usa — el peor incentivo
 *    posible.
 * 2. CONTAR LO QUE YA NO ESTA VIVO. Un claim caducado o liberado no es carga.
 *    El criterio de aceptacion lo dice: "refleja issues en curso y claims
 *    activos, NO issues cerrados".
 * 3. DAR POR COMPLETA UNA LISTA RECORTADA. `activeClaims` puede devolver
 *    `truncated: true`, y una carga calculada sobre una lista recortada es un
 *    SUELO, no la cifra. Se propaga para que quien la lea no la tome por
 *    exacta.
 */

/** Un issue abierto y a quien esta asignado. Viene de GitHub, no de aqui. */
export interface OpenIssueAssignment {
  /** Numero del issue como texto: la misma forma que usa `ClaimSubject.key`. */
  readonly issueKey: string
  /** Identidad de la persona, la misma que `ClaimHolder.id`. */
  readonly assigneeId: string
  readonly assigneeLabel?: string
}

export interface ComputeWorkloadInput {
  /** Claims tal como los devuelve `activeClaims`. */
  readonly claims: readonly Claim[]
  /**
   * Issues abiertos con asignado. `undefined` significa "no se ha podido
   * consultar", que NO es lo mismo que "no hay ninguno": se propaga en
   * `includesOpenIssues` para que nadie confunda las dos cosas.
   */
  readonly openIssues?: readonly OpenIssueAssignment[]
  /** Si la lista de claims venia recortada. */
  readonly truncated?: boolean
  /** Para poder probar la caducidad sin esperar. Por defecto, ahora. */
  readonly now?: Date
}

export interface PersonWorkload {
  readonly holderId: string
  readonly holderLabel: string
  readonly kind: ClaimHolderKind
  /** Claims vivos sobre issues. */
  readonly claimedIssues: number
  /** Claims vivos sobre ficheros. Se cuentan aparte: no son unidades de trabajo. */
  readonly claimedFiles: number
  /** Issues abiertos asignados que NO tienen ya un claim suyo. */
  readonly assignedIssuesWithoutClaim: number
  /**
   * Unidades de trabajo en curso, sin contar dos veces lo mismo:
   * `claimedIssues + assignedIssuesWithoutClaim`.
   *
   * Los claims sobre ficheros NO suman aqui. Reservar tres ficheros para tocar
   * una cosa no es tener tres tareas, y sumarlos haria que quien trabaja con
   * cuidado parezca desbordado.
   */
  readonly total: number
}

export interface WorkloadResult {
  /**
   * De mas cargado a menos, con orden determinista.
   *
   * SOLO aparece quien tiene algo VIVO. Quien no esta en la lista tiene carga
   * cero, y esa es la respuesta — no un hueco. Devolver a todo el mundo con un
   * cero obligaria a esta funcion a saber quien existe, que es una pregunta de
   * otro sitio (la tabla `users`), y a inventarse una lista de personas cada
   * vez que alguien pregunta cuanto pesa el trabajo en curso.
   */
  readonly people: readonly PersonWorkload[]
  /** `true` si la lista de claims venia recortada: los totales son un SUELO. */
  readonly truncated: boolean
  /** `false` si no se pudieron consultar los issues: la carga esta incompleta. */
  readonly includesOpenIssues: boolean
}

interface Acumulado {
  holderId: string
  holderLabel: string
  kind: ClaimHolderKind
  claimedIssues: number
  claimedFiles: number
  /** Claves de issue ya contadas por un claim, para no contarlas otra vez. */
  issueKeysConClaim: Set<string>
}

/** Un claim cuenta si sigue vivo: ni liberado ni caducado. */
function estaVivo(claim: Claim, now: Date): boolean {
  return claim.releasedAt === null && claim.expiresAt.getTime() > now.getTime()
}

export function computeWorkload(input: ComputeWorkloadInput): WorkloadResult {
  const now = input.now ?? new Date()
  const porPersona = new Map<string, Acumulado>()

  const acumuladoDe = (holderId: string, holderLabel: string, kind: ClaimHolderKind): Acumulado => {
    const previo = porPersona.get(holderId)
    if (previo !== undefined) return previo
    const nuevo: Acumulado = {
      holderId,
      holderLabel,
      kind,
      claimedIssues: 0,
      claimedFiles: 0,
      issueKeysConClaim: new Set<string>(),
    }
    porPersona.set(holderId, nuevo)
    return nuevo
  }

  for (const claim of input.claims) {
    if (!estaVivo(claim, now)) continue
    const persona = acumuladoDe(claim.holder.id, claim.holder.label, claim.holder.kind)
    if (claim.subject.kind === 'issue') {
      persona.claimedIssues += 1
      persona.issueKeysConClaim.add(claim.subject.key)
    } else {
      persona.claimedFiles += 1
    }
  }

  const sinClaim = new Map<string, number>()
  for (const issue of input.openIssues ?? []) {
    const persona = acumuladoDe(issue.assigneeId, issue.assigneeLabel ?? issue.assigneeId, 'user')
    // Aqui esta la defensa contra el doble conteo.
    if (persona.issueKeysConClaim.has(issue.issueKey)) continue
    sinClaim.set(issue.assigneeId, (sinClaim.get(issue.assigneeId) ?? 0) + 1)
  }

  const people = [...porPersona.values()]
    .map((a) => {
      const assignedIssuesWithoutClaim = sinClaim.get(a.holderId) ?? 0
      return {
        holderId: a.holderId,
        holderLabel: a.holderLabel,
        kind: a.kind,
        claimedIssues: a.claimedIssues,
        claimedFiles: a.claimedFiles,
        assignedIssuesWithoutClaim,
        total: a.claimedIssues + assignedIssuesWithoutClaim,
      }
    })
    .sort(comparaCarga)

  return {
    people,
    truncated: input.truncated ?? false,
    includesOpenIssues: input.openIssues !== undefined,
  }
}

/**
 * Mas cargado primero; a igualdad, mas claims de fichero; y en ultimo lugar el
 * id, alfabeticamente.
 *
 * El desempate final no es decoracion: sin el, dos ejecuciones sobre los mismos
 * datos pueden devolver ordenes distintos segun como se construyo el Map, y una
 * sugerencia que cambia sin que cambien los datos no se le puede explicar a
 * nadie.
 */
function comparaCarga(a: PersonWorkload, b: PersonWorkload): number {
  if (a.total !== b.total) return b.total - a.total
  if (a.claimedFiles !== b.claimedFiles) return b.claimedFiles - a.claimedFiles
  return a.holderId.localeCompare(b.holderId)
}
