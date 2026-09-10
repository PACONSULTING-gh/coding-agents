import type { LlmEffort, LlmMessage, LlmPort, LlmTextBlock } from '@coord/core'

import {
  LEADING_SIGNALS,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  MIN_ROUTING_REASONING_LENGTH,
  parseRoutingSuggestion,
  type RoutingInput,
  type RoutingSuggestion,
} from './shortlist.js'

/**
 * El agente de routing (epic 03 / T02): sugiere a quien darle una tarea.
 *
 * ===========================================================================
 * SUGIERE. NUNCA ASIGNA.
 * ===========================================================================
 * No es una limitacion temporal de la v1: es `CLAUDE.md` §2.1. Por eso esta
 * funcion devuelve un shortlist y no tiene ni una linea que escriba en GitHub.
 * La confirmacion la hace un humano asignando el issue de la forma normal.
 *
 * ===========================================================================
 * EL ORDEN DEL RAZONAMIENTO ES LA DECISION DE DISEÑO DE TODO EL EPIC
 * ===========================================================================
 * Primero evidencia de skill, DESPUES carga. Si se invierte, el modelo coge el
 * atajo de "el que este mas libre" y la sugerencia deja de aportar nada que un
 * `ORDER BY carga` no diera ya — y para eso no hace falta un LLM.
 *
 * Por eso el procedimiento va numerado en el prompt Y el esquema de salida pide
 * el razonamiento ANTES que el puesto: si el puesto se generase primero, el
 * razonamiento seria una justificacion a posteriori de una decision ya tomada.
 *
 * ===========================================================================
 * OJO CON EL MODELO POR DEFECTO — ISSUE #27
 * ===========================================================================
 * `ROUTER_MODEL` es `claude-opus-5` porque es el modelo de produccion que fija
 * el PRD, pero MEDIDO el 10 de septiembre de 2026: por la ruta del CLI de
 * Claude Code, Opus 5 RECHAZA esta peticion con la categoria
 * `reasoning_extraction`, igual que la del Verifier. Y no es cosa de un prompt
 * concreto: son dos prompts sin una linea en comun, y lo unico que comparten es
 * pedir razonamiento estructurado con `effort: xhigh`.
 *
 * `claude-sonnet-5` responde con normalidad por esa misma ruta.
 *
 * HASTA EL ADR 0009 el argumento para dejar el defecto en Opus era que una
 * limitacion de la ruta de MEDICION no debe decidir el modelo de PRODUCCION.
 * ESE ARGUMENTO YA NO VALE: el CLI es la ruta de produccion, asi que esto no
 * es un tropiezo del instrumento sino que el modelo por defecto NO CONTESTA
 * por el camino que se despliega.
 *
 * Aun asi el defecto no se toca aqui, y por otra razon: elegir el modelo del
 * router es una decision de producto que toma un humano (`CLAUDE.md` §2.1), no
 * un efecto colateral de un cambio de documentacion. Las dos salidas son
 * arreglar el prompt o bajar el defecto a Sonnet diciendo por que. Se decide en
 * el issue #27, que deja de ser una curiosidad y pasa a bloquear.
 */

/** Modelo por defecto. Ver el aviso de arriba: hoy NO responde (issue #27). */
export const ROUTER_MODEL = 'claude-opus-5'

/**
 * El epic pide "extended thinking activado". `xhigh` es el mismo nivel que usa
 * el Verifier: es una decision de reparto de trabajo entre personas, y
 * equivocarse cuesta mas que los tokens que ahorra bajarlo.
 */
export const ROUTER_EFFORT: LlmEffort = 'xhigh'

const DEFAULT_MAX_OUTPUT_TOKENS = 8_000

