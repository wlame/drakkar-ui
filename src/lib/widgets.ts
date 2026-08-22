// Data layer for declared-page widgets (GET /api/v1/pages). Turns a widget's
// `source` declaration into rows or a scalar by dispatching to the existing
// events/tasks/metrics endpoints — no new backend surface, just projections
// of data the debug pages already fetch. Kept out of WidgetBody.svelte so
// vitest covers it without component-test infrastructure (same split as
// userDetails.ts behind UserDetailsTab.svelte).
import { api } from './api'
import type { UIPageWidget } from './types'

// One row of widget data; shape depends on the source kind.
export type WidgetRow = Record<string, unknown>

const DEFAULT_LIMIT = 200

function sourceLimit(source: UIPageWidget['source']): number {
  return typeof source.limit === 'number' ? source.limit : DEFAULT_LIMIT
}

// Parses one annotation event's metadata envelope into a widget row. Malformed
// or absent JSON degrades to an empty envelope rather than dropping the row —
// annotations are handler-emitted diagnostics and a widget author's
// kind_prefix filter should still see (and exclude) a row with a blank kind
// rather than have it silently vanish. Not reused from events.ts's
// parseAnnotation: that helper validates the envelope against the stricter
// Annotation shape (returns null outright when `kind` isn't a string) and is
// gated on event === 'annotation', which duplicates the event_types filter
// already applied by the /events query below.
function annotationRow(row: { ts: number; metadata: string | null }): WidgetRow {
  let parsed: Record<string, unknown> = {}
  try {
    const decoded: unknown = JSON.parse(row.metadata ?? '{}')
    if (decoded && typeof decoded === 'object') parsed = decoded as Record<string, unknown>
  } catch {
    // malformed metadata -> empty envelope, row survives with ts/kind stamped
  }
  return { ...parsed, ts: row.ts, kind: typeof parsed.kind === 'string' ? parsed.kind : '' }
}

// Fetches and normalizes rows for a widget. Unknown source kind -> null (the
// renderer shows the unsupported-widget placeholder); a recognized kind that
// has no row concept (metrics) -> [] rather than null, since that source is
// still "supported", just scalar-only (see fetchStatValue).
export async function fetchWidgetRows(w: UIPageWidget): Promise<WidgetRow[] | null> {
  const source = w.source
  switch (source.kind) {
    case 'events': {
      const eventTypes = Array.isArray(source.event_types)
        ? (source.event_types as unknown[]).map(String)
        : []
      const rows = await api.events({
        event_types: eventTypes.join(','),
        limit: sourceLimit(source),
      })
      return rows as unknown as WidgetRow[]
    }
    case 'annotations': {
      const prefix = typeof source.kind_prefix === 'string' ? source.kind_prefix : ''
      const rows = await api.events({ event_types: 'annotation', limit: sourceLimit(source) })
      return rows.map(annotationRow).filter((row) => String(row.kind ?? '').startsWith(prefix))
    }
    case 'tasks': {
      const rows = await api.liveTaskResults(sourceLimit(source))
      return rows as unknown as WidgetRow[]
    }
    case 'metrics':
      return []
    default:
      return null
  }
}

// Sums the samples of the named metric family; null when the family is
// missing (metric not yet emitted, or a typo in the declared source).
export async function fetchStatValue(metric: string): Promise<number | null> {
  const families = await api.debugMetrics()
  const family = families.find((f) => f.name === metric)
  if (!family) return null
  return family.samples.reduce((sum, sample) => sum + sample.value, 0)
}

// The scalar a string/badge widget shows: newest row's field (rows arrive
// newest-first from every source), null when there are no rows or the field
// is absent on the newest one.
export function scalarValue(rows: WidgetRow[], field: string): unknown {
  if (rows.length === 0) return null
  const value = rows[0][field]
  return value === undefined ? null : value
}

// WS event types a widget's source implies, for refresh subscriptions.
export function refreshEventTypes(w: UIPageWidget): string[] {
  switch (w.source.kind) {
    case 'events':
      return Array.isArray(w.source.event_types)
        ? (w.source.event_types as unknown[]).map(String)
        : []
    case 'annotations':
      return ['annotation']
    case 'tasks':
      return ['task_complete', 'task_completed', 'task_failed']
    default:
      return []
  }
}
