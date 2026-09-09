import {
  publishPullRequestComment,
  type PublishedComment,
  type PullRequestCommentTarget,
} from '@coord/github'

import { renderConformanceReportMarkdown, type ScreenBudget } from './report-render.js'
import type { ConformanceReport } from './report.js'

/**
 * T05 — publica el informe de conformidad como comentario del PR.
 *
 * ===========================================================================
 * ESTO REUTILIZA `@coord/github`, NO REIMPLEMENTA UN CLIENTE
 * ===========================================================================
 * `octokit` es un detalle de implementacion de `packages/github`
 * (`octokit-solo-en-github` en `.dependency-cruiser.cjs`), asi que este
 * fichero no lo importa ni nombra su tipo `App`: recibe lo que devuelve
 * `createGitHubApp()` como un tipo OPACO — `Parameters<typeof
 * publishPullRequestComment>[0]` lo extrae de la firma de la funcion que ya
 * importamos, sin escribir un `import` a `@octokit/app`. Si algun dia alguien
 * añade aqui `import type { App } from '@octokit/app'`, `pnpm arch` se pone en
 * rojo por esa misma regla.
 *
 * ===========================================================================
 * NO SE HA PUBLICADO NUNCA UN COMENTARIO DE VERDAD
 * ===========================================================================
 * Publicar de verdad necesita una GitHub App REGISTRADA en GitHub (un App ID y
 * una clave privada que GitHub reconozca) instalada en el repositorio del PR,
 * y eso no existe en esta maquina ni en este repositorio: es una decision de
 * producto pendiente, no un secreto que falte configurar. Esta funcion esta
 * escrita y tipada, y su test (`report-publisher.test.ts`) la ejercita contra
 * un servidor HTTP local que habla el protocolo de la App —igual que
 * `pull-request-comments.test.ts` de `packages/github`— para comprobar que la
 * peticion sale bien formada. Eso NO equivale a haberla probado contra GitHub:
 * nadie debe leer "el test esta en verde" como "el comentario se publico en un
 * PR real".
 */

export interface PublishConformanceReportResult {
  readonly comment: PublishedComment
  readonly rendered: ReturnType<typeof renderConformanceReportMarkdown>
}

/**
 * Renderiza el informe en Markdown y lo publica como comentario del PR.
 *
 * Los errores de `publishPullRequestComment` (404, 403, timeouts...) se
 * propagan tal cual: un `catch` que los tragara aqui dejaria creer a quien
 * llama que el informe llego al humano cuando no llego, que es el fallo
 * silencioso que este epic existe para evitar (CLAUDE.md 5 y 7).
 */
export async function publishConformanceReport(
  app: Parameters<typeof publishPullRequestComment>[0],
  target: PullRequestCommentTarget,
  report: ConformanceReport,
  budget?: ScreenBudget,
): Promise<PublishConformanceReportResult> {
  const rendered = renderConformanceReportMarkdown(report, budget)
  const comment = await publishPullRequestComment(app, target, rendered.text)
  return { comment, rendered }
}
