// Client-side library for operator-declared custom timeline events (contract
// v1.21): parsing live WS frames and the history-backfill endpoint into a
// common view, geometry, link resolution, task matching, and per-browser
// visibility overrides. Pure module — no DOM beyond localStorage, no
// component wiring here (see timelineRoles.ts for the sibling pattern this
// follows).

import type { TaskView } from './live'
import type { TimelineEventDecl, WsEvent } from './types'

// One instance's match hint, telling the UI which task(s) an 'action:
// highlight|filter' declaration should apply to. Exactly one variant, or
// null when the instance carries none (contract v1.21).
export type EventMatch =
  { window_id: number } | { offsets: [number, number][] } | { label: [string, string] }

// A parsed custom-event instance, flattened from either an annotation WS
// frame or a /timeline/events history row. `ts`/`endTs` are seconds (the
// timeline's own unit — see lib/timeline.ts), converted from the wire's
// epoch-millisecond integers.
export interface TimelineEventView {
  type: string
  ts: number
  endTs: number | null
  text: string
  values: Record<string, unknown>
  match: EventMatch | null
  partition: number
}

// parseEventMatch reads `data.match` out of an instance envelope. Untrusted
// input: any shape other than the three documented variants (or null)
// resolves to null rather than throwing.
function parseEventMatch(raw: unknown): EventMatch | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>

  if (typeof m.window_id === 'number') return { window_id: m.window_id }

  if (Array.isArray(m.offsets)) {
    const pairs = m.offsets.filter(
      (p): p is [number, number] =>
        Array.isArray(p) && p.length === 2 && typeof p[0] === 'number' && typeof p[1] === 'number',
    )
    return { offsets: pairs }
  }

  if (
    Array.isArray(m.label) &&
    m.label.length === 2 &&
    typeof m.label[0] === 'string' &&
    typeof m.label[1] === 'string'
  ) {
    return { label: [m.label[0], m.label[1]] }
  }

  return null
}

// eventFromEnvelope builds a TimelineEventView from an already-parsed
// metadata envelope object (shared by the WS and history paths below).
// Requires `kind === 'timeline_event'` and a `data` object with a string
// `type` and numeric `ts_ms` — anything else is not a usable instance.
function eventFromEnvelope(
  env: Record<string, unknown>,
  partition: number,
): TimelineEventView | null {
  if (env.kind !== 'timeline_event') return null
  if (!env.data || typeof env.data !== 'object') return null
  const data = env.data as Record<string, unknown>
  if (typeof data.type !== 'string' || typeof data.ts_ms !== 'number') return null

  return {
    type: data.type,
    ts: data.ts_ms / 1000,
    endTs: typeof data.end_ts_ms === 'number' ? data.end_ts_ms / 1000 : null,
    text: typeof data.text === 'string' ? data.text : '',
    values:
      data.values && typeof data.values === 'object'
        ? (data.values as Record<string, unknown>)
        : {},
    match: parseEventMatch(data.match),
    partition,
  }
}

/**
 * Parses one custom-event instance out of an `annotation` WS frame. Gates on
 * `e.event === 'annotation'`, then on metadata carrying a `timeline_event`
 * envelope — anything else (a different annotation kind, malformed JSON, a
 * missing `data.type`/`data.ts_ms`) returns null rather than throwing, since
 * the frame is untrusted wire input.
 */
export function eventFromWsEvent(e: WsEvent): TimelineEventView | null {
  if (e.event !== 'annotation' || !e.metadata) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(e.metadata)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  return eventFromEnvelope(parsed as Record<string, unknown>, e.partition ?? -1)
}

/**
 * Vets and parses the `GET /timeline/events` response body
 * (`{events: [...], unavailable: boolean}`). Each entry is the metadata
 * envelope plus `ts`/`partition` from the event row — already a JSON object,
 * not a string to re-parse. Garbage at the top level, or an individual
 * malformed entry, is dropped rather than thrown: a payload with no usable
 * `events` array yields `[]`.
 */
