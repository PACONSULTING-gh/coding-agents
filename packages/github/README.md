# @coord/github

Todo lo que sabe hablar con GitHub. `octokit` es un detalle de implementacion de
este paquete y no debe asomar por su API publica: lo comprueba la regla
`octokit-solo-en-github` de dependency-cruiser, ademas de este README.

Depende solo de `@coord/core`. **No** accede a la base de datos: la fila que
mapea instalacion -> tenant vive en `github_installations` y su acceso esta en
`@coord/db`. Aqui esta lo que no necesita infraestructura.

## Que hay

| Modulo                   | Que resuelve                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app.ts`                 | Construye el cliente de la GitHub App desde el entorno. Decodifica la clave privada (base64 de una linea -> PEM)                                                            |
| `verify-signature.ts`    | Verifica `x-hub-signature-256` sobre el **cuerpo crudo**, en tiempo constante. Delega en `@octokit/webhooks`; el fichero explica por que y que hace esa libreria por dentro |
| `installation-tokens.ts` | Cache de tokens de instalacion con renovacion transparente antes de caducar y deduplicacion de renovaciones concurrentes                                                    |
| `events.ts`              | Lista de eventos suscritos, nombres de cola y el contrato del job (`GithubWebhookJob`)                                                                                      |
| `installations.ts`       | Lectura pura de los payloads de instalacion                                                                                                                                 |

### Codigo sin llamante todavia: `app.ts` y `installation-tokens.ts`

`createGitHubApp`, `InstallationTokenCache` e `installationTokenFetcher` **no
los usa ningun proceso de produccion**: hoy el sistema recibe webhooks y encola,
pero no llama a la API de GitHub. Estan probados de extremo a extremo contra un
servidor HTTP local que hace de API (`test/installation-tokens.test.ts`:
renovacion antes de caducar, deduplicacion de renovaciones concurrentes,
invalidacion ante 401), pero esa prueba es del modulo, no del sistema.

Consecuencia para el epic 01: el quinto criterio de aceptacion de T05 —"dado un
token de instalacion caducado, cuando se necesita llamar a la API, entonces se
renueva de forma transparente"— **no llega a darse en el sistema entregado**,
porque el supuesto ("cuando se necesita llamar a la API") no ocurre nunca.

Se deja anotado en vez de enganchar la cache en `apps/worker` sin ningun
llamante real, que seria construir el consumidor antes que el caso de uso
(CLAUDE.md 2.4, peldano 1). **Decision pendiente de un humano:** o se da el
criterio por diferido a la primera tarea que consuma la API, o se considera que
T05 no esta cerrada hasta que exista ese consumidor.

## Lo que NO puede pasar

- **Ninguna credencial en el repositorio.** Ni clave privada, ni secreto de
  webhook, ni tokens: ni en codigo, ni en tests, ni en fixtures (CLAUDE.md 5).
  Los tests generan un par RSA al vuelo en memoria y un secreto aleatorio por
  ejecucion.
- **Ningun token en el log.** Este paquete no escribe en el log. Un token de
  instalacion tiene permiso de escritura sobre los repositorios del cliente: en
  cuanto aparece en un log, aparece tambien en sus copias de seguridad.
- **Ningun `JSON.parse` antes de verificar la firma.** Quien llame a
  `createSignatureVerifier` tiene que pasarle los bytes exactos que llegaron por
  el socket. `apps/webhook` conserva el `Buffer` con un content-type parser
  propio justo para esto.

## Tests

`pnpm --filter @coord/github test`. No necesitan Docker: la API de GitHub se
dobla con un servidor HTTP de verdad en localhost (no un mock del cliente de
octokit), y el resto es logica pura.

## Configurar la App en GitHub

Los pasos que ejecuta una persona —permisos, eventos, clave, instalacion— estan
en [`docs/github-app-setup.md`](../../docs/github-app-setup.md).
