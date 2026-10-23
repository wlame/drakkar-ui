// The cluster fan-out (contract v1.23): the Trace and Databases tabs read
// their per-worker data from every worker of the current worker's cluster,
// not from the page's own worker alone. One slow or dead worker must never
// block or empty the page: each call has its own timeout, and the workers
// that did not answer are listed with a reason next to the rows of the
// workers that did.

import { HttpError } from './api'
import { peerBaseUrl, sameClusterPeers } from './cluster'
import type { WorkerPeer } from './types'

// A worker to read from: its name and its http(s) origin without a trailing
// slash ('' = the page's own worker, read same-origin).
export interface FanOutTarget {
  worker: string
  base: string
}

export interface FanOutResult<T> extends FanOutTarget {
  value: T
}

export interface Unreachable {
  worker: string
  reason: string
}

export interface FanOutAnswer<T> {
  results: FanOutResult<T>[]
  unreachable: Unreachable[]
}

// How long one worker may take to answer one fan-out read.
export const PEER_TIMEOUT_MS = 5000

/**
 * The workers to fan out to: the current worker first (on the page's own
 * origin), then its same-cluster peers that are not offline, by name. A peer
 * without an address is listed as unreachable. Without a current worker in
 * the list (an older backend, a failed workers call) the page's own worker
 * alone, unnamed.
 */
export function fanOutTargets(workers: WorkerPeer[]): {
  targets: FanOutTarget[]
  unreachable: Unreachable[]
} {
  const current = workers.find((w) => w.is_current)
  const targets: FanOutTarget[] = [{ worker: current?.worker_name ?? '', base: '' }]
  const unreachable: Unreachable[] = []
  for (const peer of sameClusterPeers(workers)) {
    const base = peerBaseUrl(peer)
    if (base) targets.push({ worker: peer.worker_name, base })
    else unreachable.push({ worker: peer.worker_name, reason: 'no address' })
  }
  return { targets, unreachable }
}

/** A short reason for a worker that did not answer. */
export function unreachableReason(error: unknown, timedOut: boolean): string {
  if (timedOut) return 'timed out'
  if (error instanceof HttpError) {
    return error.status === 404 ? 'not available on this worker' : `HTTP ${error.status}`
  }
  // fetch rejects with a TypeError for a refused connection, a DNS failure
  // and a cross-origin answer the browser blocks (no CORS headers): from
  // the page these all look the same.
  return 'unreachable'
}

/** How many fan-out calls may be in flight at once. */
export const FANOUT_CONCURRENCY = 6

/**
 * Run call against every target, each with its own timeout, with at most
 * `concurrency` calls in flight at once. The answer keeps the targets'
 * order; nothing here throws.
 */
export async function fanOut<T>(
  targets: FanOutTarget[],
  call: (target: FanOutTarget, signal: AbortSignal) => Promise<T>,
  timeoutMs = PEER_TIMEOUT_MS,
  concurrency = FANOUT_CONCURRENCY,
): Promise<FanOutAnswer<T>> {
  type Settled = { target: FanOutTarget; value: T | null; error: unknown; timedOut: boolean }
  const settled: Settled[] = new Array(targets.length)
  async function runOne(index: number): Promise<void> {
    const target = targets[index]
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      settled[index] = {
        target,
        value: await call(target, controller.signal),
        error: null,
        timedOut,
      }
    } catch (error) {
      settled[index] = { target, value: null, error, timedOut }
    } finally {
      clearTimeout(timer)
    }
  }
  // A small pool: each lane takes the next unstarted target until none is left.
  let next = 0
  async function lane(): Promise<void> {
    while (next < targets.length) await runOne(next++)
  }
  const lanes = Math.max(1, Math.min(Math.floor(concurrency) || 1, targets.length))
  await Promise.all(Array.from({ length: lanes }, lane))
  const results: FanOutResult<T>[] = []
  const unreachable: Unreachable[] = []
  for (const one of settled) {
    if (one.error === null) results.push({ ...one.target, value: one.value as T })
    else
      unreachable.push({
        worker: one.target.worker,
        reason: unreachableReason(one.error, one.timedOut),
      })
  }
  return { results, unreachable }
}
