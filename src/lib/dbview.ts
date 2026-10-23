// URL state of the Databases tab: the keys that start with `db_` in the query
// string. Parsing validates every value and falls back to the default for a
// missing or bad one; writing merges into the current query and keeps every
// key it does not own (the token, other pages' keys).

export const DB_VIEWS = ['files', 'postgres', 'slice', 'autodiscover'] as const
export type DbViewName = (typeof DB_VIEWS)[number]

export const DB_KINDS = ['sealed', 'archive', 'merged'] as const
export const DB_RANGES = ['5m', '15m', '1h', '6h', '24h'] as const
export const DB_SCOPES = ['worker', 'cluster'] as const
export const DB_SOURCES = ['memory', 'files', 'history', 'postgres'] as const

/** The `db_worker` value that means every worker of the cluster. */
export const ALL_WORKERS = '*'

export interface DbViewState {
  view: DbViewName
  /** null = the page's own worker; ALL_WORKERS = the whole cluster; else a worker name. */
  worker: string | null
  cluster: string | null
  kind: (typeof DB_KINDS)[number] | null
  range: (typeof DB_RANGES)[number]
  /** Epoch seconds; both set replace `range`. */
  from: number | null
  to: number | null
  scope: (typeof DB_SCOPES)[number]
  sources: string[] | null
  types: string[] | null
  partition: number | null
  offsets: string | null
  labelKey: string | null
}

export const DB_DEFAULTS: DbViewState = {
  view: 'files',
  worker: null,
  cluster: null,
  kind: null,
  range: '15m',
  from: null,
  to: null,
  scope: 'worker',
  sources: null,
  types: null,
  partition: null,
  offsets: null,
  labelKey: null,
}

const MAX_NAME_LENGTH = 256
const MAX_PARTITION = 2147483647
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*$/
const OFFSETS_RE = /^\d{1,18}-\d{1,18}$/

// Query key of each state field.
const KEYS: Record<keyof DbViewState, string> = {
  view: 'db_view',
  worker: 'db_worker',
  cluster: 'db_cluster',
  kind: 'db_kind',
  range: 'db_range',
  from: 'db_from',
  to: 'db_to',
  scope: 'db_scope',
  sources: 'db_sources',
  types: 'db_types',
  partition: 'db_partition',
  offsets: 'db_offsets',
  labelKey: 'db_label_key',
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return allowed.find((a) => a === value) ?? null
}

function name(value: string | null): string | null {
  return value && value.length <= MAX_NAME_LENGTH ? value : null
}

function wholeNumber(value: string | null, max: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const n = Number(value)
  return Number.isSafeInteger(n) && n <= max ? n : null
}

// A comma list with every item valid and no repeat; any bad item drops the whole key.
function list(value: string | null, valid: (item: string) => boolean): string[] | null {
  if (!value) return null
  const items = value.split(',')
  if (!items.every(valid) || new Set(items).size !== items.length) return null
  return items
}

/** Read the `db_*` keys of a query string; a bad or missing value gives the default. */
export function parseDbView(query: string): DbViewState {
  const q = new URLSearchParams(query)
  const get = (field: keyof DbViewState) => q.get(KEYS[field])
  const from = wholeNumber(get('from'), Number.MAX_SAFE_INTEGER)
  const to = wholeNumber(get('to'), Number.MAX_SAFE_INTEGER)
  const hasWindow = from !== null && to !== null && to > from
  const offsets = get('offsets')
  return {
    view: oneOf(DB_VIEWS, get('view')) ?? DB_DEFAULTS.view,
    worker: name(get('worker')),
    cluster: name(get('cluster')),
    kind: oneOf(DB_KINDS, get('kind')),
    range: oneOf(DB_RANGES, get('range')) ?? DB_DEFAULTS.range,
    from: hasWindow ? from : null,
    to: hasWindow ? to : null,
    scope: oneOf(DB_SCOPES, get('scope')) ?? DB_DEFAULTS.scope,
    sources: list(get('sources'), (s) => (DB_SOURCES as readonly string[]).includes(s)),
    types: list(get('types'), (t) => t.length <= 64 && EVENT_TYPE_RE.test(t)),
    partition: wholeNumber(get('partition'), MAX_PARTITION),
    offsets: offsets && OFFSETS_RE.test(offsets) ? offsets : null,
    labelKey: name(get('labelKey')),
  }
}

function serialize(field: keyof DbViewState, value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value === DB_DEFAULTS[field]) return null
  return Array.isArray(value) ? value.join(',') : String(value)
}

/**
 * The query string after applying `change` to the current one: it sets or
 * clears the owned keys (a default value clears the key) and keeps every
 * other key. The result has no leading `?` and is empty when nothing is left.
 */
export function writeDbView(query: string, change: Partial<DbViewState>): string {
  const q = new URLSearchParams(query)
  for (const field of Object.keys(change) as (keyof DbViewState)[]) {
    const text = serialize(field, change[field])
    if (text === null) q.delete(KEYS[field])
    else q.set(KEYS[field], text)
  }
  return q.toString()
}

// A step Back should undo pushes; a fine change replaces the entry.
const PUSH_FIELDS: (keyof DbViewState)[] = ['view', 'worker']

/** True when the change is a step the Back button should undo. */
export function isPushChange(change: Partial<DbViewState>): boolean {
  return PUSH_FIELDS.some((field) => field in change)
}
