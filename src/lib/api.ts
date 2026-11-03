// Typed client for the shared Drakkar /api/v1 JSON contract. Every Drakkar
// backend — the Python reference and the Go port — serves this identical
// contract, which is exactly what lets one static UI work against any of them.
// The full endpoint catalog and canonical shapes are pinned in this repo's
// docs/api-contract-v1.md; the shapes live in ./types.

import type {
  ArrangeTaskState,
  AutodiscoverResponse,
  LeasesResponse,
  PostgresPartitions,
  CacheEntriesResponse,
  CacheEntryDetail,
  CacheStats,
  ConfigReferenceResponse,
  Dashboard,
  DatabasesResponse,
  DebugReport,
  EventRow,
  Identity,
  LiveOverview,
  MergeResult,
  MetricFamily,
  Partition,
  PeriodicTask,
  ProbeRequest,
  RecentTasksResponse,
  RuntimeHealthSnapshot,
  RuntimeUnitCensus,
  SliceRequest,
  SinkStatus,
  ConsumePauseState,
  KafkaReadMessage,
  KafkaReadTopic,
  TaskDetailResponse,
  TaskResult,
  MessageResult,
  WindowResult,
  TraceEvent,
  UIPage,
  WorkerPeer,
} from './types'

// Re-export the contract shapes so pages can `import { api, type Dashboard }`
// from a single module, matching the original scaffold's ergonomics.
export type * from './types'

const API_BASE = '/api/v1'

// authToken resolves the optional bearer token. A `?token=` in the URL wins and
// is remembered (so deep links work); otherwise a previously stored token is
// reused. Empty when auth is disabled — the dev-trust default — in which case
// requests carry no Authorization header.
function authToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token')
  if (fromUrl) {
    localStorage.setItem('drakkar_token', fromUrl)
    return fromUrl
  }
  return localStorage.getItem('drakkar_token') ?? ''
}

function authHeaders(): Record<string, string> {
  const token = authToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// HttpError is a failed response: the message carries the status AND the
// body text — the message probe and database merge both return their error
// detail in the body (422 validation, 400/404 {error:...}), which the UI
// renders verbatim. `status` lets a caller tell "not there" (404) apart.
export class HttpError extends Error {
  readonly status: number

  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} → HTTP ${status}${body ? `: ${body}` : ''}`)
    this.name = 'HttpError'
    this.status = status
  }
}

async function fail(method: string, path: string, res: Response): Promise<never> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    // ignore — body may be unavailable
  }
  throw new HttpError(method, path, res.status, body)
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() })
  if (!res.ok) return fail('GET', path, res)
  return (await res.json()) as T
}

// getFrom reads a route from another worker of the cluster (the fan-out).
// base is that worker's http(s) origin without a trailing slash, '' for the
// page's own worker. The same token goes to every worker, as on the Live
// page's sockets; the read is cross-origin, so the worker answers CORS.
async function getFrom<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${base}${API_BASE}${path}`, { headers: authHeaders(), signal })
  if (!res.ok) return fail('GET', path, res)
  return (await res.json()) as T
}

// getOptional reads a route a backend may not have: null for a 404 (an older
// backend, or a route that does not apply to this worker).
async function getOptional<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() })
  if (res.status === 404) return null
  if (!res.ok) return fail('GET', path, res)
  return (await res.json()) as T
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: authHeaders() })
  if (!res.ok) return fail('DELETE', path, res)
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  })
  if (!res.ok) return fail('POST', path, res)
  return (await res.json()) as T
}

