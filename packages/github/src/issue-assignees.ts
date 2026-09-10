import type { App } from '@octokit/app'
import type { Octokit } from 'octokit'

import { ValidationError } from '@coord/core'

/**
 * Quien tiene asignado un issue — el SEGUNDO eslabon de la cadena de
 * responsable del ADR 0008 (decision 4), detras del holder del claim activo.
 *
 * ===========================================================================
 * POR QUE SE LEE DE GITHUB Y NO DEL PAYLOAD DEL WEBHOOK
 * ===========================================================================
 * `routing-trigger.ts` ya saca los assignees del cuerpo de un webhook, y eso
 * esta bien ALLI: decide sobre el evento que acaba de llegar. Aqui no. El
 * flujo de fallo se dispara despues de verificar —minutos u horas despues de
 * la entrega— y el payload que arranco la cadena puede tener un assignee que
 * ya no es el actual. Avisar al que estaba asignado ayer es la misma clase de
 * error que mencionar a quien no toca.
 *
 * ===========================================================================
 * UN LOGIN DE GITHUB SI SE PUEDE MENCIONAR, Y ESO ES LO IMPORTANTE
 * ===========================================================================
 * El `id` del holder de un claim puede ser cualquier cosa —un UUID pasa por
 * login perfectamente valido— y por eso `EscalationNotice.mention` lo aporta
 * quien resuelve al responsable, nunca el adaptador. Esta funcion es una de
 * las pocas fuentes que SI garantiza un login: lo que devuelve GitHub en
 * `assignees[].login` es exactamente lo que va detras de una arroba.
 *
 * NO SE HA EJERCITADO CONTRA LA API DE GITHUB DE VERDAD: no hay una GitHub App
 * registrada en esta maquina. Su test corre contra un servidor HTTP local que
 * habla el protocolo de la App, mismo patron que `pull-request-comments.ts`.
 */

export interface IssueAssigneesTarget {
  /** Id de la instalacion de la App en la cuenta/organizacion propietaria del repo. */
  readonly installationId: number
  readonly owner: string
  readonly repo: string
  readonly issueNumber: number
}

function assertTargetIsUsable(target: IssueAssigneesTarget): void {
  if (target.owner.trim() === '' || target.repo.trim() === '') {
    throw new ValidationError('readIssueAssignees necesita `owner` y `repo` no vacios.')
  }
  if (!Number.isInteger(target.issueNumber) || target.issueNumber <= 0) {
    throw new ValidationError(
      `readIssueAssignees necesita un numero de issue positivo, recibido: ${String(target.issueNumber)}.`,
    )
  }
  if (!Number.isInteger(target.installationId) || target.installationId <= 0) {
    throw new ValidationError(
      `readIssueAssignees necesita un installationId positivo, recibido: ${String(target.installationId)}.`,
    )
  }
}

/**
 * Los logins asignados al issue, EN EL ORDEN QUE DEVUELVE GITHUB y sin
 * recortar.
 *
 * Se devuelven todos y no solo el primero a proposito: quien decide a quien se
 * avisa es `resolveResponsible`, y para poder decir "hay tres asignados" en vez
 * de elegir uno en silencio necesita verlos todos. Recortar aqui escondería la
 * ambiguedad justo debajo de la capa que existe para no esconderla.
 *
 * `assignees` en plural y no `assignee`: el singular esta deprecado. A
 * diferencia de `routing-trigger.ts` —que lee cuerpos de webhook, donde el
 * singular todavia aparece relleno con el plural vacio— aqui se lee la API
 * REST, que siempre manda el plural.
 *
 * NO ATRAPA errores del transporte (404, 403, 5xx): se propagan con su tipo
 * para que el llamante distinga "el issue no existe" de "no hay permisos" de
 * "GitHub esta caido". Tragarselos aqui devolveria "sin assignees", y eso se
 * leeria como "nadie es responsable" — que es una afirmacion muy distinta de
 * "no se ha podido preguntar".
 */
export async function readIssueAssignees(
  app: App<{ Octokit: typeof Octokit }>,
  target: IssueAssigneesTarget,
): Promise<readonly string[]> {
  assertTargetIsUsable(target)

  const octokit = await app.getInstallationOctokit(target.installationId)
  const response = await octokit.rest.issues.get({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
  })

  return (response.data.assignees ?? [])
    .map((assignee) => assignee.login)
    .filter((login) => login.trim() !== '')
}
