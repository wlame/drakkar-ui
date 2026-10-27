import type { OwnDb, RecorderStatus, StorageStatus } from '../../../lib/api'

// One section of own files per worker that answered; base '' is this worker.
export interface OwnSection {
  worker: string
  base: string
  own: OwnDb[]
  /** The worker's `recorder` block (v1.30); absent from a backend that predates it. */
  recorder?: RecorderStatus
  /** The worker's `storage` block (v1.30); absent from a backend that predates it. */
  storage?: StorageStatus
}
