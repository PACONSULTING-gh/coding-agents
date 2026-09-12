import { ValidationError } from '@coord/core'

/**
 * QUE HACE AHORA un desarrollador simulado, dado lo que observa.
 *
 * Es el cerebro del banco de pruebas del ADR 0010: cinco de estos, cada uno en
 * su contenedor y con su cuenta de GitHub, trabajando sobre el mismo repo para
 * que colisionen de verdad.
 *
 * Aqui NO hay red, ni base de datos, ni Claude Code. Solo la decision, que es
 * donde estan las reglas que importan y donde un fallo no se nota: un lazo que
 * sigue escribiendo con el arriendo caducado no da error, da una colision.
 *
 * ===========================================================================
 * EL ORDEN DE PRIORIDAD, Y POR QUE ESE
 * ===========================================================================
 * Se devuelve UNA accion por llamada. El lazo vuelve a preguntar despues de
 * ejecutarla, asi que el orden de prioridad es la politica entera:
 *
 *   1. ABANDONAR lo que tenga el arriendo caducado. Antes que nada.
 *   2. SOLTAR lo que ya no me esta asignado.
 *   3. RENOVAR lo que esta a punto de caducar.
 *   4. RECLAMAR un issue asignado que no tenga arriendo.
 *   5. TRABAJAR.
 *   6. Esperar.
 *
 * Las dos primeras van antes que trabajar a proposito: seguir escribiendo sin
 * arriendo es exactamente la colision que esta plataforma existe para evitar, y
 * es un fallo SILENCIOSO — el push funciona, el PR se abre, y el destrozo se
 * descubre en el merge.
 */

/** Cuantos issues lleva un dev simulado a la vez. */
export const DEFAULT_MAX_CONCURRENT = 1

/**
 * Cuanto antes de caducar se renueva el arriendo.
 *
 * Un minuto no es un numero magico: es tiempo de sobra para una llamada a la
 * base de datos y poco para que la ventana de renovacion se coma el TTL. Si
 * fuera mas corto, una pausa del proceso —que las hay: el agente esta
 * esperando a un modelo— dejaria caducar el arriendo entre dos comprobaciones.
 */
export const DEFAULT_RENEW_MARGIN_MS = 60_000

/** Un issue que GitHub dice que esta asignado a este dev. */
export interface AssignedIssue {
  /** Numero de issue como texto, igual que en el resto del sistema. */
  readonly taskRef: string
}

/** Un arriendo que este dev tiene ahora mismo. */
export interface HeldClaim {
  readonly claimId: string
  readonly taskRef: string
  readonly expiresAt: Date
}

export interface WorkLoopInput {
  /** Issues asignados a ESTE dev en GitHub. */
  readonly assigned: readonly AssignedIssue[]
  /** Arriendos de los que este dev es titular. */
  readonly held: readonly HeldClaim[]
  readonly now: Date
  /**
   * Tope de issues a la vez.
   *
   * Es la palanca de coste del ADR 0010: cinco agentes sobre una sola
   * suscripcion multiplican por cinco la presion sobre los limites. Bajar esto
   * a 1 —el defecto— hace que el banco siga produciendo colisiones, porque un
   * arriendo dura mucho mas que el rato en que se escribe codigo.
   */
  readonly maxConcurrent?: number
  readonly renewMarginMs?: number
}

export type WorkAction =
  /** El arriendo caduco. PARAR y no empujar: el issue puede ser ya de otro. */
  | {
      readonly kind: 'abandon'
      readonly claimId: string
      readonly taskRef: string
      readonly reason: string
    }
  /** Soltar limpiamente: ya no me toca. */
  | {
      readonly kind: 'release'
      readonly claimId: string
      readonly taskRef: string
      readonly reason: string
    }
  | {
      readonly kind: 'renew'
      readonly claimId: string
      readonly taskRef: string
      readonly reason: string
    }
  | { readonly kind: 'claim'; readonly taskRef: string; readonly reason: string }
  | {
      readonly kind: 'work'
      readonly claimId: string
      readonly taskRef: string
      readonly reason: string
    }
  | { readonly kind: 'idle'; readonly reason: string }

/**
 * Orden estable por `taskRef`, NUNCA el orden de llegada ni uno aleatorio.
 *
 * Un banco de pruebas que elige al azar no se puede repetir: la colision que
 * salio el martes no vuelve a salir, y entonces no se puede saber si un cambio
 * la arreglo o simplemente no toco. La reproducibilidad es la mitad del valor
 * de este montaje.
 */
function porTaskRef<T extends { taskRef: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.taskRef.localeCompare(b.taskRef))
}

