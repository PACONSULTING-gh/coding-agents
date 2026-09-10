import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import {
  ConflictError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  runWithTenant,
  type Claim,
  type QueuePort,
} from '@coord/core'
import { closeDatabase, configureDatabase, withTenantConnection } from '@coord/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  CLAIMS_PURGE_QUEUE,
  ClaimConflictError,
  DEFAULT_CLAIMS_PURGE_CRON,
  activeClaims,
  checkOverlap,
  claim,
  purgeExpiredClaims,
  release,
  renew,
  registerClaimsPurgeProcessor,
  scheduleClaimsPurge,
} from '../src/claims.js'

import { startDatabase, type StartedDatabase } from './support/database.js'
import {
  approveIssueCriteria,
  createEdges,
  createFileNodes,
  createTenant,
} from './support/fixtures.js'

/**
 * Criterios de aceptacion de T04 (epic 02), contra Postgres DE VERDAD. Nada
 * mockeado: lo que se comprueba —que dos transacciones simultaneas no puedan
 * quedarse el mismo issue, que un arriendo caduque solo, y que no quede ningun
 * advisory lock retenido entre transacciones— es comportamiento del motor, y un
 * doble solo demostraria que el doble hace lo que le hemos dicho (CLAUDE.md 5).
 *
 *   1. Carrera real: N intentos simultaneos, gana exactamente uno.
 *   2. Caducidad sin purga.
 *   3. Solape de ficheros, con quien y desde cuando.
 *   4. `pg_locks`: no queda ningun advisory lock retenido.
 *   5. Renovacion: el dueno si, otro no.
 */

let db: StartedDatabase

beforeAll(async () => {
  db = await startDatabase()
  // Holgado a proposito: la carrera del bloque 1 necesita 10 conexiones a la
  // vez. Con un pool mas pequeno los intentos se serializarian en el pool y el
  // test pasaria sin haber probado ninguna concurrencia real.
  configureDatabase({ connectionString: db.runtimeUrl, max: 16, allowExitOnIdle: true })
}, 300_000)

afterAll(async () => {
  await closeDatabase()
  await db?.stop()
})

interface Actor {
  readonly id: string
  readonly label: string
}

function actor(label: string): Actor {
  return { id: randomUUID(), label }
}

/** Ejecuta como ese actor. La identidad del llamante sale del contexto, no de un parametro. */
async function as<T>(tenantId: string, who: Actor, fn: () => Promise<T>): Promise<T> {
  return runWithTenant({ tenantId, actorId: who.id }, fn)
}

/** SQL suelto dentro del contexto de tenant, por la misma via que usa el producto. */
async function sql<R extends Record<string, unknown>>(
  tenantId: string,
  text: string,
  values: readonly unknown[],
): Promise<R[]> {
  return runWithTenant({ tenantId }, () =>
    withTenantConnection(async (tx) => {
      const result = await tx.query(text, values)
      return result.rows as unknown as R[]
    }),
  )
}

/**
 * Empuja el arriendo al pasado. Se mueven `claimed_at` Y `expires_at`: un claim
 * que empezo hace dos horas y vencio hace una. Manipular la fila es mas honesto
 * que dormir de verdad —el resultado es el mismo y el test no depende del reloj
 * de la maquina— y en el bloque 2 hay ademas una caducidad real de 1 s.
 */
async function backdate(tenantId: string, groupId: string, hoursAgo: number): Promise<void> {
  await sql(
    tenantId,
    `UPDATE claims
        SET claimed_at = now() - ($2::int * interval '1 hour'),
            expires_at = now() - (($2::int - 1) * interval '1 hour')
      WHERE tenant_id = $1 AND claim_group_id = $3`,
    [tenantId, hoursAgo, groupId],
  )
}

async function countAdvisoryLocks(tenantId: string): Promise<number> {
  const rows = await sql<{ total: string }>(
    tenantId,
    `SELECT count(*)::text AS total FROM pg_locks WHERE locktype = 'advisory'`,
    [],
  )
  return Number(rows[0]?.total ?? '-1')
}