// qs builds a query string, skipping nullish/empty values so optional filters drop
// out entirely (the contract treats an absent param as "no filter").
function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    sp.set(k, String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// wsUrlFor builds the WebSocket URL for the live stream of an arbitrary worker,
// given its http(s) origin. Browsers can't set an Authorization header on a WS
// handshake, so the token rides as `?token=` when configured (the backend
// accepts either) — appended with `&` when the path already carries a query
// (e.g. `/ws?events=...`). /ws is served at the site root, not under /api/v1.
export function wsUrlFor(origin: string, path = '/ws'): string {
  const url = new URL(path, origin)
  const proto = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = authToken()
  const sep = url.search ? '&' : '?'
  const tokenPart = token ? `${sep}token=${encodeURIComponent(token)}` : ''
  return `${proto}//${url.host}${url.pathname}${url.search}${tokenPart}`
}

// wsUrl is wsUrlFor pinned to the page's own origin — the normal same-origin case.
export function wsUrl(path = '/ws'): string {
  return wsUrlFor(window.location.origin, path)
}

// withAuthToken appends `?token=` to a same-origin URL the browser will fetch
// on its own — a `<a>` navigation, an `<iframe>` src — none of which can carry
// an Authorization header. Unchanged when auth is disabled. The token goes
// BEFORE any `#fragment`: a fragment is never sent to the server, so a token
// placed after it would not reach the backend at all.
export function withAuthToken(url: string): string {
  const token = authToken()
  if (!token) return url
  const hashAt = url.indexOf('#')
  const base = hashAt === -1 ? url : url.slice(0, hashAt)
  const fragment = hashAt === -1 ? '' : url.slice(hashAt)
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}token=${encodeURIComponent(token)}${fragment}`
}

// downloadUrl builds a same-tab navigation URL (e.g. a DB download). Like the WS
// handshake, a plain `<a>` navigation can't carry an Authorization header, so the
// token is appended as a query param when set.
export function downloadUrl(path: string): string {
  return withAuthToken(`${API_BASE}${path}`)
}

// sliceQuery writes the slice filters as the query string of the route (3.3 of
// the design): lists are comma separated, `output` is sent only when off.
export function sliceQuery(r: SliceRequest): string {
  return qs({
    from: r.from,
    to: r.to,
    scope: r.scope,
    sources: r.sources?.join(','),
    partition: r.partition,
    offset_from: r.offset_from,
    offset_to: r.offset_to,
    task_id: r.task_id,
    events: r.events?.join(','),
    label_key: r.label_key,
    label_value: r.label_value,
    output: r.output === false ? '0' : undefined,
    max_rows: r.max_rows,
    compress: r.compress,
  })
}

export interface EventsQuery {
  partitions?: string // comma-separated partition ids
  event_types?: string // comma-separated event names
  origin?: string // kafka | http
  after_id?: number
  limit?: number
  offset?: number
}

// api is the single object pages import. Add an endpoint by adding a method —
// each is a thin typed projection of one contract route.
export const api = {
  // Core pages
  dashboard: () => get<Dashboard>('/dashboard'),
  identity: () => get<Identity>('/identity'),
  partitions: () => get<Partition[]>('/partitions'),
  sinks: () => get<SinkStatus[]>('/sinks'),
  workers: () => get<WorkerPeer[]>('/workers'),
  uiPages: () => get<UIPage[]>('/pages'),

  // Events / tasks / history
  events: (q: EventsQuery = {}) => get<EventRow[]>(`/events${qs({ ...q })}`),
  task: (id: string) => get<TaskDetailResponse>(`/task/${encodeURIComponent(id)}`),
  recentTasks: (minutes = 2) => get<RecentTasksResponse>(`/recent-tasks${qs({ minutes })}`),

  // Custom timeline events (contract v1.21): history backfill for the
  // timeline's visible window. 404 is a defined contract answer (a backend
  // that predates the feature) — mapped to null, not an error, same idiom
  // as runtimeHealth/debugArchives above. The body shape is vetted by
  // timelineEvents.ts's eventsFromHistory, not here.
  timelineEvents: async (minutes?: number): Promise<unknown | null> => {
    const path = `/timeline/events${qs({ minutes })}`
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) return fail('GET', path, res)
    return (await res.json()) as unknown
  },

  // Live
  liveOverview: () => get<LiveOverview>('/live/overview'),
  liveTaskResults: (limit = 200) => get<TaskResult[]>(`/live/task-results${qs({ limit })}`),
  liveMessageResults: (limit = 200) =>
    get<MessageResult[]>(`/live/message-results${qs({ limit })}`),
  liveWindowResults: (limit = 200) => get<WindowResult[]>(`/live/window-results${qs({ limit })}`),
  arrangeTasks: (taskIds: string[]) =>
    post<Record<string, ArrangeTaskState>>('/live/arrange-tasks', { task_ids: taskIds }),
  sinkBreakdown: (partition: number, offsets: number[]) =>
    post<Record<string, number>>('/live/sink-breakdown', { partition, offsets }),

  // Runtime health. 404 is a defined contract answer (monitor disabled, or
  // a backend that does not implement it) — mapped to null, not an error.
  runtimeHealth: async (): Promise<RuntimeHealthSnapshot | null> => {
    const res = await fetch(`${API_BASE}/runtime/health`, { headers: authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) return fail('GET', '/runtime/health', res)
    return (await res.json()) as RuntimeHealthSnapshot
  },
  debugRuntimeUnits: () => get<RuntimeUnitCensus>('/debug/runtime/units'),

  // Debug: metrics / periodic / trace
  debugMetrics: () => get<MetricFamily[]>('/debug/metrics'),
  debugPeriodic: () => get<PeriodicTask[]>('/debug/periodic'),
  // history=true searches only the cluster history of the serving worker
  // (sealed files, or its Postgres history since v1.26); without it, only that worker's own files.
  debugTrace: (partition: number, offset: number, history = false) =>
    get<TraceEvent[]>(`/debug/trace${qs({ partition, offset, history: history ? 1 : undefined })}`),
  debugLabelKeys: () => get<string[]>('/debug/label-keys'),
  debugTraceByLabel: (key: string, value: string) =>
    get<TraceEvent[]>(`/debug/trace-by-label${qs({ key, value })}`),
  // The same two reads on another worker of the cluster (v1.23 fan-out);
  // base '' is the page's own worker. Own files only: the sealed history
  // is read once, on the page's own worker, with debugTrace(..., true).
  debugTraceAt: (base: string, partition: number, offset: number, signal?: AbortSignal) =>
    getFrom<TraceEvent[]>(base, `/debug/trace${qs({ partition, offset })}`, signal),
  debugTraceByLabelAt: (base: string, key: string, value: string, signal?: AbortSignal) =>
    getFrom<TraceEvent[]>(base, `/debug/trace-by-label${qs({ key, value })}`, signal),

  // Debug: message probe
  debugProbe: (req: ProbeRequest) => post<DebugReport>('/debug/probe', req),

  // Debug: databases (v1.23). A pre-v1.23 backend answers an array; that
  // maps to null so the tab can say the view is not available there instead
  // of rendering the old layout.
  debugDatabases: async (): Promise<DatabasesResponse | null> => {
    const body = await get<DatabasesResponse | unknown[]>('/debug/databases')
    return Array.isArray(body) ? null : body
  },
  // The databases answer of another worker of the cluster (v1.23 fan-out);
  // null for a pre-v1.23 array answer, as above.
  // `parts` asks the peer for those parts only (a backend that does not know
  // the parameter ignores it and answers in full). A worker that does not
  // know one of the parts answers 400 (v1.30); the read is then made once
  // more without `parts`, so a newer UI still reads an older worker.
  debugDatabasesAt: async (
    base: string,
    signal?: AbortSignal,
    parts?: string[],
  ): Promise<DatabasesResponse | null> => {
    const read = (query: string) =>
      getFrom<DatabasesResponse | unknown[]>(base, `/debug/databases${query}`, signal)
    let body: DatabasesResponse | unknown[]
    try {
      body = await read(parts?.length ? `?parts=${parts.join(',')}` : '')
    } catch (e) {
      if (!parts?.length || !(e instanceof HttpError) || e.status !== 400) throw e
      body = await read('')
    }
    return Array.isArray(body) ? null : body
  },
  // A snapshot of a worker's live recorder file (v1.23), since v1.25 of its
  // memory store, and since v1.30 of its cache file: a plain <a> navigation,
  // so the token rides as ?token=. `compress` asks for a gzip stream (v1.30);
  // offer it only to a worker that sends the v1.30 `recorder` block.
  debugDownloadLiveUrl: (
    base: string,
    source: 'memory' | 'file' | 'cache',
    compress = false,
  ): string =>
    withAuthToken(
      `${base}${API_BASE}/debug/download-live?source=${source}${compress ? '&compress=gzip' : ''}`,
    ),
  // The slice download of a worker (v1.30): a plain navigation to that
  // worker's origin, so the file body is never read into the page.
  debugSliceUrl: (base: string, request: SliceRequest): string =>
    withAuthToken(`${base}${API_BASE}/debug/slice${sliceQuery(request)}`),
  // Whether a worker has the slice route. A call with no filters is refused
  // with 400 where the route exists and answers 404 where it does not; null
  // when the answer says nothing (unreachable, blocked).
  debugSliceSupportedAt: async (base: string, signal?: AbortSignal): Promise<boolean | null> => {
    try {
      const res = await fetch(`${base}${API_BASE}/debug/slice`, { headers: authHeaders(), signal })
      return res.status !== 404
    } catch {
      return null
    }
  },
  // paths are relative to storage.shared_dir: history/<cluster>/<name>.db or merged/<name>.db.
  debugMerge: (paths: string[]) => post<MergeResult>('/debug/merge', { filenames: paths }),
  // Delete one merge result (merged/<name>.db, v1.30). The worker answers 403
  // while ui.delete_enabled is off and 409 while it sends or merges the file.
  debugDeleteFile: (path: string) =>
    del(`/debug/files/${path.split('/').map(encodeURIComponent).join('/')}`),
  // The partitions of the recorder's Postgres table (v1.30); null when the
  // worker's provider is not postgres or the backend predates the route.
  debugPostgres: () => getOptional<PostgresPartitions>('/debug/databases/postgres'),
  // The registry and its cards (v1.30); null with autodiscover off or on an
  // older backend.
  debugAutodiscover: () => getOptional<AutodiscoverResponse>('/debug/autodiscover'),
  // The cluster task leases (v1.30); null on an older backend.
  debugLeases: () => getOptional<LeasesResponse>('/debug/autodiscover/leases'),
  // Each segment is encoded; the / separators stay (the route takes a path).
  // `compress` asks for a gzip stream (v1.30); never for an archive.
  debugDownloadUrl: (path: string, compress = false) =>
    downloadUrl(
      `/debug/download/${path.split('/').map(encodeURIComponent).join('/')}${compress ? '?compress=gzip' : ''}`,
    ),

  // Debug: consume pause (contract v1.14). Timed pause of the pipeline
  // consumer — never leaves the consumer group, auto-resumes at the
  // deadline. The state endpoint always answers; the mutating calls 403
  // unless the deployment opted in (ui.consume_pause.enabled).
  consumePauseState: () => get<ConsumePauseState>('/debug/consume-pause'),
  consumePause: (durationSeconds: number) =>
    post<ConsumePauseState>('/debug/consume-pause', { duration_seconds: durationSeconds }),
  consumeResume: () => post<ConsumePauseState>('/debug/consume-resume', {}),

  // Debug: kafka read (contract v1.13). Ad-hoc reads of the configured
  // topics by alias (source / dlq / sink instance name) — no consumer-group
  // side effects on the backend.
  kafkaTopics: () => get<{ topics: KafkaReadTopic[] }>('/debug/kafka/topics'),
  kafkaMessage: (alias: string, partition: number, offset: number) =>
    get<KafkaReadMessage>(
      `/debug/kafka/${encodeURIComponent(alias)}/message${qs({ partition, offset })}`,
    ),
  // The stream endpoint answers NDJSON: one message object per line, with a
  // mid-stream broker failure reported as a final {"error": ...} line (the
  // 200 is committed by then). The whole body is read at once — the server
  // caps a request at 10000 messages, so buffering is bounded.
  kafkaMessages: async (
    alias: string,
    q: { from_ts: number; to_ts?: number; limit?: number; partition?: number },
  ): Promise<{ messages: KafkaReadMessage[]; streamError: string | null }> => {
    const path = `/debug/kafka/${encodeURIComponent(alias)}/messages${qs({
      from_ts: q.from_ts,
      to_ts: q.to_ts,
      limit: q.limit,
      partition: q.partition,
    })}`
    const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() })
    if (!res.ok) return fail('GET', path, res)
    const text = await res.text()
    const messages: KafkaReadMessage[] = []
    let streamError: string | null = null
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      const obj = JSON.parse(line) as KafkaReadMessage | { error: string }
      if ('error' in obj) {
        streamError = obj.error
      } else {
        messages.push(obj)
      }
    }
    return { messages, streamError }
  },

  // Debug: cache browser
  cacheStats: () => get<CacheStats>('/debug/cache/stats'),
  cacheEntries: (
    q: {
      limit?: number
      offset?: number
      scope?: string
      search?: string
      expired_only?: boolean
    } = {},
  ) =>
    get<CacheEntriesResponse>(
      `/debug/cache/entries${qs({
        limit: q.limit,
        offset: q.offset,
        scope: q.scope,
        search: q.search,
        expired_only: q.expired_only ? 'true' : undefined,
      })}`,
    ),
  cacheEntry: (key: string) =>
    get<CacheEntryDetail>(`/debug/cache/entry/${encodeURIComponent(key)}`),

  // Debug: config reference
  configReference: () => get<ConfigReferenceResponse>('/config-reference'),
}
