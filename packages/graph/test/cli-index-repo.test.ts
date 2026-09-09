import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { parseArgs, UsageError } from '../src/cli/index-repo.js'

/**
 * El comando de indexado manual (`graph:index`). Aqui se prueba SOLO el parseo de
 * argumentos, que es puro y no necesita Postgres: la parte que habla con la base
 * es `indexRepository`, y esa la ejercita `apps/worker/test/graph-ingestion-job`
 * contra Postgres y git de verdad.
 *
 * Lo que se fija aqui es el contrato de la interfaz de usuario: que un error
 * frecuente diga QUE hacer, en vez de reventar con una traza.
 */

const TENANT = '11111111-2222-4333-8444-555555555555'
const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('parseArgs de graph:index', () => {
  it('exige --repo, y lo dice', () => {
    expect(() => parseArgs([], { GRAPH_TENANT_ID: TENANT })).toThrow(UsageError)
    expect(() => parseArgs([], { GRAPH_TENANT_ID: TENANT })).toThrow(/--repo/)
  })

  it('exige que --repo sea owner/nombre', () => {
    expect(() => parseArgs(['--repo', 'suelto'], { GRAPH_TENANT_ID: TENANT })).toThrow(
      /owner\/nombre/,
    )
  })

  it('exige tenant y explica por que no elige uno por su cuenta', () => {
    // Sin tenant no se puede escribir: la RLS lo exige. Un comando que eligiera
    // un tenant por defecto seria justo la clase de atajo que rompe el
    // aislamiento sin que nadie se entere.
    expect(() => parseArgs(['--repo', 'a/b'], {})).toThrow(/tenant/i)
  })

  it('rechaza un tenant que no es uuid', () => {
    expect(() => parseArgs(['--repo', 'a/b', '--tenant', 'no-soy-uuid'], {})).toThrow(/uuid/i)
  })

  it('cae a GRAPH_MCP_TENANT_ID, el mismo que usa el servidor MCP', () => {
    // Es deliberado: asi el grafo que escribe el comando es el que consulta el
    // agente, sin que nadie tenga que copiar ids.
    const args = parseArgs(['--repo', 'a/b'], { GRAPH_MCP_TENANT_ID: TENANT })
    expect(args.tenantId).toBe(TENANT)
  })

  it('--tenant gana sobre el entorno', () => {
    const otro = '99999999-2222-4333-8444-555555555555'
    const args = parseArgs(['--repo', 'a/b', '--tenant', otro], { GRAPH_TENANT_ID: TENANT })
    expect(args.tenantId).toBe(otro)
  })

  it('sin --path ni GRAPH_CHECKOUT_ROOT usa el directorio actual', () => {
    const args = parseArgs(['--repo', 'a/b'], { GRAPH_TENANT_ID: TENANT })
    expect(args.repoPath).toBe(process.cwd())
  })

  it('con GRAPH_CHECKOUT_ROOT compone <root>/<owner>/<nombre>', async () => {
    const root = await mkdtemp(join(tmpdir(), 'coord-cli-'))
    dirs.push(root)
    await mkdir(join(root, 'acme', 'demo'), { recursive: true })
    const args = parseArgs(['--repo', 'acme/demo'], {
      GRAPH_TENANT_ID: TENANT,
      GRAPH_CHECKOUT_ROOT: root,
    })
    expect(args.repoPath).toBe(join(root, 'acme', 'demo'))
  })

  it('una bandera sin valor no se traga la siguiente', () => {
    // `--path --json` no puede interpretarse como "el path es --json".
    expect(() =>
      parseArgs(['--repo', 'a/b', '--path', '--json'], { GRAPH_TENANT_ID: TENANT }),
    ).toThrow(/--path/)
  })
})
