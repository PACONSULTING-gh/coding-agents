import { activeClaims, type ActiveClaimsFilter } from '../claims.js'

import { computeWorkload, type OpenIssueAssignment, type WorkloadResult } from './score.js'

/**
 * La carga de cada persona, leyendo los claims vivos de la base de datos.
 *
 * Los issues abiertos NO se leen aqui: llegan de fuera. `packages/graph` no
 * habla con GitHub —lo impide la fitness function `octokit-solo-en-github`— y
 * ademas hoy no hay ninguna GitHub App registrada en el proyecto, asi que quien
 * llame decide si puede aportarlos.
 *
 * Sin ellos la cuenta NO esta mal, esta INCOMPLETA, y eso se dice en
 * `includesOpenIssues`. La diferencia importa: alguien sin claims no esta
 * necesariamente libre, puede tener cinco issues asignados que nadie ha mirado.
 */
export interface LoadWorkloadOptions {
  readonly filter?: ActiveClaimsFilter
  readonly openIssues?: readonly OpenIssueAssignment[]
  readonly now?: Date
}

export async function loadWorkload(options: LoadWorkloadOptions = {}): Promise<WorkloadResult> {
  const page = await activeClaims(options.filter ?? {})
  return computeWorkload({
    claims: page.claims,
    // Se propaga tal cual: si la pagina venia recortada, los totales son un
    // suelo y quien los lea tiene que saberlo.
    truncated: page.truncated,
    ...(options.openIssues === undefined ? {} : { openIssues: options.openIssues }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}
