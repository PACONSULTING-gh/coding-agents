/**
 * El desarrollador simulado del banco de pruebas (ADR 0010).
 *
 * De momento solo exporta la decision. La fontaneria —claims contra la base de
 * datos, GitHub, y Claude Code dentro del contenedor— va aparte y encima de
 * esto, igual que en el resto del repo: la regla se prueba sin levantar nada.
 */
export {
  decideNextAction,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_RENEW_MARGIN_MS,
  type AssignedIssue,
  type HeldClaim,
  type WorkAction,
  type WorkLoopInput,
} from './work-loop.js'
export {
  readDelivery,
  MAX_DIFF_BYTES,
  type Delivery,
  type DeliveryRequest,
  type TestRunEvidence,
} from './delivery.js'
