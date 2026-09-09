#!/usr/bin/env bash
# Instala la skill `archify` (diagramas de arquitectura verificables) en
# .claude/skills/, fijada a una version concreta y con checksum comprobado.
#
# Por que un script y no vendorizar el arbol: la skill pesa ~6 MB y su repo
# 138 MB. Se fija la version, se comprueba el hash, y el arbol del repo no
# engorda. Es el mismo patron que ya usamos con gitleaks en el CI.
#
# Por que v2.16.0 y no `main`: `main` publica el canal `development`
# (2.17.0-dev.1). Se usa la ultima release estable.
set -euo pipefail

VERSION="2.16.0"
# sha256 del archify.zip de la release v2.16.0, comprobado al descargarlo.
EXPECTED_SHA="4c59fa6557a2385beaaef8c7219cc414573acc9f0c30a932d5053b0b20689a46"
REPO="tt-a1i/archify"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${root}/.claude/skills/archify"

if [ -f "${dest}/skill-release.json" ] &&
   grep -q "\"version\": \"${VERSION}\"" "${dest}/skill-release.json" 2>/dev/null; then
  echo "archify ${VERSION} ya instalado en ${dest}"
  exit 0
fi

command -v gh >/dev/null 2>&1 || {
  echo "ERROR: hace falta la CLI de GitHub (gh) para descargar la release." >&2
  echo "Alternativa manual: descarga archify.zip de" >&2
  echo "  https://github.com/${REPO}/releases/tag/v${VERSION}" >&2
  echo "comprueba que su sha256 es ${EXPECTED_SHA} y descomprimelo en ${dest}" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "${tmp}"' EXIT

echo "Descargando archify v${VERSION}..."
gh release download "v${VERSION}" --repo "${REPO}" --pattern 'archify.zip' --dir "${tmp}"

actual="$(sha256sum "${tmp}/archify.zip" | cut -d' ' -f1)"
if [ "${actual}" != "${EXPECTED_SHA}" ]; then
  echo "ERROR: el checksum no coincide." >&2
  echo "  esperado: ${EXPECTED_SHA}" >&2
  echo "  obtenido: ${actual}" >&2
  echo "No se instala nada. Si la release se ha republicado, verifica el cambio" >&2
  echo "a mano antes de actualizar EXPECTED_SHA en este script." >&2
  exit 1
fi

unzip -qq "${tmp}/archify.zip" -d "${tmp}/out"
rm -rf "${dest}"
mkdir -p "$(dirname "${dest}")"
mv "${tmp}/out/archify" "${dest}"

# Las demos renderizadas son 3,6 MB de los 5,9 y no hacen falta para autorizar:
# el contrato de la skill lee los .json de examples/, no los .html.
find "${dest}/examples" -name '*.html' -delete 2>/dev/null || true

echo "archify ${VERSION} instalado en ${dest} ($(du -sh "${dest}" | cut -f1))"
echo "Comprobacion:"
node "${dest}/bin/archify.mjs" guide "arquitectura de un backend" --json >/dev/null &&
  echo "  la CLI responde"
