import type { App } from '@octokit/app'
import type { Octokit } from 'octokit'

import { ValidationError } from '@coord/core'

/**
 * Publicar comentarios en un PR (issue de GitHub) — usado por el informe de
 * conformidad del epic 05 (T05, `packages/agents/src/verification/report-publisher.ts`).
 *
 * GitHub no tiene un endpoint separado "comentario de PR": un Pull Request ES
 * un Issue a efectos de comentarios, y la API de comentarios es
 * `POST /repos/{owner}/{repo}/issues/{issue_number}/comments` tanto para uno
 * como para otro. De ahi que este fichero hable de "issue comment" por dentro
 * y de "PR comment" en el nombre publico: es lo que va a usar el llamante.
 *
 * `octokit` es un detalle de implementacion de este paquete (regla
 * `octokit-solo-en-github` de `.dependency-cruiser.cjs`): fuera de aqui nadie
 * importa `@octokit/*` ni `octokit`. `packages/agents` recibe el `App` como un
 * tipo OPACO — lo obtiene de `createGitHubApp()` (tambien de este paquete) y
 * lo reenvia sin nombrar el tipo, asi que no hace falta abrir la regla para
 * que pueda usarlo.
 */

export interface PullRequestCommentTarget {
  /** Id de la instalacion de la App en la cuenta/organizacion propietaria del repo. */
  readonly installationId: number
  readonly owner: string
  readonly repo: string
  /** Numero del PR. En la API de comentarios es el mismo numero que el del issue. */
  readonly pullNumber: number
}

export interface PublishedComment {
  readonly id: number
  /** URL humana del comentario, tal como la devuelve GitHub. */
  readonly url: string
}

function assertTargetIsUsable(target: PullRequestCommentTarget): void {
  if (target.owner.trim() === '' || target.repo.trim() === '') {
    throw new ValidationError('publishPullRequestComment necesita `owner` y `repo` no vacios.')
  }
  if (!Number.isInteger(target.pullNumber) || target.pullNumber <= 0) {
    throw new ValidationError(
      `publishPullRequestComment necesita un numero de PR positivo, recibido: ${String(target.pullNumber)}.`,
    )
  }
  if (!Number.isInteger(target.installationId) || target.installationId <= 0) {
    throw new ValidationError(
      `publishPullRequestComment necesita un installationId positivo, recibido: ${String(target.installationId)}.`,
    )
  }
}

/**
 * Publica `body` como comentario del PR indicado.
 *
 * NO ATRAPA errores del transporte (404 de instalacion o repo, 403 de
 * permisos, 5xx): se propagan tal cual, con su tipo de `octokit`, para que el
 * llamante (T06, "flujo de fallo") pueda distinguir un fallo transitorio de
 * uno que necesita intervencion humana. Un `catch` que los tragara aqui haria
 * invisible que el informe de conformidad NUNCA llego al humano que tiene que
 * decidir — justo el fallo silencioso que el epic 05 existe para evitar.
 *
 * NO SE HA EJERCITADO CONTRA LA API DE GITHUB DE VERDAD: no hay una GitHub App
 * registrada en esta maquina. Su test (`test/pull-request-comments.test.ts`)
 * corre contra un servidor HTTP local que habla el protocolo de la App, con el
 * mismo patron que `installation-tokens.test.ts` — comprueba la peticion (JWT,
 * intercambio del token de instalacion, metodo, ruta, cuerpo), no que GitHub
 * de verdad acepte un comentario en un repo real.
 */
export async function publishPullRequestComment(
  app: App<{ Octokit: typeof Octokit }>,
  target: PullRequestCommentTarget,
  body: string,
): Promise<PublishedComment> {
  assertTargetIsUsable(target)
  if (body.trim() === '') {
    throw new ValidationError(
      'publishPullRequestComment necesita un cuerpo de comentario no vacio.',
    )
  }

  const octokit = await app.getInstallationOctokit(target.installationId)
  const response = await octokit.rest.issues.createComment({
    owner: target.owner,
    repo: target.repo,
    issue_number: target.pullNumber,
    body,
  })

  return { id: response.data.id, url: response.data.html_url }
}
