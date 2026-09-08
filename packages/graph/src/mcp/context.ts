import { uuidSchema } from '@coord/core'

/**
 * De donde sale el contexto de tenant para un servidor MCP.
 *
 * Un servidor MCP habla por stdio con UN agente a la vez y no tiene sesion
 * HTTP de la que leer "quien pregunta" (a diferencia de `apps/webhook`, que lo
 * saca del mapeo de instalacion de GitHub). La decision es: **variable de
 * entorno al arrancar el proceso**, no argumento de cada herramienta.
 *
 * Por que esta y no la otra opcion (`tenantId` como parametro de cada
 * llamada): un parametro seria una declaracion del propio llamante -- el LLM
 * que usa la herramienta -- y el aislamiento entre tenants dejaria de
 * garantizarlo el arranque del proceso para depender de que el agente no se
 * equivoque o no se le pueda persuadir de cambiarlo a mitad de conversacion.
 * Con la variable de entorno, quien despliega el servidor (un humano, o su
 * configuracion de Claude Code) fija el tenant UNA vez, fuera del alcance de
 * lo que el LLM puede escribir en una llamada a herramienta. Es el mismo
 * principio que `runWithTenant`: el contexto de tenant nunca sale de un dato
 * que controla el codigo que se audita, no de un dato que controla el
 * peticionario.
 *
 * Sin la variable, el servidor **no arranca**: nunca respondemos "todo" por
 * no tener contexto (regla dura de T05 y de CLAUDE.md 2.6).
 */

export interface GraphMcpServerConfig {
  readonly tenantId: string
  /**
   * Raiz de los checkouts locales (`<raiz>/<owner>/<repo>`), la MISMA
   * variable que usa `apps/worker` para la ingesta (ver `.env.example`).
   * `who_last_touched` la necesita para poder correr `git log`; el resto de
   * herramientas no la tocan. `undefined` si no esta definida: la herramienta
   * lo dice al llamarse, no lo oculta el arranque.
   */
  readonly checkoutRoot?: string | undefined
}

export const TENANT_ENV_VAR = 'GRAPH_MCP_TENANT_ID'
export const CHECKOUT_ROOT_ENV_VAR = 'GRAPH_CHECKOUT_ROOT'

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): GraphMcpServerConfig {
  const tenantId = env[TENANT_ENV_VAR]?.trim()
  if (tenantId === undefined || tenantId === '') {
    throw new Error(
      `Falta ${TENANT_ENV_VAR}. Un servidor MCP no tiene sesion HTTP de la que sacar el tenant, ` +
        'asi que se declara al arrancar el proceso (ver packages/graph/README.md, seccion ' +
        '"Herramientas MCP"). El servidor se niega a arrancar sin el: nunca responde "todo" por ' +
        'no tener contexto de tenant.',
    )
  }
  if (!uuidSchema.safeParse(tenantId).success) {
    throw new Error(`${TENANT_ENV_VAR}="${tenantId}" no es un uuid valido.`)
  }

  const checkoutRoot = env[CHECKOUT_ROOT_ENV_VAR]?.trim()
  return {
    tenantId,
    checkoutRoot: checkoutRoot === undefined || checkoutRoot === '' ? undefined : checkoutRoot,
  }
}