export function eventsFromHistory(payload: unknown): TimelineEventView[] {
  const obj =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
  const entries = Array.isArray(obj?.events) ? obj.events : null
  if (!entries) return []

  const out: TimelineEventView[] = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const env = entry as Record<string, unknown>
    const partition = typeof env.partition === 'number' ? env.partition : -1
    const parsed = eventFromEnvelope(env, partition)
    if (parsed) out.push(parsed)
  }
  return out
}

/**
 * Position and width of one event in the timeline's fixed-origin coordinate
 * space, following the `(ts - originTs) * pxPerSec` convention shared with
 * task bars (lib/timeline.ts). A point event (no `endTs`) has no width; a
 * range event's width is clamped to at least 1px so a very short range still
 * renders as a visible sliver.
 */
export function eventGeometry(
  ev: TimelineEventView,
  originTs: number,
  pxPerSec: number,
): { left: number; width: number | null } {
  const left = (ev.ts - originTs) * pxPerSec
  if (ev.endTs == null) return { left, width: null }
  const width = Math.max(1, (ev.endTs - ev.ts) * pxPerSec)
  return { left, width }
}

// Named substitution values a link template can reference, beyond the
// fixed ts_ms/end_ts_ms/text triplet: the event's own `values` map, then
// the identity's `link_bases` (later entries win on a name collision, per
// the contract's stated substitution order).
//
// ts_ms/end_ts_ms are pure numbers, safe to insert raw; linkBases entries are
// trusted URL prefixes (operator-configured, not event data), also inserted
// raw. text and every values entry, by contrast, are attacker/handler-
// controlled strings landing inside a URL — percent-encoded so a value like
// `sha: "abc&admin=1#frag"` can't inject query params or truncate the
// template into the fragment. Same split as src/lib/enrich.ts's
// resolveTemplate: the base is trusted and raw, {value}/{row.*} substitutions
// are encoded.
function linkVariables(
  ev: TimelineEventView,
  linkBases: Record<string, string>,
): Record<string, string> {
  const vars: Record<string, string> = {
    ts_ms: String(Math.round(ev.ts * 1000)),
    text: encodeURIComponent(ev.text),
  }
  if (ev.endTs != null) vars.end_ts_ms = String(Math.round(ev.endTs * 1000))
  for (const [k, v] of Object.entries(ev.values)) vars[k] = encodeURIComponent(String(v))
  for (const [k, v] of Object.entries(linkBases)) vars[k] = v
  return vars
}

/**
 * Resolves a declaration's `link` template against one event instance.
 * Substitutes `{ts_ms}`, `{end_ts_ms}`, `{text}`, any `{<values key>}`, and
 * any `{<linkBases name>}`. `text` and `values` substitutions are
 * percent-encoded (see {@link linkVariables}); `ts_ms`/`end_ts_ms`/linkBases
 * are inserted raw. Any `{var}` left unresolved (including `{end_ts_ms}` on
 * a point event with no end) means "render without a link" — the contract
 * for a template that outran what this instance can fill in — so the whole
 * result is null rather than a partially-substituted URL.
 */
export function resolveEventLink(
  decl: TimelineEventDecl,
  ev: TimelineEventView,
  linkBases: Record<string, string>,
): string | null {
  if (!decl.link) return null
  const vars = linkVariables(ev, linkBases)

  let unresolved = false
  const result = decl.link.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name]
    unresolved = true
    return ''
  })
  return unresolved ? null : result
}

/**
 * Whether a task matches an instance's `match` hint, used to drive
 * `action: highlight|filter` declarations. `TaskView` has no `window_id`
 * field of its own, so the `window_id` variant always returns false rather
 * than throwing — the same "field TaskView lacks" rule the `offsets`/`label`
 * variants follow for their own missing inputs (a null `source_offsets`, or
 * no `labels` at all).
 */
export function matchesEventMatch(task: TaskView, match: EventMatch): boolean {
  if ('window_id' in match) return false

  if ('offsets' in match) {
    if (task.source_offsets == null) return false
    const offsets = task.source_offsets
    return match.offsets.some(
      ([partition, offset]) => partition === task.partition && offsets.includes(offset),
    )
  }

  if ('label' in match) {
    const [key, value] = match.label
    return task.labels?.[key] === value
  }

  return false
}

