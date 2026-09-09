# Diagramas

La **fuente de verdad es el `.json`**. El `.html` es artefacto y está en
`.gitignore`, igual que `dist/`: se regenera con un comando.

```bash
./scripts/install-archify.sh   # una vez por máquina (versión fijada + checksum)
pnpm diagrams                  # valida, verifica evidencia y entrega
```

## Por qué estos diagramas no pueden mentir

Cada componente declara de qué ficheros del repo habla:

```json
{
  "id": "db",
  "label": "packages/db",
  "sources": [{ "path": "packages/db/src/client.ts", "label": "withTenantConnection" }]
}
```

y `meta.repository` clava el diagrama a un commit concreto. Al entregarlo,
`--repo-root` comprueba que **cada ruta existe en esa revisión**. Comprobado:
cambiando una ruta por una inventada, la entrega falla con

```
repository-evidence/file-missing
  /components/4/sources/0/path does not identify a file at revision af0aa75…
```

Eso es lo que separa esto de un dibujo: un diagrama desactualizado deja de
entregarse en vez de seguir contando algo que ya no es cierto.

## Cuando cambia el código

El commit fijado en `meta.repository.revision` se queda atrás a propósito: el
diagrama sigue siendo cierto **para esa revisión**. Al tocar la arquitectura,
actualiza el `.json` y vuelve a fijar la revisión:

```bash
python3 - <<'PY'
import json, subprocess
p = 'docs/diagrams/arquitectura.architecture.json'
d = json.load(open(p))
d['meta']['repository']['revision'] = subprocess.check_output(
    ['git', 'rev-parse', 'HEAD'], text=True).strip()
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
PY
pnpm diagrams
```

## Qué NO demuestra la entrega

`deliver` prueba comprobaciones **deterministas** del artefacto: esquema,
composición, y que la evidencia existe. No prueba que el diagrama sea _correcto_
—que los componentes se relacionen como dice— ni que se vea bien. Eso sigue
siendo revisión humana, igual que el resto de la Definition of Done.

## Diagramas actuales

| Fichero                          | Tipo         | Qué cuenta                                                                          | ¿Evidencia verificada? |
| -------------------------------- | ------------ | ----------------------------------------------------------------------------------- | ---------------------- |
| `arquitectura.architecture.json` | architecture | Los módulos, del webhook al servidor MCP, con la frontera de aislamiento por tenant | **Sí**, 11 referencias |
| `webhook.sequence.json`          | sequence     | El ciclo de vida de una entrega, con los tres rechazos                              | No                     |
| `ingesta.dataflow.json`          | dataflow     | Por qué la indexación es incremental y no un rebuild                                | No                     |

**`--repo-root` solo lo admite `architecture`.** Los diagramas de secuencia y
flujo de datos no tienen esa red de seguridad: sus afirmaciones se revisan a mano,
como cualquier prosa. Conviene tenerlo presente antes de fiarse de ellos igual que
del de arquitectura.
