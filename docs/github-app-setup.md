# Registrar e instalar la GitHub App

> **Esto lo ejecuta una persona, no un agente.** Registrar una App, elegir sus
> permisos e instalarla en una organizacion son decisiones con consecuencias
> sobre el codigo de clientes reales. Un agente puede preparar el plan —este
> documento lo es— pero quien aprieta los botones es un humano (CLAUDE.md 2.1).

Tiempo estimado: 20 minutos. Se hace **una vez por organizacion de GitHub**.

---

## 0. Antes de empezar

Necesitas:

- Permiso de **owner** en la organizacion `PACONSULTING-gh`.
- La URL publica donde va a escuchar `apps/webhook` (con HTTPS). En desarrollo
  vale un tunel (`gh webhook forward`, `ngrok`, `cloudflared`); en produccion,
  el dominio real.
- Acceso al gestor de secretos donde guardais las variables de entorno.

Ten claro esto antes de tocar nada:

- La clave privada se descarga **una sola vez**. Si se pierde, se revoca y se
  genera otra; no se puede volver a descargar.
- **Nada de lo que sale de aqui se commitea.** Ni la clave, ni el secreto de
  webhook, ni el client secret. Van a `.env` (que esta en `.gitignore`) o al
  gestor de secretos. El hook de pre-commit con Gitleaks bloquea el commit si se
  cuelan, pero la primera defensa eres tu.

---

## 1. Registrar la App

`https://github.com/organizations/PACONSULTING-gh/settings/apps/new`

| Campo                                       | Valor                                              | Por que                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub App name**                         | `Liberion Coordination` (debe ser unico en GitHub) | Es el nombre que ven los usuarios en los comentarios y en el registro de actividad                                                                                     |
| **Homepage URL**                            | La web de Liberion, o la URL del repo              | Obligatorio; no tiene efecto funcional                                                                                                                                 |
| **Webhook**                                 | Activo                                             | Sin webhook no hay integracion                                                                                                                                         |
| **Webhook URL**                             | `https://TU-DOMINIO/webhooks/github`               | La ruta la fija `WEBHOOK_PATH` en `apps/webhook/src/server.ts`                                                                                                         |
| **Webhook secret**                          | Generalo con `openssl rand -hex 32`                | Es lo que permite verificar que un webhook viene de GitHub. **Sin secreto, cualquiera puede fabricar eventos.** El listener se niega a arrancar sin el                 |
| **SSL verification**                        | Habilitada                                         | Desactivarla convierte el canal en interceptable                                                                                                                       |
| **Where can this GitHub App be installed?** | _Only on this account_                             | Hasta que haya clientes externos, la App no debe poder instalarse fuera                                                                                                |
| **Content type** (en la seccion de webhook) | `application/json`                                 | El listener **solo** acepta JSON: el HMAC se calcula sobre el cuerpo crudo y el parser esta registrado para ese content type. Con `x-www-form-urlencoded` responde 415 |

No rellenes la seccion de **Identifying and authorizing users** (callback URL,
device flow): este servicio no actua en nombre de un usuario. El dia que haga
falta login con GitHub se anade entonces, y se documenta aqui.

---

## 2. Permisos — el minimo por evento suscrito

GitHub no deja suscribirse a un evento sin el permiso que lo respalda. Esta
tabla es la justificacion de cada uno; **si un permiso no esta aqui, no se
pide.** Ampliar permisos despues obliga a que cada instalacion vuelva a
aprobarlos a mano, asi que la lista esta pensada para no tener que ampliarla
por lo previsible del roadmap, y para no incluir nada mas.

| Permiso           | Nivel               | Evento que lo necesita                    | Justificacion                                                                                                                                                                                                                                                         |
| ----------------- | ------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Metadata**      | Lectura             | (todos)                                   | Obligatorio en toda GitHub App. Lo concede GitHub automaticamente                                                                                                                                                                                                     |
| **Issues**        | Lectura y escritura | `issues`, `issue_comment`                 | Los issues son la fuente de verdad de las tareas y **los comentarios son el audit trail** (CLAUDE.md 3). El listener de hoy solo lee, pero el motor de ejecucion escribe comentarios; pedir escritura ahora evita una segunda ronda de aprobacion en cada instalacion |
| **Pull requests** | Lectura y escritura | `pull_request`, `issue_comment` sobre PRs | Detectar colisiones entre agentes exige leer los PRs abiertos y sus ficheros. La escritura, por el mismo motivo que en Issues: el informe de verificacion se publica como comentario                                                                                  |
| **Contents**      | Lectura             | `push`                                    | Saber que ficheros ha tocado cada push. **Lectura y no escritura:** este sistema no escribe codigo en los repositorios de los clientes. Si algun dia lo hiciera, seria un cambio que se discute en un ADR, no un permiso que se amplia de tapadillo                   |
| **Checks**        | Lectura             | `check_run`                               | Saber si el trabajo de un agente pasa los gates de calidad sin leer el diff (problema 3 del PRD)                                                                                                                                                                      |
| **Actions**       | Lectura             | `workflow_run`                            | Igual que Checks, para los workflows de CI                                                                                                                                                                                                                            |

