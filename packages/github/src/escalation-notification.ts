import { ValidationError, type EscalationNotice, type NotificationPort } from '@coord/core'
import type { App } from '@octokit/app'
import type { Octokit } from 'octokit'

import { publishPullRequestComment } from './pull-request-comments.js'

/**
 * Adaptador de `NotificationPort` sobre un comentario en el issue (T06, ADR
 * 0008, decision 5).
 *
 * Es coherente con `CLAUDE.md` §3: los issues son la fuente de verdad y los
 * comentarios el audit trail. Y va detras del puerto y no llamado a pelo desde
 * el flujo porque la decision 3 del indice de pendientes —el formato de la
 * vista de estado, epic 04 T05— sigue ABIERTA: cuando se resuelva habra que
 * enganchar otro canal, y asi eso es un adaptador nuevo en vez de tocar el
 * flujo entero.
 *
 * ===========================================================================
 * DOS LIMITES DE ESTE CANAL, DICHOS EN VOZ ALTA
 * ===========================================================================
 * 1. UNA TAREA SIN ISSUE NO SE PUEDE AVISAR POR AQUI. `taskRef` admite un slug
 *    de la fase de diseño, anterior al issue (ver `acceptance_criteria`). Si no
 *    hay numero de issue, este adaptador LANZA en vez de tragarselo: un aviso
 *    que no llega a ninguna parte es peor que un error, porque nadie se entera
 *    de que nadie se entero. Otro canal (epic 04 T05) podra con ello.
 *
 * 2. AQUI NO SE ADIVINA A QUIEN SE MENCIONA. La mencion llega en
 *    `notice.mention`, puesta por quien resolvio al responsable, porque es el
 *    unico que sabe de donde salio: un assignee de un issue es un login y el
 *    `id` de un claim puede ser cualquier cosa. Se intento deducirlo de la
 *    forma del id y NO FUNCIONA —un UUID pasa por login valido— y una mencion
 *    equivocada arrastra a un tercero cualquiera a un hilo que no es suyo. Sin
 *    `mention` se nombra por `label`, que informa igual.
 */

export interface EscalationTarget {
  readonly installationId: number
  readonly owner: string
  readonly repo: string
}

/** `issue-42` o `42`. Un slug de diseño no vale: ver el limite 1 de la cabecera. */
const TASK_REF_ISSUE = /^(?:issue-)?(\d+)$/

function issueNumberFor(taskRef: string): number {
  const match = TASK_REF_ISSUE.exec(taskRef.trim())
  const numero = match?.[1]
  if (numero === undefined) {
    throw new ValidationError(
      `La tarea ${JSON.stringify(taskRef)} no tiene numero de issue, asi que este canal no puede ` +
        'avisar de ella. Pasa por aqui una tarea con issue, o engancha otro canal al ' +
        'NotificationPort: un aviso que no llega no se puede dar por enviado.',
    )
  }
  return Number(numero)
}

const TITULO: Record<EscalationNotice['destination'], string> = {
  human: 'Verificación escalada a una persona',
  criteria_phase: 'De vuelta a la fase de criterios',
  same_agent: 'Devuelto al agente',
  done: 'Verificación superada',
}

/** A quien va dirigido, en una linea. El caso "nadie" NO se disimula. */
function lineaDeResponsable(notice: EscalationNotice): string {
  const responsable = notice.responsible
  if (responsable === undefined) {
    // Una tarea que falla y no tiene dueño es en si misma un hallazgo. Elegir a
    // alguien plausible lo convertiria en un mensaje que se ignora por no ir
    // con quien lo recibe.
    //
    // El motivo lo pone quien RESOLVIO (o no) al responsable, porque es el
    // unico que lo sabe. La frase generica se queda como respaldo, pero no se
    // afirma en ella nada concreto: decir "no hay assignee" cuando en realidad
    // hay tres co-asignados seria mentir en el unico mensaje que alguien va a
    // leer.
    const motivo = notice.unresolvedReason?.trim()
    const porQue =
      motivo === undefined || motivo === '' ? 'No se ha podido determinar quien responde' : motivo
    return `**Sin responsable identificado.** ${porQue}: alguien tiene que hacerse cargo de esto.`
  }
  if (notice.mention !== undefined && notice.mention.trim() !== '') {
    return `**Responsable:** @${notice.mention.trim()} (${responsable.label})`
  }
  // Sin `mention` NO se adivina. Se probo comprobar si el `id` "tiene forma de
  // login" y no sirve: un UUID la tiene, y mencionar a quien no toca arrastra a
  // un tercero a un hilo que no es suyo. Nombrar por `label` informa igual.
  return `**Responsable:** ${responsable.label} (${responsable.kind})`
}

export function renderEscalationComment(notice: EscalationNotice): string {
  const lineas = [
    `## ${TITULO[notice.destination]} — ${notice.taskRef}`,
    '',
    lineaDeResponsable(notice),
    '',
    notice.reason,
  ]
  if (notice.detail !== undefined && notice.detail.trim() !== '') {
    // Que paso, en los terminos de la pasada. Va DESPUES de lo que se hace
    // ahora y antes de los numeros: quien abre esto quiere saber primero si le
    // toca a el, y enseguida por que.
    lineas.push('', `**Qué pasó:** ${notice.detail.trim()}`)
  }
  lineas.push('', `**Intentos:** ${String(notice.attempts)} de ${String(notice.maxAttempts)}`)
  if (notice.headSha !== undefined) {
    // Sobre QUE codigo. Sin esto, un aviso pegado a un issue al que despues se
    // le empujan commits no dice a que entrega se refiere.
    lineas.push(`**Commit verificado:** \`${notice.headSha}\``)
  }
  if (notice.reportMarkdown !== undefined) {
    lineas.push('', '---', '', notice.reportMarkdown)
  }
  return lineas.join('\n')
}

/**
 * Publica el aviso como comentario del issue.
 *
 * NO se ha publicado nunca contra GitHub de verdad: no hay una GitHub App
 * registrada en ninguna maquina donde se ha escrito esto. Lo que si esta
 * probado es el camino hasta el cable, contra un servidor local que habla el
 * protocolo de una App — el mismo patron que el resto de `packages/github`.
 */
export class GitHubEscalationNotifier implements NotificationPort {
  readonly #app: App<{ Octokit: typeof Octokit }>
  readonly #target: EscalationTarget

  constructor(app: App<{ Octokit: typeof Octokit }>, target: EscalationTarget) {
    this.#app = app
    this.#target = target
  }

  async notifyEscalation(notice: EscalationNotice): Promise<void> {
    await publishPullRequestComment(
      this.#app,
      { ...this.#target, pullNumber: issueNumberFor(notice.taskRef) },
      renderEscalationComment(notice),
    )
  }
}
