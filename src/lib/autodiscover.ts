// Text of the Autodiscover view of the Databases tab, from
// GET /api/v1/debug/autodiscover (the registry and its cards) and
// GET /api/v1/debug/autodiscover/leases (who holds each cluster task's
// lease). Pure: the clock formatter is a parameter.

import { safeHttpBase } from './cluster'
import type { ClockFormatter } from './dbmode'
import type { CardRow, LeaseRow, RegistryStatus } from './types'

/** The cards grouped by cluster, in the order the worker sent them (own cluster first). */
export function groupByCluster(rows: CardRow[]): { cluster: string; rows: CardRow[] }[] {
  const groups: { cluster: string; rows: CardRow[] }[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.cluster === row.cluster) last.rows.push(row)
    else groups.push({ cluster: row.cluster, rows: [row] })
  }
  return groups
}

function clockOf(text: string | null, clock: ClockFormatter): string {
  return text ? clock(Date.parse(text) / 1000) : 'never'
}

/** The registry header line: provider, connection, state and the last refresh and publish. */
export function registryLine(registry: RegistryStatus, clock: ClockFormatter): string {
  const parts = [
    registry.connection
      ? `${registry.provider} (connection ${registry.connection})`
      : registry.provider,
    registry.started ? 'started' : 'not started',
    `last refresh ${clockOf(registry.refreshed_at, clock)}`,
    `last publish ${clockOf(registry.last_publish_at, clock)}`,
  ]
  if (registry.breaker_open) parts.push('breaker open')
  return parts.join(' · ')
}

/** The card's URL when it is a plain http(s) URL, else null: the card is data another worker wrote. */
export function cardLink(card: CardRow): string | null {
  return safeHttpBase(card.url) || null
}

/** The cluster task hash a card publishes (`features.periodic.cluster_hash`), or '-'. */
export function clusterHashText(card: CardRow): string {
  const periodic = card.features?.periodic
  const hash =
    periodic && typeof periodic === 'object'
      ? (periodic as Record<string, unknown>).cluster_hash
      : null
  return typeof hash === 'string' ? hash : '-'
}

/** The names of the card's features, sorted (`cache, periodic, ui`), or '-'. */
export function featureNames(card: CardRow): string {
  const names = Object.keys(card.features ?? {}).sort()
  return names.length ? names.join(', ') : '-'
}

/** The age of a lease's last refresh: `12s`, `~12s` when approximate, or '-'. */
export function leaseAgeText(holder: LeaseRow['holder']): string {
  if (!holder || holder.age_seconds === null) return '-'
  const text = `${Math.round(holder.age_seconds)}s`
  return holder.age_approximate ? `~${text}` : text
}

/** A liveness verdict as a word. */
export function livenessText(online: boolean | null): string {
  if (online === null) return 'unknown'
  return online ? 'online' : 'offline'
}

/** Time left on a lease: `45s`, `expired 30s ago`, or `-` when nobody knows. */
export function timeLeftText(seconds: number | null): string {
  if (seconds === null) return '-'
  const whole = Math.round(Math.abs(seconds))
  return seconds < 0 ? `expired ${whole}s ago` : `${whole}s`
}

/** What a lease row says about its holder. */
export function leaseStatusText(row: LeaseRow, clock: ClockFormatter): string {
  switch (row.status) {
    case 'held': {
      const who = row.holder?.worker ?? 'an unknown holder'
      return row.holder?.instance ? `held by ${who} (${row.holder.instance})` : `held by ${who}`
    }
    case 'free':
      return 'free'
    case 'not_started':
      return row.next_slot_ts !== null
        ? `the election starts at the first slot (${clock(row.next_slot_ts)})`
        : 'the election starts at the first slot'
    case 'breaker_open':
      return 'breaker open: the store was not asked'
    case 'busy':
      return 'another read runs on this worker; refresh again'
    case 'failed':
      return 'the read failed or did not answer'
    default:
      return row.status
  }
}

/** The last slot of a task on this worker, in one line. */
export function lastSlotText(row: LeaseRow, clock: ClockFormatter): string {
  if (!row.last_slot) return '-'
  return `${row.last_slot.outcome.replace('_', ' ')} at ${clock(row.last_slot.slot)}`
}