// ===========================================================================
describe('1. carrera: dos (o diez) intentos simultaneos y solo uno gana', () => {
  let tenantId: string
  let repoId: string

  beforeAll(async () => {
    tenantId = await createTenant('carrera')
    repoId = randomUUID()
    // T01 del epic 05: un issue sin criterios aprobados no se puede reclamar.
    // Estos tests van de otra cosa (la carrera), asi que se abre la puerta y ya.
    await approveIssueCriteria(
      tenantId,
      Array.from({ length: 5 }, (_unused, index) => String(1001 + index)),
    )
  })

  /**
   * Una carrera que sale bien una vez no demuestra nada: el entrelazado que
   * rompe una implementacion mal hecha aparece pocas veces de cada muchas. Se
   * repite, con un issue distinto cada vuelta.
   */
  const RONDAS = 5
  const CONTENDIENTES = 10

  for (let ronda = 1; ronda <= RONDAS; ronda += 1) {
    it(`ronda ${String(ronda)}: ${String(CONTENDIENTES)} intentos a la vez, gana exactamente uno`, async () => {
      const issue = String(1000 + ronda)
      const contendientes = Array.from({ length: CONTENDIENTES }, (_unused, index) =>
        actor(`Agente ${String(index)}`),
      )

      // Promise.all sobre conexiones distintas: es una carrera de verdad, no
      // diez llamadas en fila.
      const resultados = await Promise.allSettled(
        contendientes.map((who) =>
          as(tenantId, who, () =>
            claim({
              repoId,
              subject: { kind: 'issue', key: issue },
              holder: { kind: 'agent', id: who.id, label: who.label },
              ttlSeconds: 600,
            }),
          ),
        ),
      )

      const ganadores = resultados.filter((result) => result.status === 'fulfilled')
      const perdedores = resultados.filter((result) => result.status === 'rejected')

      expect(ganadores).toHaveLength(1)
      expect(perdedores).toHaveLength(CONTENDIENTES - 1)

      const ganador = ganadores[0]
      if (ganador === undefined || ganador.status !== 'fulfilled') {
        throw new Error('No hubo ganador y el assert anterior deberia haberlo dicho.')
      }
      const etiquetaGanadora = ganador.value.holder.label

      for (const perdedor of perdedores) {
        if (perdedor.status !== 'rejected') throw new Error('Imposible: ya esta filtrado.')
        const error: unknown = perdedor.reason
        // El rechazo no es un booleano: dice QUIEN lo tiene y DESDE CUANDO.
        expect(error).toBeInstanceOf(ClaimConflictError)
        expect(error).toBeInstanceOf(ConflictError)
        if (!(error instanceof ClaimConflictError)) throw new Error('no alcanzable')

        // Exactamente un conflicto, y con detalle: si el advisory lock no
        // serializara, el perdedor chocaria contra el indice unico y llegaria
        // aqui con `conflicts` vacio. Este assert es el que lo detecta.
        expect(error.conflicts).toHaveLength(1)
        const conflicto = error.conflicts[0]
        if (conflicto === undefined) throw new Error('no alcanzable')
        expect(conflicto.holder.label).toBe(etiquetaGanadora)
        expect(conflicto.subject).toEqual({ kind: 'issue', key: issue })
        expect(conflicto.claimedAt).toBeInstanceOf(Date)
        expect(error.message).toContain(etiquetaGanadora)
        expect(error.message).toContain(`#${issue}`)
      }

      // Y en la base queda UNA sola reserva viva de ese issue.
      const vivos = await runWithTenant({ tenantId }, () =>
        activeClaims({ repoId, subjectKind: 'issue', subjectKeys: [issue] }),
      )
      expect(vivos.claims).toHaveLength(1)
      expect(vivos.truncated).toBe(false)
      expect(vivos.claims[0]?.holder.label).toBe(etiquetaGanadora)
    })
  }

  it('otro tenant puede reclamar el mismo issue del mismo repo', async () => {
    const otroTenant = await createTenant('carrera-vecina')
    await approveIssueCriteria(otroTenant, ['1001'])
    const ana = actor('Ana')
    const lease = await as(otroTenant, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '1001' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 60,
      }),
    )
    expect(lease.claims).toHaveLength(1)

    const vistoDesdeElVecino = await runWithTenant({ tenantId: otroTenant }, () =>
      activeClaims({ repoId }),
    )
    expect(vistoDesdeElVecino.claims.map((row) => row.holder.label)).toEqual(['Ana'])
  })
})

