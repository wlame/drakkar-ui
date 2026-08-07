// Helpers behind the probe's User-defined tab. Kept out of the Svelte
// component so vitest covers them without component-test infrastructure.
import type { ProbeDetailsColumn, ProbeDetailsWrite } from './types'
import type { SortAccessor, SortValue } from './sort'

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
 * Sub-tables of a "tables" field: [group, rows] pairs in the dict's own key
 * order (first-append order end-to-end — both backends and JSON.parse keep
 * object key insertion order). Tolerates absent/malformed values: anything
 * that is not an object of arrays degrades to no groups / empty rows.
 */
export function groupedRows(value: unknown): [string, Row[]][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).map(([group, rows]) => [
    group,
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
