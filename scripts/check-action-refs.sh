#!/usr/bin/env bash
# Comprueba que TODA action referenciada en .github/workflows/ resuelve de verdad.
#
# Por que existe: CLAUDE.md 2.5 obliga a verificar que una dependencia propuesta
# por un agente existe realmente, por el riesgo de paquetes alucinados. Esa regla
# se aplicaba a npm y no a las actions, y era el mismo riesgo con peor sintoma:
# una referencia inventada no rompe el parseo del YAML, rompe la EJECUCION, asi
# que solo se descubre despues de empujar. El primer CI de este repo se cayo
# entero por `aquasecurity/trivy-action@0.36.0`, cuyo tag real es `v0.36.0`.
#
# Por que `git ls-remote` y no `gh api`: la primera version usaba `gh api`, pasaba
# en local con un token personal y daba FALSO POSITIVO en CI, donde el
# GITHUB_TOKEN del repo no resuelve refs de repos ajenos. Un gate que solo
# funciona en la maquina del que lo escribio no es un gate. `git ls-remote` es
# anonimo, no necesita token, y es como Actions resuelve las refs de verdad.
set -euo pipefail

fail=0
refs=$(grep -rhoE '^\s*-?\s*uses:\s*[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+@[A-Za-z0-9_./-]+' \
        .github/workflows/ | sed -E 's/.*uses:[[:space:]]*//' | sort -u)

if [ -z "$refs" ]; then
  echo "ERROR: no se ha encontrado ninguna referencia a actions. El grep esta roto." >&2
  exit 1
fi

for ref in $refs; do
  repo="${ref%@*}"
  rev="${ref#*@}"
  url="https://github.com/${repo}"

  # Una action fijada por SHA completo (lo recomendable en seguridad) no se puede
  # comprobar con ls-remote salvo que el SHA sea la punta de una rama o un tag.
  # Se intenta; si no aparece, se avisa y NO se falla, porque un SHA valido mas
  # atras en el historico daria un falso positivo igual que el de `gh api`.
  if printf '%s' "$rev" | grep -qE '^[0-9a-f]{40}$'; then
    if git ls-remote "$url" 2>/dev/null | grep -q "^${rev}"; then
      echo "ok     ${ref} (SHA, punta de ref)"
    else
      echo "aviso  ${ref} (SHA no comprobable con ls-remote; verificar a mano)"
    fi
    continue
  fi

  if [ -n "$(git ls-remote --tags --heads "$url" "$rev" 2>/dev/null)" ]; then
    echo "ok     ${ref}"
  else
    echo "FALLA  ${ref} — no resuelve como tag ni rama en ${url}" >&2
    fail=1
  fi
done

exit "$fail"