// ===========================================================================
describe('2. caducidad: el claim se libera solo, sin que corra ninguna purga', () => {
  let tenantId: string
  let repoId: string

  beforeAll(async () => {
    tenantId = await createTenant('caducidad')
    repoId = randomUUID()
    await approveIssueCriteria(tenantId, ['77', '78', '79', '80'])
  })

  it('tras vencer el TTL otro puede reclamarlo, y la fila vieja sigue en la tabla', async () => {
    const ana = actor('Ana Perez')
    const bruno = actor('Bruno Diaz')

    const deAna = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '77' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 3600,
      }),
    )

    // Mientras esta vivo, Bruno choca.
    await expect(
      as(tenantId, bruno, () =>
        claim({
          repoId,
          subject: { kind: 'issue', key: '77' },
          holder: { kind: 'user', id: bruno.id, label: bruno.label },
          ttlSeconds: 60,
        }),
      ),
    ).rejects.toBeInstanceOf(ClaimConflictError)

    // El agente de Ana muere: nadie libera nada, solo pasa el tiempo.
    await backdate(tenantId, deAna.groupId, 2)

    // Deja de contar como vivo SIN que haya corrido ninguna purga.
    const vivos = await runWithTenant({ tenantId }, () => activeClaims({ repoId }))
    expect(vivos.claims).toHaveLength(0)

    // Y la fila sigue ahi: nadie la ha borrado. Es la prueba de que la
    // correccion no depende de ningun proceso de limpieza.
    const filas = await sql<{ total: string }>(
      tenantId,
      `SELECT count(*)::text AS total FROM claims WHERE tenant_id = $1 AND claim_group_id = $2`,
      [tenantId, deAna.groupId],
    )
    expect(filas[0]?.total).toBe('1')

    const deBruno = await as(tenantId, bruno, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '77' },
        holder: { kind: 'user', id: bruno.id, label: bruno.label },
        ttlSeconds: 60,
      }),
    )
    expect(deBruno.holder.label).toBe('Bruno Diaz')
  })

  it('con un TTL real de 1 segundo, el reloj basta (sin tocar ninguna fila)', async () => {
    const ana = actor('Ana efimera')
    const bruno = actor('Bruno paciente')

    await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '78' },
        holder: { kind: 'agent', id: ana.id, label: ana.label },
        ttlSeconds: 1,
      }),
    )

    await sleep(1_200)

    const deBruno = await as(tenantId, bruno, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '78' },
        holder: { kind: 'agent', id: bruno.id, label: bruno.label },
        ttlSeconds: 60,
      }),
    )
    expect(deBruno.holder.label).toBe('Bruno paciente')
  })

  it('la purga solo recorta el historico, y respeta lo vivo', async () => {
    const ana = actor('Ana historica')
    const viejo = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '79' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 60,
      }),
    )
    await backdate(tenantId, viejo.groupId, 24 * 40)

    const vivo = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '80' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 600,
      }),
    )

    const borrados = await runWithTenant({ tenantId }, () =>
      purgeExpiredClaims({ retentionDays: 30 }),
    )
    expect(borrados).toBe(1)

    const quedan = await sql<{ claim_group_id: string }>(
      tenantId,
      'SELECT claim_group_id FROM claims WHERE tenant_id = $1 AND subject_key IN ($2, $3)',
      [tenantId, '79', '80'],
    )
    expect(quedan.map((row) => row.claim_group_id)).toEqual([vivo.groupId])
  })
})

