import { buildTeamStatus, runWithTenant } from '@coord/core'
import { configureDatabase, readAgentStatuses } from '@coord/db'

import { haceCuanto, tonoDeLiveness } from '../lib/view.js'
import { tenantId } from '../lib/tenant.js'

/**
 * Quien esta haciendo que y como va.
 *
 * Sin cache: este panel existe para mirar AHORA MISMO si alguien esta atascado,
 * y una version de hace cinco minutos contesta a otra pregunta. Es la unica
 * razon por la que se renderiza en cada peticion.
 */
export const dynamic = 'force-dynamic'

export default async function Equipo() {
  configureDatabase({ connectionString: process.env['DATABASE_URL'] ?? '' })
  const ahora = new Date()

  const estados = await runWithTenant({ tenantId: tenantId() }, () => readAgentStatuses(ahora))
  const informe = buildTeamStatus(
    estados.map((estado) => ({
      label: estado.label,
      ...(typeof estado.telemetry['taskRef'] === 'string'
        ? { taskRef: estado.telemetry['taskRef'] }
        : {}),
      ...(estado.lastBeatAt === undefined ? {} : { lastBeatAt: estado.lastBeatAt }),
      revoked: estado.revoked,
    })),
    ahora,
  )

  return (
    <section>
      <h1 className="font-[family-name:var(--font-heading)] text-2xl">Equipo</h1>
      <p className="mt-1 text-sm text-[var(--color-apagado)]">
        {informe.needingAttention.length === 0
          ? 'Nadie necesita que le mires ahora mismo.'
          : `${String(informe.needingAttention.length)} de ${String(informe.lines.length)} necesitan que alguien mire.`}
      </p>

      {estados.length === 0 ? (
        <p className="mt-8 border border-[var(--color-borde)] bg-[var(--color-tarjeta)] p-6 text-sm">
          No hay ningún agente dado de alta todavía. Esto no significa que nada esté funcionando:
          significa que nadie ha registrado un agente en este cliente.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-borde)] border border-[var(--color-borde)] bg-[var(--color-tarjeta)]">
          {estados.map((estado) => {
            const tono = tonoDeLiveness(estado.revoked ? undefined : estado.liveness)
            const tarea = estado.telemetry['taskRef']
            return (
              <li key={estado.id} className="flex items-baseline gap-4 px-5 py-4">
                <span className={`w-44 shrink-0 text-sm font-medium ${tono.clase}`}>
                  {estado.revoked ? 'retirado' : tono.etiqueta}
                </span>
                <span className="flex-1">
                  <span className="font-medium">{estado.label}</span>
                  <span className="ml-3 text-sm text-[var(--color-apagado)]">
                    {typeof tarea === 'string' ? tarea : 'sin tarea'}
                  </span>
                </span>
                <span className="text-sm text-[var(--color-apagado)]">
                  {estado.lastBeatAt === undefined
                    ? 'nunca ha latido'
                    : `latió ${haceCuanto(ahora.getTime() - estado.lastBeatAt.getTime())}`}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
