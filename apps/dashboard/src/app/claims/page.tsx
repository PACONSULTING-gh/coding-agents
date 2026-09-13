import { runWithTenant } from '@coord/core'
import { configureDatabase } from '@coord/db'
import { activeClaims } from '@coord/graph'

import { cuantoLeQueda } from '../../lib/view'
import { tenantId } from '../../lib/tenant'

export const dynamic = 'force-dynamic'

/**
 * Quien tiene reservado que.
 *
 * Se enseña `truncated` cuando la pagina viene recortada, y no es un detalle: un
 * supervisor que mira esto para saber quien tiene que ve una lista incompleta y
 * la cree completa. Es el mismo motivo por el que la consulta lo devuelve.
 */
export default async function Reservas() {
  configureDatabase({ connectionString: process.env['DATABASE_URL'] ?? '' })
  const ahora = new Date()

  const pagina = await runWithTenant({ tenantId: tenantId() }, () => activeClaims({}))

  return (
    <section>
      <h1 className="font-[family-name:var(--font-heading)] text-2xl">Reservas vivas</h1>
      <p className="mt-1 text-sm text-[var(--color-apagado)]">
        Quién tiene reservado qué, ahora mismo. Una reserva caducada desaparece de aquí aunque nadie
        la haya segado.
      </p>

      {pagina.truncated ? (
        <p className="mt-4 border border-[var(--color-alarma)] px-4 py-3 text-sm text-[var(--color-alarma)]">
          Esta lista viene <strong>recortada</strong>: hay más reservas vivas de las que caben. No
          la leas como el total.
        </p>
      ) : null}

      {pagina.claims.length === 0 ? (
        <p className="mt-8 border border-[var(--color-borde)] bg-[var(--color-tarjeta)] p-6 text-sm">
          Ninguna reserva viva. Nadie tiene nada cogido en este momento.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-borde)] border border-[var(--color-borde)] bg-[var(--color-tarjeta)]">
          {pagina.claims.map((claim) => (
            <li key={claim.claimId} className="flex items-baseline gap-4 px-5 py-4">
              <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-[var(--color-apagado)]">
                {claim.subject.kind === 'issue' ? 'issue' : 'fichero'}
              </span>
              <span className="flex-1 font-mono text-sm">{claim.subject.key}</span>
              <span className="text-sm">{claim.holder.label}</span>
              <span className="w-52 text-right text-sm text-[var(--color-apagado)]">
                {cuantoLeQueda(claim.expiresAt, ahora)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
