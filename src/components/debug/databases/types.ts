import type { OwnDb } from '../../../lib/api'

// One section of own files per worker that answered; base '' is this worker.
export interface OwnSection {
  worker: string
  base: string
  own: OwnDb[]
}
