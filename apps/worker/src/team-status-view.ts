import type { TeamMemberStatus } from '@coord/core'

/**
 * De lo que hay en la base de datos a lo que pinta la vista.
 *
 * La telemetria es `jsonb` y por tanto entrada no confiable: lo que no tenga la
 * forma esperada se IGNORA en vez de romper la vista entera. Un agente que
 * manda basura no puede dejar al equipo sin poder mirar a los demas — es la
 * misma leccion que `clock_skew`.
 */
export function toMemberStatus(row: {
  label: string
  lastBeatAt: Date | undefined
  telemetry: Readonly<Record<string, unknown>>
  revoked: boolean
}): TeamMemberStatus {
  const taskRef =
    typeof row.telemetry['taskRef'] === 'string' ? row.telemetry['taskRef'] : undefined
  const crudo = row.telemetry['lastFileChangeAt']
  const lastProgressAt =
    typeof crudo === 'string' && !Number.isNaN(Date.parse(crudo)) ? new Date(crudo) : undefined

  return {
    label: row.label,
    ...(taskRef === undefined ? {} : { taskRef }),
    ...(row.lastBeatAt === undefined ? {} : { lastBeatAt: row.lastBeatAt }),
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    revoked: row.revoked,
  }
}
