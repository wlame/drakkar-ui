// The slice download of the Databases tab (design 2.6, 3.3, 3.6): the filter
// rules of GET /api/v1/debug/slice in TypeScript, so the UI refuses a bad
// request before it builds the link, the sources a worker has, and the links
// of a whole-cluster slice. Pure: the Svelte view only draws what is here.

import { DB_RANGES, type DbViewState } from './dbview'
import type { FanOutTarget } from './fanout'
import type { DatabasesResponse, SliceRequest } from './types'

export const SLICE_MAX_RANGE_SECONDS = 604800
export const SLICE_DEFAULT_MAX_ROWS = 200000
export const SLICE_MAX_ROWS = 1000000
export const SLICE_BUILD_LIMIT_SECONDS = 60
/** The epoch seconds a bound may take: up to the last second of the year 9999. */
export const SLICE_MAX_EPOCH = 253402300799

/**
 * The recorder's event types (`EventType` in the recorder schema). The form
 * offers these; the request check below tests the shape only, because a newer
 * backend may know more types than this list.
 */
export const RECORDER_EVENT_TYPES = [
  'consumed',
  'arranged',
  'assigned',
  'revoked',
  'committed',
  'partition_stalled',
  'message_complete',
  'window_complete',
  'task_started',
  'task_completed',
  'task_failed',
  'task_complete',
  'produced',
  'sink_delivered',
  'sink_error',
  'message_dlq',
  'sink_not_started',
  'runtime_health',
  'runtime_stall',
  'runtime_lag_episode',
  'runtime_probe',
  'resource_sample',
  'annotation',
  'periodic_run',
  'offload',
  'webapp_request_received',
  'webapp_request_completed',
  'webapp_request_timeout',
  'webapp_request_rate_limited',
  'webapp_request_auth_failed',
  'webapp_request_dropped_after_timeout',
] as const

const MAX_PARTITION = 2147483647
const MAX_TASK_ID = 256
const MAX_LABEL_KEY = 128
const MAX_LABEL_VALUE = 1024
const MAX_EVENTS = 40
const MIN_OFFSET = -(2n ** 63n)
const MAX_OFFSET = 2n ** 63n - 1n
const OFFSET_RE = /^-?[0-9]+$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*$/
const UNSAFE_NAME_CHARS = /[^a-zA-Z0-9_-]/g

/** The limits the server enforces, shown next to the form. */
export const SLICE_LIMITS_TEXT = [
  'A range of at most 7 days.',
  'A file of at most 1 GiB, or 64 MiB on a worker without storage.dir (built in memory).',
  `At most ${SLICE_DEFAULT_MAX_ROWS.toLocaleString()} rows unless you raise it (up to ${SLICE_MAX_ROWS.toLocaleString()}).`,
  `One build at a time on a worker, at most ${SLICE_BUILD_LIMIT_SECONDS} s; a limit ends the file early and marks it partial.`,
  'Archives are never read: download the archive itself.',
]

type DbRange = (typeof DB_RANGES)[number]

export const RANGE_PRESET_SECONDS: Record<DbRange, number> = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '6h': 21600,
  '24h': 86400,
}

/** The range of the URL state in epoch seconds: `db_from` and `db_to`, else the preset back from now. */
export function resolveRange(
  state: Pick<DbViewState, 'range' | 'from' | 'to'>,
  nowSeconds: number,
): { from: number; to: number } {
  if (state.from !== null && state.to !== null) return { from: state.from, to: state.to }
  return { from: nowSeconds - RANGE_PRESET_SECONDS[state.range], to: nowSeconds }
}

/** The filters that are typed per visit and never ride in the URL. */
export interface SliceForm {
  taskId: string
  labelValue: string
  output: boolean
  /** null = the server default. */
  maxRows: number | null
  compress: boolean
}

export const EMPTY_SLICE_FORM: SliceForm = {
  taskId: '',
  labelValue: '',
  output: true,
  maxRows: null,
  compress: false,
}

/** The request of the form and the URL state. A whole-cluster request sends no `sources`. */
export function buildSliceRequest(
  state: DbViewState,
  form: SliceForm,
  nowSeconds: number,
): SliceRequest {
  const request: SliceRequest = { ...resolveRange(state, nowSeconds), scope: state.scope }
  if (state.scope === 'worker' && state.sources)
    request.sources = state.sources as SliceRequest['sources']
  if (state.partition !== null) request.partition = state.partition
  if (state.offsets) {
    const [from, to] = state.offsets.split('-')
    request.offset_from = from
    request.offset_to = to
  }
  if (form.taskId) request.task_id = form.taskId
  if (state.types) request.events = state.types
  if (state.labelKey) request.label_key = state.labelKey
  if (form.labelValue) request.label_value = form.labelValue
  if (!form.output) request.output = false
  if (form.maxRows !== null) request.max_rows = form.maxRows
  if (form.compress) request.compress = 'gzip'
  return request
}

