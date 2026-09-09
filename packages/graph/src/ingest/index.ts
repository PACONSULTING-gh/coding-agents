export { ingestRepository } from './ingest.js'
export type { IngestRepositoryInput, IngestionHooks, IngestionResult } from './ingest.js'
export {
  INGESTION_PHASES,
  EMPTY_STATS,
  parseCheckpoint,
  isCheckpoint,
  type IngestionCheckpoint,
  type IngestionPhase,
  type IngestionStats,
} from './checkpoint.js'
export { listTrackedFiles, resolveHeadCommit } from './git.js'
export { repoIdForRepository } from './repo-id.js'
export { indexRepository } from './index-repository.js'
export type { IndexRepositoryInput, IndexRepositoryResult } from './index-repository.js'
