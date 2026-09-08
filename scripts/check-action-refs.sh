#!/usr/bin/env bash
# Comprueba que TODA action referenciada en .github/workflows/ resuelve de verdad.
#
# Por que existe: CLAUDE.md 2.5 obliga a verificar que una dependencia propuesta
# por un agente existe realmente, por el riesgo de paquetes alucinados. Esa regla
# se aplicaba a npm y no a las actions, y era el mismo riesgo: el primer CI de
# este repo se cayo entero por `aquasecurity/trivy-action@0.36.0`, cuyo tag real
# es `v0.36.0`. GitHub no falla al parsear el YAML, falla al ejecutar, asi que el
# error solo aparece cuando ya has empujado.
#
# Necesita `gh` autenticado (en CI, GH_TOKEN=${{ github.token }}).
set -euo pipefail

fail=0
refs=$(grep -rhoE '^\s*-?\s*uses:\s*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+' \
        .github/workflows/ | sed -E 's/.*uses:\s*//' | sort -u)

if [ -z "$refs" ]; then
  echo "ERROR: no se ha encontrado ninguna referencia a actions. El grep esta roto." >&2
  exit 1
fi

for ref in $refs; do
  repo="${ref%@*}"
  rev="${ref#*@}"
  if gh api "repos/${repo}/git/ref/tags/${rev}"  >/dev/null 2>&1 \
  || gh api "repos/${repo}/git/ref/heads/${rev}" >/dev/null 2>&1 \
  || gh api "repos/${repo}/commits/${rev}"       >/dev/null 2>&1; then
    echo "ok     ${ref}"
  else
    echo "FALLA  ${ref} — no resuelve como tag, rama ni commit" >&2
    fail=1
  fi
done

exit "$fail"
