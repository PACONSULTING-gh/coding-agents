import { ValidationError } from './errors.js'
import { agentLiveness, type AgentActivity, type AgentLiveness } from './heartbeat.js'

/**
 * "Quien esta haciendo que y como va" (epic 04 / T05, issue #64).
 *
 * ===========================================================================
 * LATIR NO ES PROGRESAR, Y ESA ES LA DISTINCION QUE JUSTIFICA ESTA VISTA
 * ===========================================================================
 * Son dos relojes distintos y mezclarlos hace la vista inutil:
 *
 *   - El ULTIMO LATIDO dice si sabemos algo de la maquina.
 *   - El ULTIMO PROGRESO dice si el trabajo avanza.
 *
 * Un agente puede latir cada treinta segundos durante dos horas sin tocar un
 * fichero: la maquina esta perfectamente y el trabajo esta parado. Si la vista
 * solo enseñara el latido, ese caso saldria en verde — y es exactamente el que
 * hay que ver.
 *
 * Al reves tambien: un portatil que se suspende deja de latir y el trabajo no
 * ha ido a peor, solo que no se sabe.
 *
 * ===========================================================================
 * UN PORTATIL DORMIDO NO ES UN AGENTE CAIDO
 * ===========================================================================
 * Tercer criterio de aceptacion de T05. Se cumple con simbolos distintos y con
 * palabras distintas, no con matices de color: quien lee esto por CLI en
 * blanco y negro tiene que poder distinguirlos igual.
 */

export interface TeamMemberStatus {
  readonly label: string
  /** En que tarea. `undefined` si no esta en ninguna. */
  readonly taskRef?: string
  /** `undefined` mientras no haya latido ni una vez. */
  readonly lastBeatAt?: Date
  /** Ultimo cambio en ficheros. `undefined` si no ha tocado ninguno. */
  readonly lastProgressAt?: Date
  /** Lo que dijo el clasificador. `undefined` si no se ha clasificado. */
  readonly activity?: AgentActivity
  readonly revoked?: boolean
}

export interface TeamStatusLine {
  readonly label: string
  readonly liveness: AgentLiveness | 'never' | 'revoked'
  readonly activity: AgentActivity | undefined
  /** Milisegundos desde el ultimo cambio en ficheros. `undefined` si nunca. */
  readonly sinceProgressMs: number | undefined
  /** La linea ya formateada, lista para cualquiera de los tres canales. */
  readonly text: string
}

export interface TeamStatusReport {
  readonly lines: readonly TeamStatusLine[]
  /** Quienes necesitan que alguien mire. Es lo que decide si se avisa o no. */
  readonly needingAttention: readonly TeamStatusLine[]
  readonly text: string
}

/**
 * Simbolo por estado. Cada uno con su palabra al lado: en un canal sin color y
 * con un lector de pantalla, el simbolo solo no dice nada.
 */
const LIVENESS_LABEL: Record<TeamStatusLine['liveness'], string> = {
  fresh: '● al día',
  stale: '◐ dormido',
  missing: '○ sin señal',
  clock_skew: '⚠ reloj descuadrado',
  never: '· sin estrenar',
  revoked: '✕ retirado',
}

const ACTIVITY_LABEL: Record<AgentActivity, string> = {
  fine: 'avanzando',
  needs_nudge: 'parado',
  stuck: 'ATASCADO',
  done: 'terminado',
  escalate: 'ESCALADO',
}

/** Lo que hace que alguien tenga que mirar. `done` y `fine` no molestan a nadie. */
const NEEDS_ATTENTION: ReadonlySet<AgentActivity> = new Set(['stuck', 'escalate'])

function humanizarDuracion(ms: number): string {
  const minutos = Math.floor(ms / 60_000)
  if (minutos < 1) return 'ahora mismo'
  if (minutos < 60) return `hace ${String(minutos)} min`
  const horas = Math.floor(minutos / 60)
  if (horas < 24) return `hace ${String(horas)} h`
  return `hace ${String(Math.floor(horas / 24))} d`
}

export function buildTeamStatus(
  members: readonly TeamMemberStatus[],
  now: Date = new Date(),
): TeamStatusReport {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new ValidationError('buildTeamStatus necesita un `now` valido.')
  }

  const lines = members.map((member): TeamStatusLine => {
    const liveness: TeamStatusLine['liveness'] =
      member.revoked === true
        ? 'revoked'
        : member.lastBeatAt === undefined
          ? 'never'
          : agentLiveness(member.lastBeatAt, now)

    const sinceProgressMs =
      member.lastProgressAt === undefined
        ? undefined
        : Math.max(0, now.getTime() - member.lastProgressAt.getTime())

    const tarea = member.taskRef === undefined ? 'sin tarea' : member.taskRef
    const actividad =
      member.activity === undefined ? 'sin clasificar' : ACTIVITY_LABEL[member.activity]
    const progreso =
      sinceProgressMs === undefined
        ? 'sin tocar nada todavía'
        : `último cambio ${humanizarDuracion(sinceProgressMs)}`

    return {
      label: member.label,
      liveness,
      activity: member.activity,
      sinceProgressMs,
      text: `${LIVENESS_LABEL[liveness]} · ${member.label} · ${tarea} · ${actividad} · ${progreso}`,
    }
  })

  // Necesita que alguien mire quien esta atascado o escalado, Y TAMBIEN quien
  // se ha quedado sin señal. Lo segundo no lo dice ningun clasificador: un
  // agente que deja de latir deja tambien de mandar telemetria, asi que su
  // ultima clasificacion se queda congelada en la que tuviera. Si solo se
  // mirara la actividad, un agente caido en `fine` seria invisible para siempre.
  const needingAttention = lines.filter(
    (line) =>
      (line.activity !== undefined && NEEDS_ATTENTION.has(line.activity)) ||
      line.liveness === 'missing' ||
      line.liveness === 'clock_skew',
  )

  const encabezado =
    members.length === 0
      ? 'No hay ningún agente dado de alta.'
      : `Estado del equipo — ${String(members.length)} agente(s), ${String(needingAttention.length)} que mirar.`

  return {
    lines,
    needingAttention,
    text: [encabezado, ...lines.map((line) => line.text)].join('\n'),
  }
}