const ROLE_PROMPT: string = [
  'Eres el agente ROUTER de una plataforma de coordinacion de equipos. Tu trabajo es',
  'SUGERIR a quien darle una tarea. NUNCA asignas: un humano confirma la sugerencia',
  'asignando el issue. Si algo de lo que escribes suena a decision tomada, esta mal.',
  '',
  '--- EL PROCEDIMIENTO, EN ESTE ORDEN ------------------------------------------',
  '  1. Mira que ficheros va a tocar la tarea.',
  '  2. Por cada candidato, di que evidencia de autoria tiene sobre ESOS ficheros,',
  '     citando rutas concretas de las que se te dan. Nada de "conoce el area".',
  '  3. SOLO ENTONCES mira la carga de trabajo.',
  '  4. Ordena.',
  '',
  'El orden importa y no es negociable. Si miras la carga antes que la evidencia,',
  'acabas sugiriendo "el que este mas libre", y para eso no hago falta yo: eso lo',
  'da una consulta ordenada por carga. La carga es un DESEMPATE entre gente que',
  'puede hacer la tarea, no el criterio principal.',
  '',
  '--- LAS CIFRAS QUE RECIBES ---------------------------------------------------',
  'De cada candidato se te dan sus lineas y commits sobre cada fichero, dentro de',
  'una ventana de historial reciente. MAS LINEAS ES MAS EVIDENCIA que mas commits:',
  'quien cambio una linea tres veces no conoce el fichero mejor que quien escribio',
  'cuatrocientas una vez.',
  '',
  'Si la carga de alguien viene marcada como INCOMPLETA, un cero NO significa que',
  'este libre: significa que no se ha podido saber. No lo trates como disponibilidad.',
  '',
  '--- PUEDES DECIR QUE NO HAY MATCH --------------------------------------------',
  'Si ningun candidato tiene evidencia real sobre lo que la tarea toca, responde',
  '`no_match` y explica por que. Es una respuesta VALIDA y esperada, no un fallo',
  'tuyo. Un router que siempre sugiere a alguien no esta razonando, esta rellenando,',
  'y la primera vez que alguien lo note dejara de leer las sugerencias para siempre.',
  '',
  '--- NO TE INVENTES NADA ------------------------------------------------------',
  'Solo puedes sugerir a candidatos de la lista que se te da, por su id EXACTO, y',
  'solo puedes citar rutas de fichero que aparezcan en la tarea o en las señales.',
  'Un fichero inventado es peor que ninguno: PARECE justificacion. Se comprueba',
  'automaticamente, y un shortlist con una cita inventada se rechaza entero.',
  '',
  '--- QUE TIENE QUE PODER LEER UN HUMANO ---------------------------------------',
  `Entre ${String(MIN_CANDIDATES)} y ${String(MAX_CANDIDATES)} candidatos. Con uno solo no hay a quien comparar; con mas de`,
  'cuatro, la lista deja de ser una sugerencia y pasa a ser el censo del equipo.',
  '',
  'De cada uno: el razonamiento (minimo una frase de verdad, no "encaja bien"), los',
  'ficheros que lo sostienen, y QUE SEÑAL condujo su posicion —`ownership`,',
  '`workload` o `both`—. Quien lo lea tiene que poder anular la sugerencia con',
  'criterio sin abrir el codigo.',
  `Un razonamiento de menos de ${String(MIN_ROUTING_REASONING_LENGTH)} caracteres se rechaza.`,
].join('\n')

/**
 * El esquema al que se le pide al modelo que se ciña.
 *
 * Vive aqui, con el prompt, y no con la validacion: es parte de lo que se le
 * PIDE al modelo, no de la defensa contra lo que responda. `shortlist.ts` tiene
 * que poder validar una respuesta venga de donde venga, incluso de un proveedor
 * que no acepte esquemas. (Es tambien donde lo tienen el Verifier y el
 * generador de tests.)
 *
 * Pedir salida estructurada NO exime de validar: lo que vuelve sigue siendo
 * texto generado por un modelo.
 */