**No se piden** (y conviene que se note que es deliberado): Administration,
Secrets, Environments, Packages, Deployments, Members, ni ningun permiso de
organizacion. Nada de eso hace falta para coordinar tareas.

### Eventos a suscribir

Marca exactamente estos, que son los que enumera `SUBSCRIBED_EVENTS` en
`packages/github/src/events.ts`:

- `Issues`
- `Issue comment`
- `Pull request`
- `Push`
- `Check run`
- `Workflow run`
- `Installation` _(se manda siempre; se marca igualmente para dejarlo explicito)_
- `Installation repositories`

> Si suscribes un evento que **no** esta en esa lista, el listener responde 200
> y lo descarta, dejando una linea en el log. Es correcto: mejor descartar de
> forma visible que encolar trabajo que nadie sabe procesar. Si el evento hace
> falta de verdad, se anade a `SUBSCRIBED_EVENTS` y se le da handler en
> `apps/worker`.

Pulsa **Create GitHub App**.

---

## 3. Generar la clave privada

En la pagina de la App, seccion **Private keys** → **Generate a private key**.
Se descarga un `.pem`. **Es la unica descarga; no hay segunda oportunidad.**

Conviertelo a base64 de una sola linea, que es el formato que espera el
servicio:

```bash
base64 -w0 nombre-de-la-app.2026-09-08.private-key.pem
```

En macOS, `base64 -w0` no existe; usa:

```bash
base64 -i nombre-de-la-app.2026-09-08.private-key.pem | tr -d '\n'
```

Copia la salida a `GITHUB_APP_PRIVATE_KEY` y **borra el `.pem` del disco**
(`shred -u fichero.pem`, o el equivalente de tu sistema) una vez guardado en el
gestor de secretos.

> **Por que base64 y no el PEM tal cual:** un PEM tiene saltos de linea, y una
> variable de entorno multilinea se parte de una forma distinta en cada sitio
> (`.env`, secreto de GitHub Actions, variable de un contenedor, panel de un
> PaaS). Una sola linea es una sola linea en todos ellos. El servicio tambien
> acepta el PEM en claro si alguien lo pega asi, pero no es lo documentado.

---

## 4. Instalar la App en la organizacion

En la pagina de la App: **Install App** → elige `PACONSULTING-gh`.

Selecciona **Only select repositories** y marca los del piloto. _All
repositories_ es comodo y es justo lo que no queremos: la App recibiria eventos
de repositorios que no tiene por que ver.

Al terminar, GitHub te deja en una URL del tipo:

```
https://github.com/organizations/PACONSULTING-gh/settings/installations/12345678
```

Ese `12345678` final es el **installation id**. Anotalo: hace falta en el paso 6.

---

## 5. Rellenar el `.env`

Copia `.env.example` a `.env` y rellena estas cuatro variables (las demas ya las
cubre el resto del despliegue):

| Variable                        | De donde sale                      | Formato                                              |
| ------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `GITHUB_APP_ID`                 | Pagina de la App, campo **App ID** | Entero, p. ej. `1234567`                             |
| `GITHUB_APP_PRIVATE_KEY`        | Paso 3                             | Base64 **en una sola linea**, sin comillas ni saltos |
| `GITHUB_WEBHOOK_SECRET`         | El que generaste en el paso 1      | La cadena tal cual, sin `sha256=` ni prefijos        |
| `WEBHOOK_PORT` / `WEBHOOK_HOST` | Tu despliegue                      | Puerto e interfaz donde escucha `apps/webhook`       |

### Que variable necesita cada servicio

No son las mismas, y la diferencia importa: la clave privada de la App solo
tiene que existir en el proceso que llama a la API de GitHub.

