// What the serving worker can do (contract v1.28, `capabilities` on
// GET /api/v1/identity). Every check treats a missing key as "on", so a
// backend that sends no `capabilities` renders exactly as before.

import { derived, type Readable } from 'svelte/store'
import { identity } from './config'
import type { Capabilities } from './types'

/** Memory window assumed when a backend reports none (seconds). */
const DEFAULT_MEMORY_WINDOW_SECONDS = 120

/** True unless autodiscover is explicitly off: the switcher and cluster views need it. */
export function isAutodiscoverOn(caps: Capabilities | null | undefined): boolean {
  return caps?.autodiscover?.enabled !== false
}

/** True unless the history search is explicitly off. */
export function isHistorySearchOn(caps: Capabilities | null | undefined): boolean {
  return caps?.recorder?.history_search !== false
}

/** True only when the recorder is explicitly off. */
export function isRecorderOff(caps: Capabilities | null | undefined): boolean {
  return caps?.recorder?.enabled === false
}

/**
 * True only when split mode is explicitly on. Unlike the other checks, a
 * missing key means off (contract v1.34).
 */
export function isSplitEnabled(caps: Capabilities | null | undefined): boolean {
  return caps?.split?.enabled === true
}

/** The number added to a parts partition, or null when split is off. */
export function splitPartsBase(caps: Capabilities | null | undefined): number | null {
  if (!isSplitEnabled(caps)) return null
  return caps?.split?.parts_partition_base ?? null
}

function describeSeconds(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
  }
  return `${seconds} seconds`
}

/**
 * The note for event views while the recorder is off ("last 2 minutes, in
 * memory"), or null when the recorder runs or the backend reports nothing.
 */
export function memoryWindowNote(caps: Capabilities | null | undefined): string | null {
  if (!isRecorderOff(caps)) return null
  const seconds = caps?.memory?.window_seconds ?? DEFAULT_MEMORY_WINDOW_SECONDS
  return `last ${describeSeconds(seconds)}, in memory`
}

export const capabilities: Readable<Capabilities | null> = derived(
  identity,
  ($identity) => $identity?.capabilities ?? null,
)

export const autodiscoverOn: Readable<boolean> = derived(capabilities, isAutodiscoverOn)
export const historySearchOn: Readable<boolean> = derived(capabilities, isHistorySearchOn)
export const memoryNote: Readable<string | null> = derived(capabilities, memoryWindowNote)
export const isSplitOn: Readable<boolean> = derived(capabilities, isSplitEnabled)
export const partsBase: Readable<number | null> = derived(capabilities, splitPartsBase)