/** A signed 64-bit whole number written in ASCII digits. */
function isOffset(text: string): boolean {
  if (!OFFSET_RE.test(text)) return false
  const value = BigInt(text)
  return value >= MIN_OFFSET && value <= MAX_OFFSET
}

/** Length in characters (code points), as the server counts it; `.length` counts UTF-16 units. */
function charCount(text: string): number {
  return [...text].length
}

function isWholeNumber(n: number | undefined, min: number, max: number): boolean {
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max
}

/**
 * The first rule the request breaks, in the order and with the words of the
 * server (design 3.9), or null. `available` are the sources the worker has;
 * it is not checked for a whole-cluster request, which sends no sources.
 */
export function validateSliceRequest(r: SliceRequest, available: readonly string[]): string | null {
  if (![r.from, r.to].every((t) => Number.isFinite(t) && t >= 0 && t <= SLICE_MAX_EPOCH)) {
    return 'from and to must be finite numbers of epoch seconds'
  }
  if (r.to <= r.from) return 'to must be greater than from'
  if (r.to - r.from > SLICE_MAX_RANGE_SECONDS) return 'the time range is at most 168h'
  if (r.scope !== undefined && r.scope !== 'worker' && r.scope !== 'cluster') {
    return 'scope must be worker or cluster'
  }
  if (r.scope !== 'cluster') {
    const missing = (r.sources ?? []).find((s) => !available.includes(s))
    if (missing !== undefined) {
      const listed = available.length ? [...available].sort().join(', ') : 'none'
      return `source '${missing}' is not available on this worker; available: ${listed}`
    }
  }
  if (r.partition !== undefined && !isWholeNumber(r.partition, 0, MAX_PARTITION)) {
    return 'partition must be a whole number from 0 to 2147483647'
  }
  const hasOffsets = r.offset_from !== undefined || r.offset_to !== undefined
  if (hasOffsets && r.partition === undefined) return 'offset_from and offset_to need partition'
  if (![r.offset_from, r.offset_to].every((o) => o === undefined || isOffset(o))) {
    return 'offset_from and offset_to must be whole numbers from -9223372036854775808 to 9223372036854775807'
  }
  if (
    r.offset_from !== undefined &&
    r.offset_to !== undefined &&
    BigInt(r.offset_from) > BigInt(r.offset_to)
  ) {
    return 'offset_from must not be greater than offset_to'
  }
  if (r.task_id !== undefined && (charCount(r.task_id) < 1 || charCount(r.task_id) > MAX_TASK_ID)) {
    return 'task_id must be 1 to 256 characters'
  }
  if ((r.events ?? []).length > MAX_EVENTS) return 'events must name at most 40 event types'
  const badEvent = (r.events ?? []).find((e) => !EVENT_TYPE_RE.test(e))
  if (badEvent !== undefined) return `event '${badEvent}' is not a recorder event type`
  if ((r.label_key === undefined) !== (r.label_value === undefined)) {
    return 'give label_key and label_value together'
  }
  if (
    r.label_key !== undefined &&
    (charCount(r.label_key) < 1 ||
      charCount(r.label_key) > MAX_LABEL_KEY ||
      /["\\]/.test(r.label_key))
  ) {
    return 'label_key must be 1 to 128 characters without " or \\'
  }
  if (
    r.label_value !== undefined &&
    (charCount(r.label_value) < 1 || charCount(r.label_value) > MAX_LABEL_VALUE)
  ) {
    return 'label_value must be 1 to 1024 characters'
  }
  if (r.max_rows !== undefined && !isWholeNumber(r.max_rows, 1, SLICE_MAX_ROWS)) {
    return 'max_rows must be a whole number from 1 to 1000000'
  }
  if (r.compress !== undefined && r.compress !== 'gzip') return 'compress must be gzip'
  return null
}

// --- What a worker has (design 2.8) ---

/** What the source rules read of a worker's databases answer. */
export type WorkerView = Pick<DatabasesResponse, 'own' | 'history' | 'recorder'>

export type RecorderProvider = 'none' | 'sqlite' | 'postgres'

/** The recorder provider: the `recorder` block, else read from the kinds of rows the worker lists. */
export function providerOf(data: WorkerView): RecorderProvider {
  if (data.recorder) return data.recorder.provider
  const kinds = new Set((data.own ?? []).map((o) => o.kind))
  const hasHistory = (data.history?.folders ?? []).some((f) => f.files.length > 0)
  if (kinds.has('live') || kinds.has('backlog') || hasHistory) return 'sqlite'
  return 'none'
}

/** The sources a worker-scope slice can read on this worker. */
export function sourcesFor(data: WorkerView): string[] {
  const provider = providerOf(data)
  if (provider === 'postgres') return ['memory', 'postgres']
  const hasMemory =
    data.recorder?.memory != null || (data.own ?? []).some((o) => o.kind === 'memory')
  if (provider === 'sqlite') return ['memory', 'files', 'history']
  return hasMemory ? ['memory'] : []
}

/** A whole-cluster slice needs the shared history or the table; with the recorder off the server answers 409. */
export function canSliceCluster(data: WorkerView): boolean {
  return providerOf(data) !== 'none'
}

// --- File name preview (design 3.3) ---

function utcStamp(epochSeconds: number): string {
  const iso = new Date(epochSeconds * 1000).toISOString()
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replaceAll(':', '-')}`
}

function sanitize(name: string | null | undefined, fallback: string): string {
  return name ? name.replace(UNSAFE_NAME_CHARS, '_') : fallback
}

/** The attachment name the server will use for a complete slice. */
export function sliceFileName(
  r: Pick<SliceRequest, 'from' | 'to' | 'scope' | 'compress'>,
  names: { worker: string; cluster: string | null },
): string {
  const owner =
    r.scope === 'cluster'
      ? `${sanitize(names.cluster, 'default')}-cluster`
      : sanitize(names.worker, 'worker')
  const suffix = r.compress ? '.db.gz' : '.db'
  return `${owner}-slice-${utcStamp(r.from)}__${utcStamp(r.to)}${suffix}`
}

// --- Links, per worker and for the whole cluster (design 3.6, ruling DB-Q4) ---

export interface SliceLink {
  /** Where the file is built: '' is the page's own worker. */
  base: string
  worker: string
  label: string
  request: SliceRequest
}

export interface SlicePlan {
  /** Worker links first: a file sealed meanwhile is then in both, never in none. */
  links: SliceLink[]
  notes: string[]
}

function workerLabel(target: FanOutTarget): string {
  return target.worker || 'this worker'
}

/** One link per worker, each building its own part with the request as it is. */
export function perWorkerLinks(request: SliceRequest, targets: FanOutTarget[]): SliceLink[] {
  return targets.map((t) => ({
    base: t.base,
    worker: t.worker,
    label: workerLabel(t),
    request: { ...request, scope: 'worker' },
  }))
}

const POSTGRES_NOTE = 'The newest seconds may be missing: rows reach the table within about 5 s.'
const SQLITE_NOTE =
  'The cluster file holds the sealed history only; each worker link holds the unsealed part (up to the rotation interval).'
const OFF_NOTE =
  'The recorder is off: there is no shared source, so each worker link holds its memory only.'

/**
 * The links of a whole-cluster slice built by `builder` (design 3.6).
 * `postgres`: one cluster file, no worker links. `sqlite`: a link per worker
 * for its unsealed part (sources `files`), listed first, then the cluster
 * file of the sealed history. Recorder off: a link per worker for its memory;
 * no cluster file (it would answer 409).
 */
export function clusterPlan(
  provider: RecorderProvider,
  request: SliceRequest,
  builder: FanOutTarget,
  targets: FanOutTarget[],
): SlicePlan {
  const clusterFile: SliceLink = {
    base: builder.base,
    worker: builder.worker,
    label: 'Cluster file',
    request: { ...request, scope: 'cluster', sources: undefined },
  }
  if (provider === 'postgres') return { links: [clusterFile], notes: [POSTGRES_NOTE] }
  const part = (sources: NonNullable<SliceRequest['sources']>) =>
    perWorkerLinks({ ...request, sources }, targets).map((l) => ({
      ...l,
      label: `Unsealed part of ${l.label}`,
    }))
  if (provider === 'sqlite') {
    return { links: [...part(['files']), clusterFile], notes: [SQLITE_NOTE] }
  }
  return { links: part(['memory']), notes: [OFF_NOTE] }
}

/** The target that builds the slice: the picked worker, else the page's own one. */
export function resolveBuilder(
  pickedWorker: string | null,
  own: FanOutTarget,
  targets: FanOutTarget[],
): FanOutTarget | null {
  if (pickedWorker === null || pickedWorker === own.worker) return own
  return targets.find((t) => t.worker === pickedWorker) ?? null
}

// --- Local time for the from and to inputs ---

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Epoch seconds as the text of a `datetime-local` input, in the browser's time zone. */
export function toLocalInput(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The epoch seconds of a `datetime-local` text, or null for a text that is not a time. */
export function fromLocalInput(text: string): number | null {
  const ms = Date.parse(text)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}