// ===========================================================================
describe('3. solape de ficheros: quien lo tiene y desde cuando', () => {
  let tenantId: string
  let repoId: string
  let ana: Actor
  let bruno: Actor
  let deAna: { groupId: string; claimedAt: Date }

  beforeAll(async () => {
    tenantId = await createTenant('solape')
    repoId = randomUUID()
    await approveIssueCriteria(tenantId, ['200', '201'])
    ana = actor('Ana Perez')
    bruno = actor('Bruno Diaz')

    // Grafo: `src/consumer.ts` importa `src/core.ts`. Ana reclama el core.
    const nodes = await createFileNodes(tenantId, repoId, [
      'src/core.ts',
      'src/consumer.ts',
      'src/lejano.ts',
    ])
    const id = (path: string): string => {
      const value = nodes.get(path)
      if (value === undefined) throw new Error(`Falta el nodo ${path}`)
      return value
    }
    await createEdges(tenantId, repoId, [{ from: id('src/consumer.ts'), to: id('src/core.ts') }])

    const lease = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '200' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 3600,
        files: ['src/core.ts'],
      }),
    )
    deAna = { groupId: lease.groupId, claimedAt: lease.claimedAt }
  })

  it('un claim con ficheros crea una fila por sujeto, todas del mismo grupo', async () => {
    const vivos = await runWithTenant({ tenantId }, () => activeClaims({ repoId }))
    expect(vivos.claims.map((row) => `${row.subject.kind}:${row.subject.key}`).sort()).toEqual([
      'file:src/core.ts',
      'issue:200',
    ])
    expect(new Set(vivos.claims.map((row) => row.groupId))).toEqual(new Set([deAna.groupId]))
  })

  it('reclamar un fichero solapado se rechaza diciendo quien lo tiene y desde cuando', async () => {
    const error = await as(tenantId, bruno, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '201' },
        holder: { kind: 'user', id: bruno.id, label: bruno.label },
        ttlSeconds: 600,
        files: ['src/core.ts'],
      }),
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ClaimConflictError)
    if (!(error instanceof ClaimConflictError)) throw new Error('no alcanzable')
    expect(error.conflicts).toHaveLength(1)
    const conflicto = error.conflicts[0]
    if (conflicto === undefined) throw new Error('no alcanzable')
    expect(conflicto.holder.label).toBe('Ana Perez')
    expect(conflicto.subject).toEqual({ kind: 'file', key: 'src/core.ts' })
    expect(conflicto.claimedAt.getTime()).toBe(deAna.claimedAt.getTime())
    expect(error.message).toContain('Ana Perez')
    expect(error.message).toContain('src/core.ts')

    // Y no se ha reservado NADA: el claim es atomico sobre todos sus sujetos.
    const vivos = await runWithTenant({ tenantId }, () =>
      activeClaims({ repoId, subjectKind: 'issue', subjectKeys: ['201'] }),
    )
    expect(vivos.claims).toEqual([])
  })

  it('checkOverlap avisa del solape EXACTO con quien y desde cuando', async () => {
    const resultado = await runWithTenant({ tenantId }, () =>
      checkOverlap({ repoId, files: ['src/core.ts'], excludeHolderId: bruno.id }),
    )
    expect(resultado.conflicts).toHaveLength(1)
    const conflicto = resultado.conflicts[0]
    if (conflicto === undefined) throw new Error('no alcanzable')
    expect(conflicto.signal).toBe('exact')
    expect(conflicto.distance).toBe(0)
    expect(conflicto.holder.label).toBe('Ana Perez')
    expect(conflicto.claimedAt.getTime()).toBe(deAna.claimedAt.getTime())
    expect(resultado.graphProbeTruncated).toBe(false)
  })

  it('checkOverlap avisa tambien por VECINDAD en el grafo, no solo por ruta exacta', async () => {
    // `src/consumer.ts` no lo tiene nadie, pero depende de `src/core.ts`, que si.
    const resultado = await runWithTenant({ tenantId }, () =>
      checkOverlap({ repoId, files: ['src/consumer.ts'] }),
    )
    expect(resultado.conflicts).toHaveLength(1)
    const conflicto = resultado.conflicts[0]
    if (conflicto === undefined) throw new Error('no alcanzable')
    expect(conflicto.signal).toBe('graph')
    expect(conflicto.subject).toEqual({ kind: 'file', key: 'src/core.ts' })
    expect(conflicto.relatedFiles).toEqual(['src/consumer.ts'])
    expect(conflicto.distance).toBe(1)
    expect(conflicto.holder.label).toBe('Ana Perez')
  })

  it('un fichero sin ninguna relacion en el grafo no genera aviso', async () => {
    const resultado = await runWithTenant({ tenantId }, () =>
      checkOverlap({ repoId, files: ['src/lejano.ts'] }),
    )
    expect(resultado.conflicts).toEqual([])
  })

  it('apagar la vecindad deja solo el criterio literal', async () => {
    const resultado = await runWithTenant({ tenantId }, () =>
      checkOverlap({
        repoId,
        files: ['src/consumer.ts'],
        includeGraphNeighbourhood: false,
      }),
    )
    expect(resultado.conflicts).toEqual([])
  })

  it('liberar el issue libera tambien sus ficheros: no quedan cabos sueltos', async () => {
    const liberadas = await as(tenantId, ana, () => release(deAna.groupId))
    expect(liberadas).toHaveLength(2)
    expect(liberadas.every((row) => row.releasedReason === 'released')).toBe(true)

    const vivos = await runWithTenant({ tenantId }, () => activeClaims({ repoId }))
    expect(vivos.claims).toEqual([])

    // Y ahora Bruno si puede.
    const deBruno = await as(tenantId, bruno, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '201' },
        holder: { kind: 'user', id: bruno.id, label: bruno.label },
        ttlSeconds: 600,
        files: ['src/core.ts'],
      }),
    )
    expect(deBruno.claims).toHaveLength(2)
    await as(tenantId, bruno, () => release(deBruno.groupId))
  })
})

