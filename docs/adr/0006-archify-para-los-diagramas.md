# ADR 0006 — archify para los diagramas de la documentación

**Estado:** aceptada · **Fecha:** 9 de septiembre de 2026 · **Issue:** #18

## Contexto

La documentación de arquitectura es prosa. Un diagrama ayuda, pero uno dibujado a
mano miente en cuanto el código cambia, y entonces es peor que no tenerlo: da
confianza falsa a quien no va a abrir el diff, que es justo el lector que el PRD
§1 quiere servir.

La frontera de `docs/quality-gates.md` §3 es explícita: solo construimos lo que
está en negrita —Verifier, Router, detección de colisiones—. La visualización no
está.

## Decisión

Adoptar [`tt-a1i/archify`](https://github.com/tt-a1i/archify) (MIT) para los
diagramas de la documentación, fijado a **v2.16.0** y con checksum comprobado en
`scripts/install-archify.sh`.

`main` publica el canal `development`; se usa la última release estable.

## Por qué este, y no Mermaid ni un editor

Lo que lo distingue no es el acabado, es que **verifica**:

- `sources` ata cada componente a rutas del repo y `--repo-root` comprueba que
  existen **en una revisión concreta**. Un diagrama que apunta a un fichero que ya
  no existe **no se entrega**. Verificado provocándolo.
- `deliver` emite SHA-256 de la especificación y del artefacto, y **separa tres
  afirmaciones que no se mezclan**: comprobaciones deterministas del artefacto,
  evidencia acotada de navegador, y revisión perceptual, que requiere un humano.
  Es la misma disciplina que `CLAUDE.md` §6 exige para el código.
- **Cero dependencias de runtime.** Comprobado en su `package.json`: solo
  devDependencies.
- El único acceso a red es un `GET` a un manifiesto de versión, sin body, sin
  telemetría, y con una aserción en el propio código que rechaza cualquier URL
  distinta de la fijada. El código no sale de la máquina, que es lo que exige
  `docs/quality-gates.md` §2 sobre residencia de datos en la UE.

## Consecuencias

- La fuente de verdad es el `.json`; el `.html` es artefacto y va a `.gitignore`,
  igual que `dist/`. Se regenera con `pnpm diagrams`. La entrega es determinista:
  el mismo `.json` produce el mismo SHA-256.
- El diagrama queda anclado a un commit. Al tocar la arquitectura hay que
  actualizar la revisión, o el diagrama seguirá siendo cierto para una revisión
  vieja — que es correcto, pero hay que saberlo. Documentado en
  `docs/diagrams/README.md`.
- Se añade una dependencia de herramienta externa a la documentación. Mitigación:
  versión fijada, checksum, e instalación reproducible sin pasos manuales.
- **Lo que la entrega NO demuestra:** que el diagrama sea correcto. Que los
  componentes existan no implica que se relacionen como dice el dibujo. Eso sigue
  siendo revisión humana.

## Alternativas descartadas

**Mermaid.** Ya lo entiende GitHub y no necesita instalación. Descartado porque no
verifica nada: un diagrama Mermaid que describe una arquitectura que ya no existe
se renderiza igual de bien. Archify acepta Mermaid como _entrada_, así que si
alguien tiene diagramas en Mermaid no se pierden.

**ICM (`RinDig/icm-architect`, arXiv:2603.16021).** Evaluado en la misma sesión.
Es una metodología de estructura de carpetas como arquitectura de agente, no una
herramienta de diagramas. **No se adopta como arquitectura**: su propia sección
_"Where ICM loses"_ nombra colaboración multi-agente en tiempo real, alta
concurrencia y ramificación automática, que son exactamente nuestro dominio.

Sí se recogen dos cosas suyas, y quedan como deuda anotada:

1. Su regla de que el fichero de entrada **enruta y no contiene** (objetivo: menos
   de 60 líneas). Nuestro `CLAUDE.md` tiene 169 y `AGENTS.md` es un **resumen
   mantenido a mano** — el anti-patrón de "ficheros de entrada duplicados que
   derivan" que ICM nombra explícitamente. Cuando uno cambie, el otro mentirá.
2. Su presupuesto de **2.000–8.000 tokens por paso**, que da un número concreto al
   criterio de T05 del epic 02 ("cabe holgadamente en el presupuesto de
   contexto"), que hoy no es medible.

**Dibujar a mano.** Descartado por el motivo del contexto: no hay forma de que el
CI note que se quedó obsoleto.