function storageKey(workerId: string): string {
  return `dk.timeline.events.${workerId}`
}

/**
 * Reads the browser-local visibility overrides for a worker's declared
 * event types. Absent-safe: no stored value, a read error (e.g. private-mode
 * localStorage denial), or corrupted JSON all resolve to `{}`.
 */
export function loadEventVisibility(workerId: string): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(storageKey(workerId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>
    }
    return {}
  } catch {
    return {}
  }
}

/**
 * Sets one event type's visibility override for a worker, silently doing
 * nothing if storage is unavailable or over quota (private-mode safety).
 */
export function saveEventVisibility(workerId: string, name: string, visible: boolean): void {
  const overrides = loadEventVisibility(workerId)
  overrides[name] = visible
  try {
    localStorage.setItem(storageKey(workerId), JSON.stringify(overrides))
  } catch {
    // Silent no-op: private-mode storage denial or quota exceeded.
  }
}

/**
 * Merges each declaration's default `show` flag with a viewer's local
 * overrides: an overridden name uses the stored value; everything else
 * follows the declared default. An override for a name with no matching
 * declaration is ignored.
 */
export function resolveEventVisibility(
  decls: TimelineEventDecl[],
  overrides: Record<string, boolean>,
): Record<string, boolean> {
  const result: Record<string, boolean> = {}
  for (const decl of decls) {
    result[decl.name] = decl.name in overrides ? overrides[decl.name] : decl.show
  }
  return result
}

// --- per-type track layout --------------------------------------------------
//
// The overlay used to draw every event on one shared 14px rail with an
// always-on horizontal label; at real densities the labels overlapped into
// noise. These helpers implement the replacement: one track per event type,
// with a density ladder inside each track (cluster -> horizontal label ->
// vertical label) so the rail degrades gracefully instead of garbling.
// Pure functions only — Timeline.svelte derives the tracks from them and
// owns all DOM/rendering.

/**
 * A group of items collapsed together because they sit within `collapsePx`
 * of the cluster's anchor (its first, leftmost member) — the same
 * anchor-relative merge `deriveMarkers` uses for role-marker pins in
 * lib/timeline.ts, so a dense burst of same-type events doesn't draw as
 * unreadable overlapping labels.
 */
export interface EventCluster<T> {
  left: number
  members: T[]
}

/**
 * Groups `items` (each carrying a pixel `left`) into left-to-right clusters:
 * an item within `collapsePx` of the cluster's anchor joins it, otherwise it
 * starts a new cluster. Items are sorted by `left` first, so callers may pass
 * them in any order (events arrive newest-first off the wire).
 */
export function clusterEvents<T extends { left: number }>(
  items: T[],
  collapsePx: number,
): EventCluster<T>[] {
  const sorted = [...items].sort((a, b) => a.left - b.left)
  const clusters: EventCluster<T>[] = []
  for (const item of sorted) {
    const prev = clusters[clusters.length - 1]
    if (prev && item.left - prev.left <= collapsePx) {
      prev.members.push(item)
    } else {
      clusters.push({ left: item.left, members: [item] })
    }
  }
  return clusters
}

/** Default merge distance for event clusters, in px — mirrors deriveMarkers'
 * own collapse distance in lib/timeline.ts so the two overlays feel the same
 * at a given zoom level. */
export const EVENT_TRACK_COLLAPSE_PX = 12

/** Rough per-character width estimate for a chip label at the `.event-chip`
 * font (9px monospace), used to decide what fits without touching the DOM —
 * the same style of estimate as `TEXT_PX_PER_CHAR` in lib/timeline.ts for bar
 * tags, tuned to the smaller chip font. */
export const EVENT_LABEL_PX_PER_CHAR = 5

// Padding a horizontal label needs before the next cluster, so text doesn't
// visually touch the next chip even when the width estimate is exact.
const LABEL_EDGE_GAP_PX = 6

/** Char cap a vertical-mode label is trimmed to. `writing-mode: vertical-rl`
 * spends real vertical space per character, so only a handful fit before the
 * track height itself would have to grow past the tall 44px cap. */
