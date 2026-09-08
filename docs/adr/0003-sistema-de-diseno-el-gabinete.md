# ADR 0003 — Cuando llegue una UI, consumirá "El Gabinete" vía registry de shadcn

**Estado:** Aceptada (decisión anticipada; sin efecto hasta que exista UI)

## Contexto

El PRD y este epic excluyen explícitamente construir UI en la v1 (CLAUDE.md
"Lo que este epic deliberadamente NO hace", epic-01 §Enfoque técnico). Aun así,
Liberion Labs ya tiene un sistema de diseño de marca, "El Gabinete", y conviene
dejar registrada ahora la decisión de cómo se consumirá cuando llegue el
momento, para que no se improvise ni se reinvente entonces.

## Decisión

Cuando exista una UI, consumirá "El Gabinete" desde el repo privado
`PACONSULTING-gh/liberion-design-system`, a través de su registry de shadcn:

```
npx shadcn@latest add https://<deploy>/r/<item>.json
```

Nunca copiando componentes a mano. Stack: Next.js App Router + Tailwind v4 +
shadcn.

Lenguaje visual a preservar (no hardcodear, pasa por los tokens de
`globals.css` del design system):

- Papel crema `#f4efe5`, tinta `#1c2536`, tarjeta `#faf6ec`.
- Oro `#d9a441` solo como acento, ≤3% de la superficie. Oro como texto
  `#7c5d1e` (cumple AA).
- Plancha navy `#0e1b2e` vía `data-theme="navy"`.
- `--radius: 0` — todo recto; la única curva permitida es el sello circular
  del Pegaso.
- Tres voces tipográficas: Fraunces (heading; el énfasis se marca con
  itálica, nunca con color), Satoshi (cuerpo), Geist Mono (folios/labels).

## Consecuencias

- No se hardcodean colores ni fuentes en ningún componente futuro: todo pasa
  por los tokens de `globals.css` de `liberion-design-system`.
- Los componentes no se copian ni se bifurcan a mano en este repo; se instalan
  vía el registry, lo que mantiene un único punto de verdad del sistema de
  diseño y facilita actualizarlo.
- Esta decisión no tiene efecto práctico todavía porque no hay UI en la v1;
  existe para que quien la construya en una fase posterior no la reinvente ni
  la contradiga.

## Alternativas descartadas

- **Copiar componentes de El Gabinete a mano en este repo** — rompe el punto
  único de verdad del sistema de diseño y diverge con el tiempo.
- **Construir un sistema de diseño propio para este producto** — duplica
  trabajo ya hecho y rompe la coherencia de marca con el resto de productos de
  Liberion Labs.
