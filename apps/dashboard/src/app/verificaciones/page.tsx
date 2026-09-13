import { runWithTenant } from '@coord/core'
import { configureDatabase, listVerificationFlows } from '@coord/db'

import { haceCuanto, tonoDeFlujo } from '../../lib/view'
import { tenantId } from '../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * En que punto esta cada tarea del flujo de verificacion.
 *
 * Se enseñan TODAS y no solo las escaladas: una vista que solo enseña lo que va
 * mal no deja ver que lo demas existe, y entonces "hay dos escaladas" no se
 * puede interpretar — ¿sobre tres tareas o sobre doscientas?
 */
export default async function Verificaciones() {
  configureDatabase({ connectionString: process.env['DATABASE_URL'] ?? '' })
  const ahora = new Date()

  const filas = await runWithTenant({ tenantId: tenantId() }, () => listVerificationFlows())
  const escaladas = filas.filter(
    (fila) => fila.state === 'human' || fila.state === 'criteria_phase',
  )

  return (
    <section>
      <h1 className="font-[family-name:var(--font-heading)] text-2xl">Verificaciones</h1>
      <p className="mt-1 text-sm text-[var(--color-apagado)]">
        {filas.length === 0
          ? 'Ninguna tarea ha pasado por verificación todavía.'
          : `${String(escaladas.length)} de ${String(filas.length)} necesitan a una persona.`}
      </p>

      {filas.length > 0 ? (
        <ul className="mt-6 divide-y divide-[var(--color-borde)] border border-[var(--color-borde)] bg-[var(--color-tarjeta)]">
          {filas.map((fila) => {
            const tono = tonoDeFlujo(fila.state)
            return (
              <li key={fila.taskRef} className="flex items-baseline gap-4 px-5 py-4">
                <span className="w-24 shrink-0 font-mono text-sm">{fila.taskRef}</span>
                <span className={`w-52 shrink-0 text-sm font-medium ${tono.clase}`}>
                  {tono.etiqueta}
                </span>
                <span className="flex-1 text-sm text-[var(--color-apagado)]">
                  {fila.responsible === undefined
                    ? 'sin responsable identificado'
                    : fila.responsible.label}
                </span>
                <span className="text-sm text-[var(--color-apagado)]">
                  {String(fila.attempts)} intento(s) ·{' '}
                  {haceCuanto(ahora.getTime() - fila.updatedAt.getTime())}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </section>
  )
}
