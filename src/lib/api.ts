// Typed client for the shared Drakkar /api/v1 JSON contract. Every Drakkar
// backend — the Python reference and the Go port — serves this identical
// contract, which is exactly what lets one static UI work against any of them.
// The full endpoint catalog and canonical shapes are pinned in this repo's
// docs/api-contract-v1.md; the shapes live in ./types.

import type {
  ArchivesResponse,
  ArrangeTaskState,
  CacheEntriesResponse,
  CacheEntryDetail,
  CacheStats,
  ConfigReferenceResponse,
  Dashboard,
  DbInfo,
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

// On a failed response, surface the status AND the body text — the message probe
// and database merge both return their error detail in the body (422 validation,
// 400/404 {error:...}), which the UI renders verbatim.
async function fail(method: string, path: string, res: Response): Promise<never> {
  let body = ''
  try {
    body = await res.text()
  } catch {
    // ignore — body may be unavailable
  }
  throw new Error(`${method} ${path} → HTTP ${res.status}${body ? `: ${body}` : ''}`)
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() })
  if (!res.ok) return fail('GET', path, res)
  return (await res.json()) as T
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

// downloadUrl builds a same-tab navigation URL (e.g. a DB download). Like the WS
// handshake, a plain `<a>` navigation can't carry an Authorization header, so the
// token is appended as a query param when set.
export function downloadUrl(path: string): string {
  const token = authToken()
  return `${API_BASE}${path}${token ? `?token=${encodeURIComponent(token)}` : ''}`
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
  debugTrace: (partition: number, offset: number) =>
    get<TraceEvent[]>(`/debug/trace${qs({ partition, offset })}`),
  debugLabelKeys: () => get<string[]>('/debug/label-keys'),
  debugTraceByLabel: (key: string, value: string) =>
    get<TraceEvent[]>(`/debug/trace-by-label${qs({ key, value })}`),

  // Debug: message probe
  debugProbe: (req: ProbeRequest) => post<DebugReport>('/debug/probe', req),

  // Debug: databases
  debugDatabases: () => get<DbInfo[]>('/debug/databases'),
  debugMerge: (filenames: string[]) => post<MergeResult>('/debug/merge', { filenames }),
  debugDownloadUrl: (filename: string) =>
    downloadUrl(`/debug/download/${encodeURIComponent(filename)}`),

  // Debug: archives (v1.8). 404 is a defined contract answer (a backend
  // that predates archiving) — mapped to null, not an error, so the
  // Archives section can hide itself rather than showing a banner (same
  // idiom as runtimeHealth above).
  debugArchives: async (): Promise<ArchivesResponse | null> => {
    const res = await fetch(`${API_BASE}/debug/archives`, { headers: authHeaders() })
    if (res.status === 404) return null
    if (!res.ok) return fail('GET', '/debug/archives', res)
    return (await res.json()) as ArchivesResponse
  },
  debugArchiveDownloadUrl: (name: string) =>
    downloadUrl(`/debug/archives/${encodeURIComponent(name)}`),

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
