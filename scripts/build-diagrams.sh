#!/usr/bin/env bash
# Valida y entrega todos los diagramas de docs/diagrams/.
#
# La fuente de verdad es el .json; el .html es artefacto y esta en .gitignore,
# igual que dist/. Cualquiera lo regenera con un comando.
#
# `deliver` es la aceptacion final de archify: congela la especificacion, la
# renderiza, la comprueba y reporta SHA-256 de spec y artefacto. Un exit distinto
# de cero NUNCA se puede describir como exito.
#
# Se itera por TIPO y no con un glob de *.json: `archify visual-check` deja
# sidecars en este mismo directorio (arquitectura.visual-check.json y sus PNG), y
# un glob generico los tomaba por especificaciones — el tipo salia "visual-check"
# y la entrega moria con un error que ni siquiera era JSON.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cli="${root}/.claude/skills/archify/bin/archify.mjs"

if [ ! -f "${cli}" ]; then
  echo "ERROR: archify no esta instalado. Corre ./scripts/install-archify.sh" >&2
  exit 1
fi

shopt -s nullglob
found=0

for type in architecture workflow sequence dataflow lifecycle; do
  for spec in "${root}"/docs/diagrams/*."${type}".json; do
    base="$(basename "${spec}")"
    out="${root}/docs/diagrams/${base%%.*}.html"
    found=1
    echo "-> ${base} (${type})"
    # --repo-root hace que las rutas de `sources` se comprueben contra el repo:
    # un diagrama que apunta a un fichero que no existe NO se entrega.
    node "${cli}" deliver "${type}" "${spec}" "${out}" \
      --quality showcase --repo-root "${root}" --json |
      python3 -c "
import json, sys
raw = sys.stdin.read()
try:
    d = json.loads(raw)
except json.JSONDecodeError:
    print('   la entrega no devolvio JSON:', raw[:400], file=sys.stderr)
    sys.exit(1)
v = d.get('validation', {})
e = d.get('evidence', {})
print('   checks %s/%s · errores %s · avisos %s · evidencia verificada: %s (%s refs)' % (
    v.get('checksPassed'), v.get('checkCount'), v.get('errors'), v.get('warnings'),
    e.get('verified'), e.get('references')))
print('   sha256 artefacto:', (d.get('artifact') or {}).get('sha256', '?')[:16] + '...')
sys.exit(0 if d.get('ok') else 1)"
  done
done

if [ "${found}" -eq 0 ]; then
  echo "No hay especificaciones en docs/diagrams/." >&2
  exit 1
fi