export const ROUTING_OUTPUT_SCHEMA: Readonly<Record<string, unknown>> = {
  type: 'object',
  additionalProperties: false,
  required: ['outcome'],
  properties: {
    outcome: {
      type: 'string',
      enum: ['shortlist', 'no_match'],
      description: 'Usa `no_match` si ningun candidato encaja. Es una respuesta valida.',
    },
    noMatchReason: {
      type: 'string',
      description: 'Obligatorio con `no_match`: por que ninguno encaja.',
    },
    candidates: {
      type: 'array',
      description: `Entre ${String(MIN_CANDIDATES)} y ${String(MAX_CANDIDATES)} candidatos con \`shortlist\`.`,
      items: {
        type: 'object',
        additionalProperties: false,
        // El orden de las claves es el orden de generacion: primero el
        // razonamiento, despues la evidencia, y el puesto AL FINAL. Es
        // deliberado, igual que en el Verifier: si el puesto se generase
        // primero, el razonamiento seria una justificacion a posteriori.
        required: ['candidateId', 'reasoning', 'evidenceFiles', 'leadingSignal', 'rank'],
        properties: {
          candidateId: {
            type: 'string',
            description: 'Id EXACTO de la lista dada. No lo inventes.',
          },
          reasoning: {
            type: 'string',
            description: 'Por que este candidato, antes de decidir su puesto.',
          },
          evidenceFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Rutas EXACTAS de los ficheros que sostienen la sugerencia.',
          },
          leadingSignal: { type: 'string', enum: [...LEADING_SIGNALS] },
          rank: { type: 'number', description: '1 es el mas recomendado.' },
        },
      },
    },
  },
}

export interface SuggestAssigneesOptions {
  readonly model?: string
  readonly maxOutputTokens?: number
  readonly effort?: LlmEffort
}

/**
 * Pide un shortlist razonado.
 *
 * Los errores del proveedor NO se atrapan: se propagan con su tipo. Una
 * negativa del modelo (`LlmRefusalError`) tiene que llegar arriba tal cual —es
 * lo que hoy pasa con Opus 5, issue #27— y no disfrazada de "no hay match":
 * confundir "no he podido preguntar" con "no hay nadie que encaje" es la misma
 * clase de mentira que el epic 05 persigue.
 */
export async function suggestAssignees(
  llm: LlmPort,
  input: RoutingInput,
  options: SuggestAssigneesOptions = {},
): Promise<RoutingSuggestion> {
  const result = await llm.complete({
    model: options.model ?? ROUTER_MODEL,
    system: systemPrompt(),
    messages: [taskMessage(input)],
    maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    effort: options.effort ?? ROUTER_EFFORT,
    reasoning: 'on',
    outputSchema: { name: 'routing_shortlist', schema: ROUTING_OUTPUT_SCHEMA },
  })

  return parseRoutingSuggestion(result.structured, input)
}

function systemPrompt(): readonly LlmTextBlock[] {
  // Un solo bloque con el corte de cache: el rol no cambia entre tareas, asi
  // que es exactamente lo que interesa cachear.
  return [{ text: ROLE_PROMPT, cacheBreakpoint: true }]
}

/**
 * La tarea y las señales, en texto.
 *
 * Los candidatos van ORDENADOS POR ID, no por carga ni por evidencia. Es
 * deliberado: presentarlos ya ordenados por una señal ancla al modelo en ese
 * orden y convierte el ranking en "confirmar lo que le dimos hecho". Que el
 * orden sea alfabetico es lo mas parecido a no decir nada.
 */
export function taskMessage(input: RoutingInput): LlmMessage {
  const lineas = [
    `TAREA ${input.taskRef}: ${input.taskTitle}`,
    ...(input.taskBody === undefined ? [] : ['', input.taskBody]),
    '',
    'FICHEROS QUE VA A TOCAR:',
    ...(input.files.length === 0
      ? ['  (ninguno identificado: el grafo no sabe que toca esta tarea)']
      : input.files.map((f) => `  ${f}`)),
    '',
    'CANDIDATOS (en orden alfabetico de id, que no significa nada):',
  ]

  for (const candidato of [...input.candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    lineas.push(`- ${candidato.id} (${candidato.label})`)
    if (candidato.ownership.length === 0) {
      lineas.push('    evidencia: NINGUNA sobre los ficheros de esta tarea')
    } else {
      for (const o of [...candidato.ownership].sort((a, b) => b.lines - a.lines)) {
        lineas.push(
          `    evidencia: ${o.path} — ${String(o.lines)} lineas en ${String(o.commits)} commit(s)`,
        )
      }
    }
    lineas.push(
      candidato.workloadIsComplete
        ? `    carga: ${String(candidato.workload)} unidad(es) de trabajo en curso`
        : `    carga: ${String(candidato.workload)} en curso — INCOMPLETA, no se pudieron leer los issues abiertos`,
    )
  }

  return { role: 'user', content: lineas.join('\n') }
}