// ===========================================================================
describe('4. pg_locks: no queda ningun advisory lock retenido entre transacciones', () => {
  let tenantId: string
  let repoId: string

  beforeAll(async () => {
    tenantId = await createTenant('locks')
    repoId = randomUUID()
    await approveIssueCriteria(
      tenantId,
      Array.from({ length: 100 }, (_unused, index) => String(500 + index)),
    )
  })

  it('el contador de pg_locks sabe ver un advisory lock en vuelo (control)', async () => {
    // Sin este control, el assert de abajo ("cero locks") podria pasar
    // simplemente porque la consulta esta mal escrita y nunca ve nada.
    let abrir: () => void = () => undefined
    const puerta = new Promise<void>((resolve) => {
      abrir = resolve
    })

    const enVuelo = runWithTenant({ tenantId }, () =>
      withTenantConnection(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['control'])
        await puerta
      }),
    )

    // Espera activa acotada: la transaccion de arriba corre en otra conexion.
    let durante = 0
    for (let intento = 0; intento < 50 && durante === 0; intento += 1) {
      await sleep(20)
      durante = await countAdvisoryLocks(tenantId)
    }
    abrir()
    await enVuelo

    expect(durante).toBeGreaterThan(0)
  })

  /**
   * POR QUE EL NUMERO NO ES LO QUE HACE VALER ESTE TEST.
   *
   * El criterio dice "el sistema con MUCHOS claims activos". Lo que de verdad
   * garantiza que no haya agotamiento de memoria compartida NO es el tamano de
   * la muestra: es que el unico lock que se toma es `pg_advisory_xact_lock`, que
   * Postgres suelta en el COMMIT. Por construccion, el numero de locks retenidos
   * entre transacciones es CERO con 12 claims y con 12 millones — no hay ningun
   * numero a partir del cual empiece a acumularse.
   *
   * Lo que si hace falta es que el contador sepa ver locks en vuelo, y eso lo
   * demuestra el control positivo del test anterior. El numero de aqui se sube a
   * varios cientos de filas porque es barato y porque "muchos" en el enunciado
   * significa algo, no porque el resultado dependa de el.
   */
  it('con muchos claims activos no queda ni un advisory lock retenido', async () => {
    const titulares = Array.from({ length: 100 }, (_unused, index) =>
      actor(`Agente ${String(index)}`),
    )
    await Promise.all(
      titulares.map((who, index) =>
        as(tenantId, who, () =>
          claim({
            repoId,
            subject: { kind: 'issue', key: String(500 + index) },
            holder: { kind: 'agent', id: who.id, label: who.label },
            ttlSeconds: 3600,
            files: [`src/m${String(index)}.ts`, `src/n${String(index)}.ts`],
          }),
        ),
      ),
    )

    const vivos = await runWithTenant({ tenantId }, () => activeClaims({ repoId, limit: 1000 }))
    // Control: si no hubiera claims, "cero locks" no probaria nada.
    expect(vivos.claims).toHaveLength(100 * 3)
    expect(vivos.truncated).toBe(false)

    expect(await countAdvisoryLocks(tenantId)).toBe(0)
  })
})

