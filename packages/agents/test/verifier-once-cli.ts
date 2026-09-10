/**
 * Una sola verificacion real contra `claude-opus-5`, para el issue #27.
 * Imprime `respondio` o la categoria del rechazo. Nada mas.
 *
 * Se usa para confirmar sobre el Verifier DE VERDAD lo que la sonda minima de
 * `refusal-probe-cli.ts` encontro en miniatura. No se commitea ningun cambio
 * del prompt: se edita, se mide y se revierte con `git checkout`.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LlmRefusalError } from '@coord/core'

import { ClaudeCliLlm } from '../src/claude-cli.js'
import { verifyChanges } from '../src/verification/verifier.js'

import { TRAP_CASES } from './fixtures/trampas/index.js'

const trampa = TRAP_CASES[0]
if (trampa === undefined) throw new Error('No hay casos de trampa cargados.')

const cwd = await mkdtemp(join(tmpdir(), 'verifier-once-'))
const llm = new ClaudeCliLlm({ cwd })

const etiqueta = process.argv[2] ?? 'sin-etiqueta'
for (let i = 0; i < 2; i += 1) {
  try {
    await verifyChanges(llm, trampa.input, { model: 'claude-opus-5' })
    process.stdout.write(`${etiqueta} #${String(i + 1)}: respondio\n`)
  } catch (error) {
    if (error instanceof LlmRefusalError) {
      process.stdout.write(`${etiqueta} #${String(i + 1)}: rechazo (${error.category ?? '?'})\n`)
    } else {
      process.stdout.write(
        `${etiqueta} #${String(i + 1)}: otro-error ${error instanceof Error ? error.message.slice(0, 120) : String(error)}\n`,
      )
    }
  }
}
