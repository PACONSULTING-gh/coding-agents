import { Webhooks } from '@octokit/webhooks'

/**
 * Verificacion de la firma de los webhooks de GitHub.
 *
 * ---------------------------------------------------------------------------
 * POR QUE NO HAY AQUI NINGUN `createHmac`
 * ---------------------------------------------------------------------------
 * Esto es una frontera de confianza y no se recorta (CLAUDE.md 2.4), pero
 * "no recortar" no significa "escribirlo a mano". `@octokit/webhooks` ya esta
 * en el stack y su `verify` hace EXACTAMENTE lo que hace falta (peldano 5 de
 * la escalera). Se ha leido antes de confiar en el; esto es lo que hace, via
 * `@octokit/webhooks-methods@6`:
 *
 *   1. Calcula `sha256=` + HMAC-SHA256(secreto, payload) con `node:crypto`.
 *   2. Compara longitudes ANTES de nada y devuelve `false` si difieren
 *      (`timingSafeEqual` lanza si los buffers miden distinto).
 *   3. Compara con `crypto.timingSafeEqual`, en tiempo constante.
 *
 * Lo que NO puede garantizar la libreria, y por tanto es responsabilidad de
 * quien la llama, es que `payload` sean los BYTES EXACTOS que llegaron por el
 * socket. Si el cuerpo se parsea a JSON y se vuelve a serializar, la firma deja
 * de cuadrar: cualquier reordenacion de claves, espacio o escapado distinto
 * cambia el HMAC. Por eso `apps/webhook` registra un content-type parser que
 * conserva el Buffer crudo y no llama a `JSON.parse` hasta DESPUES de verificar.
 *
 * `verify()` recibe string, no Buffer. La conversion se hace aqui con utf8, que
 * es la codificacion en la que GitHub envia el JSON: para un cuerpo UTF-8
 * valido, `buffer.toString('utf8')` seguido de `hmac.update(texto, 'utf8')`
 * reproduce byte a byte el original. Si el cuerpo NO fuese UTF-8 valido, la
 * conversion introduce caracteres de reemplazo, el HMAC no cuadra y la peticion
 * se rechaza: el modo de fallo es cerrado, que es el que queremos.
 */

/** Cabecera con la firma HMAC-SHA256 del cuerpo. */
export const SIGNATURE_HEADER = 'x-hub-signature-256'
/** GUID de la entrega. Es la clave de deduplicacion. */
export const DELIVERY_HEADER = 'x-github-delivery'
/** Nombre del evento: `issues`, `push`, `installation`... */
export const EVENT_HEADER = 'x-github-event'

const SIGNATURE_PREFIX = 'sha256='
/** HMAC-SHA256 en hexadecimal: 32 bytes = 64 caracteres. */
const SIGNATURE_HEX_LENGTH = 64

/**
 * Motivo por el que se rechaza una firma. Es un codigo estable, pensado para
 * ir al log estructurado y al `audit_log`: quien investigue un incidente
 * necesita distinguir "no venia firmada" de "venia firmada mal".
 */
export type SignatureRejection =
  'missing_signature' | 'malformed_signature' | 'unsupported_algorithm' | 'signature_mismatch'

export type SignatureVerification =
  { readonly valid: true } | { readonly valid: false; readonly reason: SignatureRejection }

export type SignatureVerifier = (
  rawBody: Buffer | string,
  signature: string | undefined,
) => Promise<SignatureVerification>

/**
 * Construye el verificador para un secreto de webhook.
 *
 * El secreto se comprueba al construir, no en la primera peticion: arrancar el
 * listener con el secreto vacio y descubrirlo cuando llega el primer webhook
 * seria aceptar trafico sin verificar durante el arranque.
 */
export function createSignatureVerifier(secret: string): SignatureVerifier {
  if (secret.trim() === '') {
    throw new Error(
      'El secreto de webhook esta vacio. Sin secreto no hay verificacion posible: ' +
        'rellena GITHUB_WEBHOOK_SECRET (ver docs/github-app-setup.md).',
    )
  }
  const webhooks = new Webhooks({ secret })

  return async (rawBody, signature) => {
    if (signature === undefined || signature === '') {
      return { valid: false, reason: 'missing_signature' }
    }
    // El prefijo se mira antes de calcular nada. Un `sha1=...` en esta cabecera
    // no es "una firma que no cuadra", es otro algoritmo: se distingue en el
    // log porque casi siempre significa una integracion mal configurada.
    if (!signature.startsWith(SIGNATURE_PREFIX)) {
      return {
        valid: false,
        reason: signature.includes('=') ? 'unsupported_algorithm' : 'malformed_signature',
      }
    }
    const digest = signature.slice(SIGNATURE_PREFIX.length)
    if (digest.length !== SIGNATURE_HEX_LENGTH || !/^[0-9a-f]+$/i.test(digest)) {
      return { valid: false, reason: 'malformed_signature' }
    }

    const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')
    if (payload === '') {
      // `verify()` lanza TypeError con el payload vacio. Un cuerpo vacio no
      // puede venir de GitHub, asi que se rechaza aqui: convertir una peticion
      // hostil en un 500 seria regalarle al atacante una forma de hacer ruido.
      return { valid: false, reason: 'signature_mismatch' }
    }
    const valid = await webhooks.verify(payload, signature)
    return valid ? { valid: true } : { valid: false, reason: 'signature_mismatch' }
  }
}
