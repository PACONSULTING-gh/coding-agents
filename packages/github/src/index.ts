/**
 * API publica de @coord/github.
 *
 * Aqui vive todo lo que sabe hablar con GitHub: el cliente de la App, los
 * tokens de instalacion, la verificacion de firmas y la publicacion de
 * comentarios de PR (usada por el informe de conformidad del epic 05, T05).
 * `octokit` es un detalle de implementacion de este paquete y no debe asomar
 * fuera; lo comprueba la regla `octokit-solo-en-github` de dependency-cruiser.
 */
export {
  createGitHubApp,
  githubAppConfigFromEnv,
  decodePrivateKey,
  ENV_APP_ID,
  ENV_PRIVATE_KEY,
  ENV_WEBHOOK_SECRET,
} from './app.js'
export type { GitHubAppConfig } from './app.js'

export {
  InstallationTokenCache,
  installationTokenFetcher,
  DEFAULT_RENEW_MARGIN_MS,
} from './installation-tokens.js'
export type {
  InstallationToken,
  InstallationTokenFetcher,
  InstallationTokenCacheOptions,
} from './installation-tokens.js'

export {
  createSignatureVerifier,
  SIGNATURE_HEADER,
  DELIVERY_HEADER,
  EVENT_HEADER,
} from './verify-signature.js'
export type {
  SignatureVerifier,
  SignatureVerification,
  SignatureRejection,
} from './verify-signature.js'

export {
  SUBSCRIBED_EVENTS,
  WEBHOOK_QUEUE_PREFIX,
  isSubscribedEvent,
  queueNameForEvent,
  webhookQueueNames,
} from './events.js'
export type { SubscribedEvent, GithubWebhookJob } from './events.js'

export {
  extractInstallationId,
  extractAction,
  parseInstallationDescriptor,
} from './installations.js'
export type {
  InstallationDescriptor,
  GithubAccountType,
  RepositorySelection,
} from './installations.js'

export { publishPullRequestComment } from './pull-request-comments.js'
export type { PullRequestCommentTarget, PublishedComment } from './pull-request-comments.js'
