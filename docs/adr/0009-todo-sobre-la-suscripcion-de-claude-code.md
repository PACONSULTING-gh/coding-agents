# ADR 0009 — También el router y el Verifier corren sobre la suscripción, no sobre API de pago por token

**Estado:** Aceptada · **Fecha:** 10 de septiembre de 2026

**Revisa:** la restricción de coste del PRD (`.claude/prds/plataforma-coordinacion.md`, §5).

## Contexto

El PRD §5 decía, literalmente:

> **Coste:** debe correr sobre suscripciones ya pagadas de los agentes de código,
> no sobre API de pago por token **para la generación de código**. Las llamadas
> propias de la plataforma (router, verifier) **sí van por API** y hay que
> presupuestarlas.

Esa segunda frase se escribió **antes de construir nada**, y desde entonces hay
cosas medidas que no se sabían.

### Lo que se sabe ahora y no se sabía entonces

1. **La ruta de CLI funciona y está probada.** `packages/agents/src/claude-cli.ts`
   implementa el mismo `LlmPort` sobre `claude --print --output-format json`.
   **La única medida real del Verifier que existe salió por ahí**: 0 de 6 trampas
   aprobadas y 0 de 1 casos limpios bloqueados, con `claude-sonnet-5`.

2. **El aislamiento se puede construir, y se construyó.** Verificado
   preguntándole al modelo que enumere sus herramientas: responde `NINGUNA`. Hizo
   falta más de lo que parecía —bloquear `Task`, `Agent`, `Workflow` y `Skill`
   además del sistema de ficheros, y sobre todo `--strict-mcp-config`, porque sin
   él los servidores MCP del usuario se cargan igual y el modelo respondía que
   podía leer ficheros de Google Drive—.

3. **El CLI también devuelve el consumo por llamada.** `input_tokens`,
   `output_tokens`, `cache_read_input_tokens` y `total_cost_usd` por modelo. El
   "hay que presupuestarlas" del PRD se puede cumplir por las dos vías: ese
   argumento a favor de la API no era tal.

4. **La salida estructurada importa menos de lo que parecía.** El Verifier trata
   la respuesta del modelo como **frontera de confianza** y la valida con zod
   pase lo que pase. El esquema del proveedor ahorra reintentos, no correcciones.

### El argumento que decide

**"Una suscripción o dos" no es la elección real.** El Verifier tiene que correr
sobre _alguna_ cuenta:

- Sobre la del desarrollador, y entonces la plataforma **compite por sus límites**
  con su propio trabajo.
- Sobre una cuenta aparte, y entonces **ya son dos suscripciones**, solo que de
  tarifa plana y límites opacos en vez de una clave con consumo medido.

Así que la pregunta no era cuántas cosas se pagan, sino **qué es la segunda**. Y
la respuesta, hoy, es: **ninguna**. Un equipo de tres personas a tiempo parcial
no necesita una segunda relación de facturación, una segunda forma de pago y un
segundo sitio que vigilar para un producto que todavía no tiene ni un cliente.

Eso no es comodidad: es `CLAUDE.md` §4. La ruta de API estaba justificada por un
cliente que **no existe**, y montarla ya es exactamente la sobre-ingeniería que
esa sección rechaza.

## Decisión

**Todo corre sobre la suscripción de Claude Code (Max/Pro), incluidas las
llamadas propias de la plataforma.** El adaptador de CLI
(`packages/agents/src/claude-cli.ts`) pasa a ser **la ruta de producción** del
router y del Verifier.

El adaptador de API (`packages/agents/src/anthropic.ts`) **no se borra**: se
queda como implementación alternativa de `LlmPort`, escrita y probada, para el
día que se dispare alguno de los disparadores de abajo. Cambiar de ruta es
cambiar qué se inyecta en la raíz de composición.

## Consecuencias

**Lo que se gana:**

- Una sola relación de facturación y una sola cosa que vigilar.
- Coste marginal cero por verificación, en vez de una factura que crece con el
  uso justo cuando el producto empieza a usarse.
- La ruta que se despliega es **la que ya está medida**. La de API no se ha
  ejercitado nunca contra el servicio real.

**Lo que se acepta, y hay que decirlo en voz alta:**

- **El aislamiento del Verifier pasa de ser una propiedad del transporte a una
  lista de banderas.** Contra la API, un `POST /v1/messages` sin herramientas no
  puede leer un fichero: es un hecho. Por CLI es `BLOCKED_TOOLS` + flags contra
  una superficie que Claude Code **cambia entre versiones**. El primer criterio
  de aceptación de T04 (epic 05) depende ahora de mantener esa lista al día.
  **Es el precio principal de este ADR.**
- **La plataforma compite por los límites de la suscripción** con el trabajo de
  las personas. Un día con muchas verificaciones a `xhigh` resta capacidad.
- **Peaje fijo por llamada.** Claude Code manda su system prompt entero: una
  sonda para responder `OK` movió 15,5K tokens de escritura de cache. No se paga
  en factura, se paga en límites.
- **Sin atribución de coste por tenant.** Una suscripción no dice qué cliente
  consumió qué. Mientras no haya clientes, da igual.

**Lo que hay que vigilar:** que `BLOCKED_TOOLS` no se quede atrás. Una
herramienta nueva de Claude Code que no esté en esa lista degrada el aislamiento
**en silencio**, y el silencio es el modo de fallo que este proyecto entero
existe para evitar. Conviene una comprobación periódica que le pregunte al modelo
qué herramientas tiene y falle si no responde `NINGUNA`.

## Disparadores para reconsiderarlo

Esto vuelve a la mesa —y con ello la ruta de API, que sigue escrita— cuando pase
**cualquiera** de estas:

1. **El primer cliente de pago.** Ahí la atribución de coste por tenant y la
   pregunta de licencia dejan de ser teóricas.
2. **Que las condiciones de Anthropic no permitan** usar una suscripción como
   motor de inferencia de un servicio prestado a terceros. **No se ha
   verificado**, y este ADR no lo afirma en ningún sentido: mientras el uso sea
   interno la pregunta no se plantea, y antes de vender hay que responderla.
3. **Que los límites de la suscripción estorben** al trabajo de las personas de
   forma medible.
4. **Que el aislamiento se rompa** por un cambio de Claude Code, o que
   mantenerlo salga más caro que pagar la API.

## Alternativas descartadas

- **Dejar el PRD como estaba (router y Verifier por API).** Se descarta porque
  sus tres argumentos técnicos no aguantaron: la contabilidad por llamada existe
  también en el CLI, la salida estructurada no evita validar, y el aislamiento
  se pudo construir y verificar. Queda uno solo —que el aislamiento es más
  frágil— y no compensa una segunda facturación para un producto sin clientes.

- **Ruta mixta: el router por CLI y el Verifier por API.** Tiene una lógica —el
  Verifier es donde el aislamiento importa— pero deja exactamente el problema que
  se quería quitar: dos suscripciones, dos métodos de pago, dos cosas que
  vigilar. Y precisamente el Verifier es la parte que **ya está medida por CLI**.
