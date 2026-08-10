// Cluster-view helpers: which peers belong on the stacked-timeline page and
// how to reach them. The view itself lives in Live.svelte + PeerTimeline.

import type { TimelineRole } from './timelineRoles'
import type { WorkerPeer } from './types'

/**
 * Toolbar state shared by every timeline in cluster view.
 *
 * Exactly one Timeline instance renders the toolbar; its inputs read and
 * write this object (held in `$state` by the Live page), and every other
 * instance derives from it — one toolbar drives all stacked timelines.
 *
 * The two `*Seq` counters are signals, not values: "Now →" bumps followSeq
 * so each timeline re-arms its own auto-follow, and the role-override
 * handlers bump overridesSeq after writing storage so each timeline re-reads
 * its worker's overrides.
 */
export interface SharedTimelineControls {
  zoom: number
  highlightInput: string
  filterInput: string
  followSeq: number
  overridesSeq: number
  // Role overrides are stored per worker; in cluster view one gear applies
  // to every displayed worker. The Live page implements these (it knows the
  // worker list) and bumps overridesSeq after each write.
  applyRole: (role: TimelineRole, value: string | null) => void
  resetRole: (role: TimelineRole) => void
  resetAllRoles: () => void
}

/**
 * The workers to stack under the current one: every non-current worker in
 * the current worker's cluster, sorted by name for a stable layout.
 *
 * Workers without a cluster report `cluster: ""`; those match each other,
 * which reads as "the unclustered group" — acceptable for a debug view.
 */
export function sameClusterPeers(workers: WorkerPeer[]): WorkerPeer[] {
  const current = workers.find((w) => w.is_current)
  if (!current) return []
  return workers
    .filter((w) => !w.is_current && w.cluster === current.cluster)
    .sort((a, b) => a.worker_name.localeCompare(b.worker_name))
}

/**
 * The http(s) origin of a peer's debug server, without a trailing slash.
 * Prefers the advertised URL, falling back to ip:port like the header's
 * worker switcher does. Empty string when the peer advertised neither.
 */
export function peerBaseUrl(w: WorkerPeer): string {
  const base =
    w.url || (w.ip_address && w.debug_port != null ? `http://${w.ip_address}:${w.debug_port}` : '')
  return base.replace(/\/+$/, '')
}
