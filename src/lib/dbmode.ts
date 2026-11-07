// Text of the Databases tab built from the v1.30 blocks of
// GET /api/v1/debug/databases: the one-line mode strip (what the serving
// worker runs) and the cleanup line of the history (when files leave).
// Pure: the time formatter is a parameter, so tests do not depend on the
// browser's locale or time zone.

import type { Capabilities, DatabasesResponse, RecorderStatus } from './types'

/** Formats an epoch second as a short clock time. */
export type ClockFormatter = (epochSeconds: number) => string

/** The browser's local clock time, hours and minutes. */
export const localClock: ClockFormatter = (epochSeconds) =>
  new Date(epochSeconds * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

/** A span of seconds in its largest whole unit: `1h`, `30m`, `90s`. */
export function fmtSpan(seconds: number): string {
  if (seconds > 0 && seconds % SECONDS_PER_HOUR === 0) return `${seconds / SECONDS_PER_HOUR}h`
  if (seconds > 0 && seconds % SECONDS_PER_MINUTE === 0) return `${seconds / SECONDS_PER_MINUTE}m`
  return `${seconds}s`
}

function recorderPart(recorder: RecorderStatus): string {
  const details: string[] = []
  if (recorder.memory) details.push(`memory ${fmtSpan(recorder.memory.window_seconds)}`)
  if (recorder.sqlite)
    details.push(`rotation ${fmtSpan(recorder.sqlite.rotation_interval_seconds)}`)
  if (recorder.postgres)
    details.push(`table ${recorder.postgres.schema}.${recorder.postgres.table}`)
  const name = recorder.provider === 'none' ? 'recorder off' : `recorder ${recorder.provider}`
  return details.length ? `${name} (${details.join(', ')})` : name
}

function archivePart(recorder: RecorderStatus, clock: ClockFormatter): string | null {
  const archive = recorder.sqlite?.archive
  if (!archive) return null
  if (archive.scope === null) return 'archive: off'
  const next = archive.next_slot_ts !== null ? `, next ${clock(archive.next_slot_ts)}` : ''
  return `archive: ${archive.scope} scope${next}`
}

function autodiscoverPart(caps: Capabilities | null | undefined): string | null {
  const autodiscover = caps?.autodiscover
  if (!autodiscover) return null
  return autodiscover.enabled ? `autodiscover ${autodiscover.provider ?? 'on'}` : 'autodiscover off'
}

/**
 * The mode strip, for example
 * `w-2 · cluster search · recorder sqlite (memory 2m, rotation 1h) · archive: cluster scope, next 11:00 · autodiscover consul`.
 * Null for a worker older than v1.30 (no `worker` or `recorder` block).
 */
export function modeStrip(
  data: Pick<DatabasesResponse, 'worker' | 'recorder'>,
  caps: Capabilities | null | undefined,
  clock: ClockFormatter = localClock,
): string | null {
  const { worker, recorder } = data
  if (!worker || !recorder) return null
  const parts = [
    worker.name,
    worker.cluster ? `cluster ${worker.cluster}` : null,
    recorderPart(recorder),
    archivePart(recorder, clock),
    autodiscoverPart(caps),
  ]
  return parts.filter((part): part is string => part !== null).join(' · ')
}

function keptFor(days: number, what: string): string {
  return days === 0 ? `${what} are kept for ever` : `${what} are deleted after ${days} days`
}

/**
 * When files leave the history folders, as one sentence for the history
 * header; null when the worker sends no `sqlite` block (another provider,
 * or a worker older than v1.30).
 */
export function historyCleanupNote(
  recorder: RecorderStatus | undefined,
  clock: ClockFormatter = localClock,
): string | null {
  const archive = recorder?.sqlite?.archive
  if (!archive) return null
  if (archive.scope === null) {
    return 'No archive pass runs on this worker: sealed files and merge results stay until an operator deletes them on disk (the UI deletes merge results only).'
  }
  const sentences = [
    `Sealed files go into an archive ${fmtSpan(archive.due_after_seconds)} after their ${fmtSpan(archive.window_seconds)} window ends`,
    keptFor(archive.retention_days, 'archives'),
    keptFor(archive.merged_retention_days, 'merge results'),
  ]
  const next =
    archive.next_slot_ts !== null ? ` Next archive pass at ${clock(archive.next_slot_ts)}.` : ''
  return `${sentences.join('; ')}.${next}`
}