| Servicio       | Necesita                                                     | NO necesita                               |
| -------------- | ------------------------------------------------------------ | ----------------------------------------- |
| `apps/webhook` | `GITHUB_WEBHOOK_SECRET`, `DATABASE_URL`, `WEBHOOK_PORT/HOST` | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` |
| `apps/worker`  | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `DATABASE_URL`    | `GITHUB_WEBHOOK_SECRET`                   |

El listener es el unico proceso expuesto a internet y solo verifica firmas:
darle la clave privada seria superficie de exposicion sin contrapartida.

`GITHUB_APP_CLIENT_ID` y `GITHUB_APP_CLIENT_SECRET` estan en `.env.example` para
el dia que haya login de usuario con GitHub. **Hoy no se usan**: dejalos con el
valor de ejemplo o vacios.

Comprobacion rapida de que la clave esta bien codificada (no imprime la clave,
solo su cabecera):

```bash
printf '%s' "$GITHUB_APP_PRIVATE_KEY" | base64 -d | head -1
# Debe imprimir: -----BEGIN RSA PRIVATE KEY-----  (o -----BEGIN PRIVATE KEY-----)
```

---

## 6. Vincular la instalacion con un tenant

**Este paso no lo hace ningun webhook.** Cuando alguien instala la App, GitHub
manda `installation.created`, pero el sistema no tiene forma de saber a que
cliente corresponde esa organizacion: decidirlo es una decision de negocio. Asi
que, hasta que un humano cree el mapeo, el listener responde `200` con
`{"status":"unmapped"}` y deja un aviso en el log. Eso no es un fallo: es el
sistema negandose a adivinar.

El mapeo vive en la tabla `github_installations` y se crea con
`upsertInstallation` de `@coord/db`, dentro del contexto del tenant:

```bash
cd packages/db
pnpm exec tsx -e "
  import { runWithTenant } from '@coord/core'
  import { configureDatabase, closeDatabase, withTenantConnection, upsertInstallation } from './src/index.js'

  configureDatabase({ connectionString: process.env.DATABASE_URL })
  await runWithTenant({ tenantId: process.env.TENANT_ID }, () =>
    withTenantConnection((tx) =>
      upsertInstallation(tx, {
        installationId: Number(process.env.INSTALLATION_ID),
        accountLogin: 'PACONSULTING-gh',
        accountType: 'Organization',
        repositorySelection: 'selected',
      }),
    ),
  )
  await closeDatabase()
"
```

con `TENANT_ID` (el uuid del cliente en la tabla `tenants`) e `INSTALLATION_ID`
(el numero del paso 4) en el entorno.

A partir de ese momento, los eventos de esa organizacion se encolan en el tenant
correcto. Los cambios posteriores —suspension, reanudacion, desinstalacion— si
los aplica solo el worker cuando llegan los eventos `installation`.

Si te equivocas de tenant: el `installation_id` es **unico en todo el sistema**,
asi que un segundo tenant no puede reclamar la misma instalacion (la base de
datos lo rechaza). Corrigelo borrando el mapeo del tenant equivocado con
`deleteInstallation` y creandolo en el correcto.

---

## 7. Comprobar que funciona

1. **Salud del servicio.** `curl https://TU-DOMINIO/health` debe devolver
   `{"status":"ok","checks":{"database":true,"queue":true}}`. Si devuelve `503`,
   mira cual de los dos checks esta en `false`: comprueba de verdad la base y la
   cola, no responde `ok` por costumbre.

2. **Entrega de prueba.** En la pagina de la App → **Advanced** → _Recent
   Deliveries_. El `ping` del alta debe aparecer con **200**. El listener lo
   responde como `{"status":"ignored"}` porque `ping` no esta en la lista de
   eventos suscritos: es lo esperado.

3. **Un evento real.** Abre un issue en un repositorio de la instalacion. En
   _Recent Deliveries_ debe salir un `issues` con 200 y, en el log del listener,
   una linea con `outcome: "queued"`, el `deliveryId` y el `elapsedMs`.

4. **Reentrega.** Pulsa _Redeliver_ en esa misma entrega. Debe responder 200 con
   `{"status":"duplicate"}` y **no** generar un segundo job: la deduplicacion se
   apoya en la restriccion unica de `webhook_deliveries`.

---

## 8. Cuando algo va mal

| Sintoma                              | Causa mas probable                                                                                                                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Todas las entregas dan **401**       | `GITHUB_WEBHOOK_SECRET` no coincide con el de la App. Ojo con espacios o saltos al copiar. Cada rechazo deja en el log el motivo (`signature_mismatch`, `missing_signature`, ...) y, si la instalacion esta mapeada, una entrada en `audit_log` |
| Entregas con **415**                 | El content type de la App no es `application/json`                                                                                                                                                                                              |
| **200** pero `{"status":"unmapped"}` | Falta el paso 6 para esa instalacion                                                                                                                                                                                                            |
| **200** pero `{"status":"ignored"}`  | Evento no suscrito en `SUBSCRIBED_EVENTS`, o payload sin `installation`                                                                                                                                                                         |
| El servicio no arranca               | Falta alguna variable: el mensaje dice cual. Nunca imprime su valor                                                                                                                                                                             |
| `no contiene una clave privada PEM`  | La clave se pego con saltos de linea o esta mal codificada. Repite el paso 3                                                                                                                                                                    |

Nada de lo anterior se diagnostica leyendo tokens en el log: **el sistema no
los escribe**, ni el token de instalacion ni el secreto ni la clave. Si alguna
vez ves uno en un log, es un incidente: rota la credencial afectada antes de
buscar de donde salio.

---

## Rotacion de credenciales

- **Secreto de webhook:** genera uno nuevo, ponlo en la App y en
  `GITHUB_WEBHOOK_SECRET`, y reinicia el listener. Entre los dos momentos habra
  entregas rechazadas con 401; GitHub reintenta, asi que la ventana se recupera
  sola si es corta.
- **Clave privada:** genera la nueva **antes** de borrar la vieja (GitHub admite
  varias a la vez), despliega, y solo entonces revoca la anterior. Al reves
  dejas la integracion muerta hasta el despliegue.