// ===========================================================================
describe('5. renovacion: el dueno si, otro no', () => {
  let tenantId: string
  let repoId: string
  let ana: Actor
  let bruno: Actor

  beforeAll(async () => {
    tenantId = await createTenant('renovacion')
    repoId = randomUUID()
    await approveIssueCriteria(tenantId, ['300', '301', '302', '303', '304'])
    ana = actor('Ana Perez')
    bruno = actor('Bruno Diaz')
  })

  async function claimDeAna(issue: string, ttlSeconds: number): Promise<Claim> {
    const lease = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: issue },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds,
      }),
    )
    const principal = lease.claims[0]
    if (principal === undefined) throw new Error('no alcanzable')
    return principal
  }

  it('el dueno renueva y el vencimiento se va hacia adelante', async () => {
    const antes = await claimDeAna('300', 60)
    const renovados = await as(tenantId, ana, () => renew(antes.claimId, 3600))
    expect(renovados).toHaveLength(1)
    const despues = renovados[0]
    if (despues === undefined) throw new Error('no alcanzable')
    expect(despues.expiresAt.getTime()).toBeGreaterThan(antes.expiresAt.getTime())
    expect(despues.claimedAt.getTime()).toBe(antes.claimedAt.getTime())
  })

  it('otro NO puede renovar el claim ajeno, y el vencimiento no se mueve', async () => {
    const deAna = await claimDeAna('301', 60)

    await expect(as(tenantId, bruno, () => renew(deAna.claimId, 3600))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )

    const vivos = await runWithTenant({ tenantId }, () =>
      activeClaims({ repoId, subjectKind: 'issue', subjectKeys: ['301'] }),
    )
    expect(vivos.claims[0]?.expiresAt.getTime()).toBe(deAna.expiresAt.getTime())
  })

  it('otro NO puede liberar el claim ajeno', async () => {
    const deAna = await claimDeAna('302', 600)
    await expect(as(tenantId, bruno, () => release(deAna.claimId))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
    const vivos = await runWithTenant({ tenantId }, () =>
      activeClaims({ repoId, subjectKind: 'issue', subjectKeys: ['302'] }),
    )
    expect(vivos.claims).toHaveLength(1)
  })

  it('un claim ya caducado no se renueva: se vuelve a reclamar', async () => {
    const deAna = await claimDeAna('303', 600)
    await backdate(tenantId, deAna.groupId, 2)

    const error = await as(tenantId, ana, () => renew(deAna.claimId, 600)).catch(
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ConflictError)
    expect(error).not.toBeInstanceOf(ClaimConflictError)
  })

  it('renovar o liberar algo que no existe es NotFoundError', async () => {
    await expect(as(tenantId, ana, () => renew(randomUUID(), 60))).rejects.toBeInstanceOf(
      NotFoundError,
    )
    await expect(as(tenantId, ana, () => release(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundError,
    )
  })

  it('liberar dos veces es idempotente', async () => {
    const deAna = await claimDeAna('304', 600)
    const primera = await as(tenantId, ana, () => release(deAna.claimId))
    const segunda = await as(tenantId, ana, () => release(deAna.claimId))
    expect(primera[0]?.releasedAt?.getTime()).toBe(segunda[0]?.releasedAt?.getTime())
  })
})

// ===========================================================================
describe('6. fronteras de confianza y programacion de la purga', () => {
  let tenantId: string
  let repoId: string
  let ana: Actor

  beforeAll(async () => {
    tenantId = await createTenant('fronteras')
    repoId = randomUUID()
    // Solo el '81', que es el unico claim de este bloque que llega a la base de
    // datos: los demas se rechazan por validacion antes de tocarla.
    await approveIssueCriteria(tenantId, ['81'])
    ana = actor('Ana Perez')
  })

  it('una ruta absoluta o con `..` se rechaza antes de tocar la base de datos', async () => {
    for (const ruta of ['/etc/passwd', '../../.ssh/id_rsa', 'src/../../fuera.ts']) {
      await expect(
        as(tenantId, ana, () =>
          claim({
            repoId,
            subject: { kind: 'file', key: ruta },
            holder: { kind: 'user', id: ana.id, label: ana.label },
            ttlSeconds: 60,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('no se puede reclamar en nombre de otro', async () => {
    await expect(
      as(tenantId, ana, () =>
        claim({
          repoId,
          subject: { kind: 'issue', key: '400' },
          holder: { kind: 'user', id: randomUUID(), label: 'Otro cualquiera' },
          ttlSeconds: 60,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('sin actor en el contexto, reclamar falla en voz alta', async () => {
    await expect(
      runWithTenant({ tenantId }, () =>
        claim({
          repoId,
          subject: { kind: 'issue', key: '401' },
          holder: { kind: 'user', id: ana.id, label: ana.label },
          ttlSeconds: 60,
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('un TTL fuera de rango se rechaza', async () => {
    for (const ttlSeconds of [0, -1, 25 * 60 * 60]) {
      await expect(
        as(tenantId, ana, () =>
          claim({
            repoId,
            subject: { kind: 'issue', key: '402' },
            holder: { kind: 'user', id: ana.id, label: ana.label },
            ttlSeconds,
          }),
        ),
      ).rejects.toBeInstanceOf(ValidationError)
    }
  })

  it('la purga se programa por el QueuePort que ya existe, no por un cron propio', async () => {
    const programados: { name: string; cron: string; payload: unknown }[] = []
    const cola: QueuePort = {
      enqueue: () => Promise.resolve(randomUUID()),
      process: () => Promise.resolve(),
      schedule: (name, cron, payload) => {
        programados.push({ name, cron, payload })
        return Promise.resolve()
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    }

    await runWithTenant({ tenantId }, () => scheduleClaimsPurge(cola))

    expect(programados).toEqual([
      { name: CLAIMS_PURGE_QUEUE, cron: DEFAULT_CLAIMS_PURGE_CRON, payload: { retentionDays: 30 } },
    ])
  })

  /**
   * El PROCESADOR, no solo la programacion. Antes solo se probaba
   * `scheduleClaimsPurge` contra un doble del `QueuePort`, asi que el handler
   * que hay dentro de `queue.process` —incluida la validacion del payload— no lo
   * ejecutaba nadie en ningun test. Aqui se captura el handler que registra el
   * producto y se ejecuta de verdad contra Postgres.
   */
  it('el procesador registrado purga de verdad, y valida su payload', async () => {
    let registrado: ((job: { payload: unknown }) => Promise<void>) | undefined
    const cola = {
      enqueue: () => Promise.resolve(randomUUID()),
      process: (name: string, handler: (job: { payload: unknown }) => Promise<void>) => {
        expect(name).toBe(CLAIMS_PURGE_QUEUE)
        registrado = handler
        return Promise.resolve()
      },
      schedule: () => Promise.resolve(),
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    } as unknown as QueuePort

    await registerClaimsPurgeProcessor(cola)
    const procesar = registrado
    if (procesar === undefined) throw new Error('registerClaimsPurgeProcessor no registro nada')

    const ana = actor('Ana purgada por el procesador')
    const viejo = await as(tenantId, ana, () =>
      claim({
        repoId,
        subject: { kind: 'issue', key: '81' },
        holder: { kind: 'user', id: ana.id, label: ana.label },
        ttlSeconds: 60,
      }),
    )
    await backdate(tenantId, viejo.groupId, 24 * 40)

    // Payload invalido: falla en voz alta, y NO borra nada.
    await expect(
      runWithTenant({ tenantId }, () => procesar({ payload: { retentionDays: -5 } })),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(
      await sql(tenantId, 'SELECT id FROM claims WHERE tenant_id = $1 AND subject_key = $2', [
        tenantId,
        '81',
      ]),
    ).toHaveLength(1)

    // Payload vacio: usa la retencion por defecto (30 dias) y borra el viejo.
    await runWithTenant({ tenantId }, () => procesar({ payload: null }))
    expect(
      await sql(tenantId, 'SELECT id FROM claims WHERE tenant_id = $1 AND subject_key = $2', [
        tenantId,
        '81',
      ]),
    ).toEqual([])
  })
})
