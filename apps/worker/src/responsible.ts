import type { Claim, Responsible } from '@coord/core'
import { ValidationError } from '@coord/core'

/**
 * Quien responde de una tarea — la cadena de la decision 4 del ADR 0008:
 *
 *     holder del claim activo  ->  assignee del issue  ->  NADIE
 *
 * El "nadie" es un resultado legitimo y se dice en voz alta. Inventar un
 * destinatario plausible convierte un hallazgo —una tarea que falla y no tiene
 * dueño— en un mensaje que se ignora por no ir con quien lo recibe.
 *
 * ===========================================================================
 * POR QUE VIVE EN apps/worker Y NO EN packages/
 * ===========================================================================
 * Porque sabe de claims (`packages/graph`) y de GitHub (`packages/github`) a la
 * vez, y las dependencias apuntan hacia dentro: ningun paquete de dominio puede
 * conocer a los dos. Esto es raiz de composicion, que es justo donde se atan
 * cosas que no se conocen entre si.
 *
 * Las dos fuentes entran INYECTADAS y no importadas: asi se prueba la cadena
 * entera —que es donde esta la logica— sin levantar un Postgres ni una GitHub
 * App.
 *
 * ===========================================================================
 * LA MENCION NO SE ADIVINA NUNCA
 * ===========================================================================
 * `EscalationNotice.mention` es lo que va detras de una arroba, y solo se
 * rellena cuando la fuente GARANTIZA un login de GitHub:
 *
 *   - Por el assignee, siempre: `assignees[].login` es exactamente eso.
 *   - Por el claim, solo si el claim lo dejo escrito en
 *     `metadata.githubLogin`. El `id` del holder NO vale: se probo deducir si
 *     "tiene forma de login" y no sirve —un UUID la tiene—, y mencionar a quien
 *     no toca arrastra a un tercero a un hilo que no es suyo.
 *
 * Sin mencion el aviso nombra por `label`, que informa igual.
 */

/** `issue-42` o `42`. Un slug de la fase de diseño no lleva numero. */
const TASK_REF_ISSUE = /^(?:issue-)?(\d+)$/

export interface ResolveResponsibleInput {
  readonly taskRef: string
  /**
   * Obligatorio, y no es burocracia: `claim()` garantiza como mucho un claim
   * vivo por sujeto **dentro de un repo**. Sin acotar por repo, dos issues
   * numero 42 de dos repos distintos se mezclarian y la cadena elegiria a
   * alguien de otro proyecto.
   */
  readonly repoId: string
}

/**
 * De donde salio el responsable, o por que no salio.
 *
 * Es un union discriminado y no un `responsible?: Responsible` a secas porque
 * quien avisa necesita distinguir "no hay nadie" de "hay varios y no se elige
 * a uno", y las dos cosas colapsarian en `undefined`.
 */
export type ResponsibleResolution =
  | { readonly source: 'claim'; readonly responsible: Responsible; readonly mention?: string }
  | {
      readonly source: 'issue_assignee'
      readonly responsible: Responsible
      readonly mention: string
    }
  | { readonly source: 'none'; readonly unresolvedReason: string }

export interface ResolveResponsibleDeps {
  /** Claims VIVOS sobre el issue, ya acotados a `repoId`. */
  readonly activeIssueClaims: (input: ResolveResponsibleInput) => Promise<readonly Claim[]>
  /** Logins asignados al issue, en el orden que devuelve GitHub. */
  readonly issueAssignees: (issueNumber: number) => Promise<readonly string[]>
}

/** El login que el claim dejo escrito, si lo dejo. Cualquier otra cosa se ignora. */
function githubLoginFromMetadata(claim: Claim): string | undefined {
  const login = claim.metadata['githubLogin']
  if (typeof login !== 'string') return undefined
  const limpio = login.trim()
  return limpio === '' ? undefined : limpio
}

export async function resolveResponsible(
  input: ResolveResponsibleInput,
  deps: ResolveResponsibleDeps,
): Promise<ResponsibleResolution> {
  if (input.taskRef.trim() === '' || input.repoId.trim() === '') {
    throw new ValidationError('resolveResponsible necesita `taskRef` y `repoId` no vacios.')
  }

  // --- Eslabon 1: el claim activo -------------------------------------------
  const claims = await deps.activeIssueClaims(input)
  const sobreElIssue = claims.filter((claim) => claim.subject.kind === 'issue')

  if (sobreElIssue.length > 1) {
    // No deberia poder pasar: `claim()` rechaza reclamar un sujeto que ya tiene
    // un claim vivo en ese repo. Si pasa, el invariante esta roto y elegir uno
    // seria tapar el fallo con una decision inventada.
    throw new ValidationError(
      `Hay ${String(sobreElIssue.length)} claims vivos sobre ${input.taskRef} en el repo ` +
        `${input.repoId}, y solo puede haber uno. No se elige responsable con el invariante ` +
        'roto: revisa la tabla `claims`.',
    )
  }

  const claimActivo = sobreElIssue.at(0)
  if (claimActivo !== undefined) {
    const mention = githubLoginFromMetadata(claimActivo)
    return {
      source: 'claim',
      responsible: claimActivo.holder,
      ...(mention === undefined ? {} : { mention }),
    }
  }

  // --- Eslabon 2: el assignee del issue -------------------------------------
  const match = TASK_REF_ISSUE.exec(input.taskRef.trim())
  const numero = match?.[1]
  if (numero === undefined) {
    // Una tarea todavia en fase de diseño no tiene issue, asi que no hay
    // assignee que mirar. No es un error: es el final de la cadena, y se dice.
    return {
      source: 'none',
      unresolvedReason:
        `No hay claim activo sobre ${input.taskRef} y la tarea no tiene numero de issue ` +
        '(es un slug de la fase de diseño), asi que tampoco hay assignee que consultar',
    }
  }

  const assignees = await deps.issueAssignees(Number(numero))

  if (assignees.length === 1) {
    const login = assignees[0] ?? ''
    return {
      source: 'issue_assignee',
      responsible: { kind: 'user', id: login, label: login },
      mention: login,
    }
  }

  if (assignees.length > 1) {
    // Varios co-asignados. Elegir "el primero" seria arbitrario —GitHub no los
    // ordena por responsabilidad— y es exactamente el "elegir a alguien
    // plausible" que prohibe la decision 4 del ADR 0008. Y decir "no hay
    // assignee" seria FALSO. Se dice lo que hay.
    return {
      source: 'none',
      unresolvedReason:
        `No hay claim activo sobre ${input.taskRef} y el issue tiene ${String(assignees.length)} ` +
        `personas asignadas (${assignees.join(', ')}), asi que ninguna es "la" responsable`,
    }
  }

  return {
    source: 'none',
    unresolvedReason: `No hay claim activo sobre ${input.taskRef} ni nadie asignado al issue`,
  }
}