export const VERTICAL_LABEL_MAX_CHARS = 6

/** Track height, in px, while every visible chip fits horizontally (or is a
 * cluster glyph). */
export const TRACK_BASE_HEIGHT_PX = 16
/** Track height, in px, once at least one visible chip needs vertical mode. */
export const TRACK_TALL_HEIGHT_PX = 44

export type TrackChipMode = 'cluster' | 'horizontal' | 'vertical'

export interface TrackChip<T> {
  left: number
  mode: TrackChipMode
  members: T[]
  /** What to draw: "+N" for a cluster, the (possibly trimmed) label otherwise. */
  displayLabel: string
}

/**
 * Truncates `label` to at most `maxChars`, replacing the tail with a single
 * ellipsis character when it would otherwise overflow — mirrors
 * `truncateToChars` in lib/timeline.ts for bar tags/captions.
 */
export function trimLabelForVertical(
  label: string,
  maxChars: number = VERTICAL_LABEL_MAX_CHARS,
): string {
  if (label.length <= maxChars) return label
  return label.slice(0, maxChars - 1) + '…'
}

/**
 * Lays out one event type's chips into the density ladder: cluster first
 * (a multi-member group within `collapsePx` becomes a single "+N" glyph),
 * then for every surviving single-member cluster, decide whether its label
 * fits horizontally in the gap before the next cluster or must switch to
 * vertical text, trimmed to {@link VERTICAL_LABEL_MAX_CHARS}.
 *
 * A cluster with no next neighbor is always tried horizontally — there is
 * nothing ahead of it on the track to collide with. Zooming in spreads
 * clusters apart and grows the gaps between them, which is what naturally
 * walks chips back down the ladder (cluster -> vertical -> horizontal)
 * without this function knowing about zoom at all.
 */
export function layoutTrack<T extends { left: number; label: string }>(
  items: T[],
  collapsePx: number = EVENT_TRACK_COLLAPSE_PX,
): TrackChip<T>[] {
  const clusters = clusterEvents(items, collapsePx)
  return clusters.map((cluster, i) => {
    if (cluster.members.length > 1) {
      return {
        left: cluster.left,
        mode: 'cluster' as const,
        members: cluster.members,
        displayLabel: `+${cluster.members.length}`,
      }
    }
    const label = cluster.members[0].label
    const next = clusters[i + 1]
    const available = next ? next.left - cluster.left - LABEL_EDGE_GAP_PX : Number.POSITIVE_INFINITY
    const fits = available >= label.length * EVENT_LABEL_PX_PER_CHAR
    const mode: TrackChipMode = fits ? 'horizontal' : 'vertical'
    return {
      left: cluster.left,
      mode,
      members: cluster.members,
      displayLabel: fits ? label : trimLabelForVertical(label),
    }
  })
}

/**
 * Whether a track needs the tall height: true once any of its chips is in
 * vertical mode. Callers pass the chip list already culled to the viewport,
 * so scrolling a wide vertical label off-screen shrinks the track back down
 * on the next pass.
 */
export function trackHeight(chips: { mode: TrackChipMode }[]): number {
  return chips.some((c) => c.mode === 'vertical') ? TRACK_TALL_HEIGHT_PX : TRACK_BASE_HEIGHT_PX
}

/**
 * Which declared event types get a track: currently visible (gear-resolved,
 * not just the declared default) AND represented by at least one instance in
 * the loaded buffer. Order follows `decls` (declaration order), so tracks
 * don't reorder as events arrive.
 *
 * Deliberately reads the full instance buffer, not a viewport-culled slice —
 * a track that appeared and disappeared every time the operator scrolled
 * would be more distracting than useful.
 */
export function qualifyingEventTracks(
  decls: TimelineEventDecl[],
  events: TimelineEventView[],
  visibility: Record<string, boolean>,
): TimelineEventDecl[] {
  const typesPresent = new Set(events.map((e) => e.type))
  return decls.filter((d) => visibility[d.name] !== false && typesPresent.has(d.name))
}