export function decideNextAction(input: WorkLoopInput): WorkAction {
  const maxConcurrent = input.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
  const renewMarginMs = input.renewMarginMs ?? DEFAULT_RENEW_MARGIN_MS

  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new ValidationError(
      `maxConcurrent tiene que ser un entero >= 1 y se recibio ${String(maxConcurrent)}. Un tope ` +
        'de cero es un dev que nunca trabaja, y eso no es "throttling": es un banco parado que ' +
        'parece funcionar.',
    )
  }
  if (!Number.isInteger(renewMarginMs) || renewMarginMs < 0) {
    throw new ValidationError(
      `renewMarginMs tiene que ser un entero >= 0 y se recibio ${String(renewMarginMs)}.`,
    )
  }

  const asignados = new Set(input.assigned.map((issue) => issue.taskRef))
  const sostenidos = porTaskRef(input.held)

  // 1. Caducados primero. Un arriendo vencido no es "casi vivo": desde el punto
  //    de vista del motor ya no existe, y otro dev puede haberlo cogido.
  const caducado = sostenidos.find((claim) => claim.expiresAt.getTime() <= input.now.getTime())
  if (caducado !== undefined) {
    return {
      kind: 'abandon',
      claimId: caducado.claimId,
      taskRef: caducado.taskRef,
      reason:
        `El arriendo de ${caducado.taskRef} caduco a las ${caducado.expiresAt.toISOString()}. Se ` +
        'para sin empujar: otro dev puede tenerlo ya, y empujar encima seria la colision que ' +
        'esto existe para evitar.',
    }
  }

  // 2. Lo que ya no me toca. Un humano reasigno el issue mientras yo trabajaba;
  //    seguir es pisarle el trabajo a quien lo tenga ahora.
  const ajeno = sostenidos.find((claim) => !asignados.has(claim.taskRef))
  if (ajeno !== undefined) {
    return {
      kind: 'release',
      claimId: ajeno.claimId,
      taskRef: ajeno.taskRef,
      reason:
        `${ajeno.taskRef} ya no esta asignado a este dev. Se suelta el arriendo en vez de ` +
        'retenerlo: un arriendo vivo de alguien que no trabaja en la tarea bloquea a quien si.',
    }
  }

  // 3. Renovar antes de perderlo. Va antes que trabajar porque perder el
  //    arriendo A MITAD del trabajo es el caso caro.
  const porCaducar = sostenidos.find(
    (claim) => claim.expiresAt.getTime() - input.now.getTime() <= renewMarginMs,
  )
  if (porCaducar !== undefined) {
    return {
      kind: 'renew',
      claimId: porCaducar.claimId,
      taskRef: porCaducar.taskRef,
      reason:
        `El arriendo de ${porCaducar.taskRef} caduca en menos de ${String(renewMarginMs)} ms. Se ` +
        'renueva antes de seguir: perderlo a mitad del trabajo obliga a tirar lo hecho.',
    }
  }

  // 4. Coger trabajo nuevo, si cabe.
  const conArriendo = new Set(sostenidos.map((claim) => claim.taskRef))
  const sinReclamar = porTaskRef(input.assigned).find((issue) => !conArriendo.has(issue.taskRef))
  const alTope = sostenidos.length >= maxConcurrent

  if (!alTope && sinReclamar !== undefined) {
    return {
      kind: 'claim',
      taskRef: sinReclamar.taskRef,
      reason: `${sinReclamar.taskRef} esta asignado a este dev y no tiene arriendo.`,
    }
  }

  // 5. Trabajar en lo que ya esta cogido.
  const enCurso = sostenidos[0]
  if (enCurso !== undefined) {
    return {
      kind: 'work',
      claimId: enCurso.claimId,
      taskRef: enCurso.taskRef,
      // Si hay trabajo asignado que NO se coge, se dice por que. Un dev parado
      // con issues delante parece un fallo, y aqui es la palanca de coste.
      reason:
        alTope && sinReclamar !== undefined
          ? `Arriendo vivo sobre ${enCurso.taskRef}. Hay mas issues asignados sin reclamar, pero ` +
            `el tope es ${String(maxConcurrent)} a la vez.`
          : `Arriendo vivo sobre ${enCurso.taskRef}, sin nada mas urgente que hacer.`,
    }
  }

  // Solo se llega aqui sin nada asignado: si hubiera algo asignado, o se habria
  // reclamado (4) o se estaria trabajando en ello (5), y lo sostenido que no
  // estuviera asignado se habria soltado en (2).
  return { kind: 'idle', reason: 'No hay ningun issue asignado a este dev.' }
}
