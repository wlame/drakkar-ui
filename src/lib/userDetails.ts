// Helpers behind the probe's User-defined tab. Kept out of the Svelte
// component so vitest covers them without component-test infrastructure.
import type {
  ProbeDetail,
  ProbeDetailElement,
  ProbeDetailsColumn,
  ProbeDetailsWrite,
} from './types'
import type { SortAccessor, SortValue } from './sort'
import { badgeColor, formatValue, resolveTemplate, resolveText, type LinkBases } from './enrich'

/** Collapse per-task stage tags ("task_complete:t-abc") to their family. */
export function normalizeStage(stage: string): string {
  const idx = stage.indexOf(':')
  return idx === -1 ? stage : stage.slice(0, idx)
}

export interface StageBadge {
  stage: string
  count: number
}

/** Origin badges for one field: normalized stages, counted, in first-appearance order. */
export function stageBadges(writes: ProbeDetailsWrite[], field: string): StageBadge[] {
  const order: string[] = []
  const counts = new Map<string, number>()
  for (const write of writes) {
    if (write.field !== field) continue
    const stage = normalizeStage(write.origin_stage)
    if (!counts.has(stage)) order.push(stage)
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  return order.map((stage) => ({ stage, count: counts.get(stage)! }))
}

/** Fields that received at least one write — everything else renders dimmed. */
export function touchedFields(writes: ProbeDetailsWrite[]): Set<string> {
  return new Set(writes.map((w) => w.field))
}

type Row = Record<string, unknown>

/** Sort accessors for a details table: each column reads its own cell. */
export function tableAccessors(columns: ProbeDetailsColumn[]): Record<string, SortAccessor<Row>> {
  return Object.fromEntries(columns.map((c) => [c.key, (row: Row) => row[c.key] as SortValue]))
}

/**
 * Sub-tables of a "tables" field. The wire format is an ordered array of
 * [group, rows] pairs — never a JSON object, whose integer-like keys ("12")
 * JS would re-enumerate numerically ahead of the others, breaking the
 * first-append order both backends emit. Tolerates absent/malformed values:
 * anything that is not an array of [string, rows[]] pairs degrades to no
 * groups / empty rows.
 */
export function groupedRows(value: unknown): [string, Row[]][] {
  if (!Array.isArray(value)) return []
  return value
    .filter((pair): pair is [unknown, unknown] => Array.isArray(pair) && pair.length === 2)
    .map(([group, rows]): [string, Row[]] => [
      String(group),
      Array.isArray(rows) ? (rows as Row[]) : [],
    ])
}

/** One node of a 'tree' field's client-side grouping. */
export interface DetailsTreeNode {
  /** The grouping value at this level, stringified. */
  key: string
  /** Total rows under this node (all levels below). */
  count: number
  /** Child nodes, or null when this is a leaf level. */
  children: DetailsTreeNode[] | null
  /** The rows at a leaf node; empty for inner nodes. */
  rows: Row[]
}

/**
 * Group flat rows into a tree by the ordered `groupBy` keys, one level per
 * key, in first-appearance (append) order at every level — deterministic on
 * both backends because it derives from array order, not object key order.
 */
export function buildTree(rows: Row[], groupBy: string[]): DetailsTreeNode[] {
  if (groupBy.length === 0) return []
  const [head, ...rest] = groupBy
  const order: string[] = []
  const buckets = new Map<string, Row[]>()
  for (const row of rows) {
    const key = String(row[head] ?? '')
    if (!buckets.has(key)) {
      buckets.set(key, [])
      order.push(key)
    }
    buckets.get(key)!.push(row)
  }
  return order.map((key) => {
    const bucket = buckets.get(key)!
    if (rest.length === 0) return { key, count: bucket.length, children: null, rows: bucket }
    return { key, count: bucket.length, children: buildTree(bucket, rest), rows: [] }
  })
}

/** The columns a tree leaf shows: everything that is not a grouping key. */
export function valueColumns(
  columns: ProbeDetailsColumn[],
  groupBy: string[],
): ProbeDetailsColumn[] {
  const keys = new Set(groupBy)
  return columns.filter((c) => !keys.has(c.key))
}

/** A column sorts numerically when its first present value is a number. */
export function columnNumeric(rows: Row[], key: string): boolean {
  for (const row of rows) {
    const v = row[key]
    if (v != null) return typeof v === 'number'
  }
  return false
}

/** Resolved per-cell rendering: display text, link target, badge color, tooltip. */
export interface CellRender {
  text: string
  href: string | null
  badge: string | null // color suffix or null
  title: string | null
}

interface CellRenderOptions {
  link_template?: string | null
  badge_colors?: Record<string, string> | null
  format?: string | null
  hint?: string | null
}

/**
 * Resolves one cell's link/badge/format/hint enrichment against its value, an
 * optional sibling row (table cells only — scalars pass undefined), and the
 * configured link bases. Kept pure so UserDetailsTab can apply the result to
 * markup without duplicating this logic between table cells and scalar
 * entries.
 */
export function renderCell(
  value: unknown,
  row: Record<string, unknown> | undefined,
  opts: CellRenderOptions,
  bases: LinkBases,
): CellRender {
  const text = opts.format ? formatValue(opts.format, value) : String(value ?? '')
  const href = opts.link_template
    ? resolveTemplate(opts.link_template, { value, row, bases })
    : null
  const badge = opts.badge_colors ? badgeColor(opts.badge_colors, String(value ?? '')) : null
  // A hint always wins the tooltip; otherwise fall back to the raw value so a
  // formatted display (e.g. "1.5 KiB") doesn't hide the number behind it.
  // The hint is plain text, not a URL, so it resolves unencoded.
  const title = opts.hint
    ? resolveText(opts.hint, { value, row, bases })
    : opts.format
      ? String(value ?? '')
      : null
  return { text, href, badge, title }
}

/**
 * snake_case field name -> sentence-case label ("order_id" -> "Order id").
 * Mirrors the backend's own auto-label derivation (drakkar.probe._prettify:
 * `name.replace('_', ' ').capitalize()`) so a detail panel's client-derived
 * headings and nested-table columns look identical to server-declared ones.
 */
export function prettifyLabel(name: string): string {
  const spaced = name.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

/** A detail element's block heading: explicit label wins, else the field name prettified, else a view-specific default (only 'links' has no field). */
export function elementHeading(el: ProbeDetailElement): string {
  if (el.label) return el.label
  if (el.field) return prettifyLabel(el.field)
  return el.view === 'links' ? 'Links' : ''
}

/** Key/value pairs of a 'keyvalue' detail element's field. Non-object values (missing field, wrong type) degrade to no rows rather than throwing. */
export function keyValueEntries(value: unknown): [string, unknown][] {
  return value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>) : []
}

/** Columns for a 'table' detail element's nested table: the keys of the first row, prettified. Empty when there are no rows. */
export function nestedTableColumns(rows: Row[]): { key: string; label: string }[] {
  const first = rows[0]
  return first ? Object.keys(first).map((key) => ({ key, label: prettifyLabel(key) })) : []
}

/**
 * A detail panel's title: the declared template resolved against the clicked
 * row, falling back to the entry's own label when no template is declared or
 * the template references a missing row field / unconfigured base —
 * resolveText returns null rather than a partial string in that case. The
 * title is plain text, not a URL, so it resolves unencoded (resolveText, not
 * resolveTemplate).
 */
export function resolveDetailTitle(
  detail: ProbeDetail,
  row: Row,
  entryLabel: string,
  bases: LinkBases,
): string {
  if (detail.title) {
    const resolved = resolveText(detail.title, { row, bases })
    if (resolved !== null) return resolved
  }
  return entryLabel
}
