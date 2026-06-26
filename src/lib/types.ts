// Typed shapes for the shared Drakkar /api/v1 JSON contract. Field names and types
// are derived from the authoritative Python reference handlers (drakkar/debug/*)
// and recorder schema. Free-form JSON payloads are typed `unknown` and narrowed at
// the render site rather than asserted as `any`.

// --- Core dashboard / partitions / sinks ---

export interface DashboardStats {
  consumed: number
  completed: number
  failed: number
  produced: number
  committed: number
  total_events: number
}

export interface WebappTileClient {
  name: string
  rpm_limit: number
}

export interface WebappTile {
  inflight_count: number
  clients: WebappTileClient[]
  success_60s: number
  error_60s: number
  rejected_60s: number
  host: string
  port: number
  path: string
}

// Stat-tile keys that can carry a Prometheus deep link next to their label.
export type CardLinkKey = 'lag' | 'consumed' | 'completed' | 'failed' | 'produced'

// One titled group of Prometheus links; each entry is a [name, url] pair
// (the reference template iterates `{% for name, url in group.links %}`).
export interface DashboardLinkGroup {
  category: string
  links: [string, string][]
}

// Optional dashboard link sections (Prometheus + custom links). Key presence on
// the Dashboard payload is the feature flag: a backend without Prometheus/custom
// links configured omits `links` entirely and the UI renders nothing.
export interface DashboardLinks {
  card_links: Partial<Record<CardLinkKey, string>>
  worker_links: DashboardLinkGroup[]
  // Flat [name, url] pairs (the reference renders these as one wrap-list
  // card, not a categorized grid like worker_links).
  cluster_links: [string, string][]
  custom_links: Record<string, string>[]
}

export interface Dashboard {
  uptime: number
  stats: DashboardStats
  partition_count: number
  partitions: number[]
  pool_active: number
  pool_max: number
  total_lag: number
  webapp_tile?: WebappTile
  links?: DashboardLinks
}

export interface Partition {
  partition: number
  last_consumed: number | null
  last_committed: number | null
  last_committed_offset: number | null
  committed_offset: number | null
  high_watermark: number | null
  lag: number
  queue_size: number
  pending_offsets: number
  consumed_count: number
  completed_count: number
  failed_count: number
  is_live: boolean
}

export interface SinkStatus {
  sink_type: string
  name: string
  ui_url: string
  delivered_count: number
  delivered_payloads: number
  error_count: number
  retry_count: number
  last_delivery_ts: number | null
  last_delivery_duration: number | null
  last_error: string | null
  last_error_ts: number | null
}

// Worker self-identity from GET /api/v1/identity (v1.1, extended v1.2).
// config_summary is the one-line worker config string the reference debug
// page shows in its banner. The v1.2 fields are optional: older backends
// omit them and the UI degrades gracefully.
export interface Identity {
  worker_id: string
  cluster: string | null
  config_summary: string
  backend?: string // "python" | "go"
  backend_version?: string // backend-native: semver (py) or git-describe (go)
  ui_version?: string | null // served drakkar-ui release tag, null = built-in pages
  ui_source?: string // "release" | "builtin"
}

export interface WorkerPeer {
  worker_name: string
  cluster: string
  url: string
  is_current: boolean
  ip_address: string | null
  debug_port: number | null
  debug_url: string | null
}

// --- Events (recorder rows) ---

export interface EventRow {
  id: number
  ts: number
  dt: string
  event: string
  partition: number | null
  offset: number | null
  task_id: string | null
  args: string | null
  stdout_size: number
  stdout: string | null
  stderr: string | null
  exit_code: number | null
  duration: number | null
  output_topic: string | null
  metadata: string | null
  pid: number | null
  labels: string | null
  origin: string
  client_name: string | null
  request_id: string | null
}

// Trace rows carry the originating worker name (injected by cross_trace).
export interface TraceEvent extends EventRow {
  worker_name: string
}

// --- Live ---

export interface RecentTask {
  task_id: string
  partition: number | null
  start_ts: number
  end_ts: number | null
  duration: number | null
  status: 'running' | 'completed' | 'failed'
  args: string | null
  pid: number | null
  slot: number | null
  labels: Record<string, string> | null
  env: Record<string, string> | null
  origin: string
  client_name: string | null
  request_id: string | null
}

export interface RecentTasksResponse {
  tasks: RecentTask[]
  lane_count: number
}

export interface ArrangeTaskState {
  task_id: string
  status: 'unknown' | 'running' | 'completed' | 'failed'
  start_ts: number | null
  end_ts: number | null
  duration: number | null
  partition: number | null
  source_offsets: number[] | null
  pid: number | null
  args: string | null
  labels: Record<string, string> | null
  exit_code: number | null
  origin: string
  client_name: string | null
  request_id: string | null
}

export interface TaskResult {
  ts: number
  task_id: string | null
  partition: number | null
  source_offsets: number[] | null
  hook_duration: number | null
  exec_duration: number | null
  status: 'completed' | 'failed' | null
  exit_code: number | null
  output_message_count: number
}

export interface MessageResult {
  ts: number
  partition: number | null
  offset: number | null
  duration: number | null
  end_to_end_duration: number | null
  task_count: number
  succeeded: number
  failed: number
  replaced: number
  output_message_count: number
}

export interface WindowResult {
  ts: number
  partition: number | null
  window_id: number | null
  duration: number | null
  task_count: number
  output_message_count: number
}

// One recorder event per WS text frame. A loose superset of the per-event-type
// shapes; the discriminator is `event`. metadata/labels/args arrive as JSON strings.
export interface WsEvent {
  event: string
  ts: number
  dt?: string
  partition?: number
  offset?: number
  task_id?: string
  args?: string
  duration?: number
  exit_code?: number
  pid?: number
  pool_active?: number
  pool_waiting?: number
  slot?: number
  stdin_lines?: number
  stdin_size?: number
  stdout_size?: number
  message_count?: number
  task_count?: number
  message_labels?: string[]
  metadata?: string
  labels?: string | null
  origin?: string
  client_name?: string | null
  request_id?: string | null
}

// Composed single-task detail returned by GET /api/v1/task/{id} (contract §New
// endpoints). The event rows carry stdout/stderr; the scalar fields are the
// server-side derivation of the same lifecycle the page reconstructs client-side.
export interface TaskDetailResponse {
  task_id: string
  events: EventRow[]
  started: EventRow | null
  completed: EventRow | null
  failed: EventRow | null
  duration: number | null
  source_offsets?: unknown
  args?: unknown
  labels?: unknown
  task_env?: unknown
  partition: number | null
  pid: number | null
  exit_code: number | null
  binary_path?: string | null
  origin?: string
  client_name?: string | null
  request_id?: string | null
  webapp_request_body?: unknown
  webapp_response_body?: unknown
}

// Bootstrap snapshot for the whole app (pool sizes, tuning, hook flags, kafka-ui
// config) from GET /api/v1/live/overview. Fetched once at boot to hydrate the
// runtime config and again by the Live page. All fields optional → graceful.
export interface LiveOverview {
  worker_id?: string
  pool_active?: number
  pool_max?: number
  pool_waiting?: number
  partition_count?: number
  max_ui_rows?: number
  ws_min_duration_ms?: number
  hook_flags?: {
    task_complete?: boolean
    message_complete?: boolean
    window_complete?: boolean
  }
  kafka_ui_base?: string
  kafka_ui_cluster?: string
  kafka_source_topic?: string
}

// --- Debug: metrics / periodic / trace ---

export interface MetricSample {
  name: string
  labels: Record<string, string>
  value: number
}

export interface MetricFamily {
  name: string
  type: string
  help: string
  source: 'framework' | 'user'
  samples: MetricSample[]
}

export interface PeriodicRecent {
  ts: number
  duration: number | null
  status: string
  error: string
}

export interface PeriodicTask {
  name: string
  last_run_ts: number
  last_duration: number | null
  last_status: string
  last_error: string
  system: boolean
  total_ok: number
  total_error: number
  recent: PeriodicRecent[]
}

// --- Debug: databases ---

export interface DbInfo {
  filename: string
  path: string
  worker_name: string
  cluster_name: string
  event_count: number
  event_counts: Record<string, number>
  first_event_ts: number | null
  last_event_ts: number | null
  has_events: boolean
  has_config: boolean
  has_state: boolean
  size_bytes: number
}

export interface MergeResult {
  filename: string
  worker_count: number
  event_count: number
  state_count: number
  cluster_name: string
  source_files: string[]
}

// --- Debug: cache ---

export type CacheScope = 'local' | 'cluster' | 'global'

export interface CacheStats {
  entries_in_memory: number
  bytes_in_memory: number
  entries_in_db: number
  bytes_in_db: number
}

export interface CacheEntryRow {
  key: string
  scope: CacheScope
  value: string
  size_bytes: number
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number | null
  origin_worker_id: string
}

export interface CacheEntriesResponse {
  entries: CacheEntryRow[]
  total: number
  limit: number
  offset: number
}

export interface CacheEntryDetail {
  key: string
  scope: CacheScope
  size_bytes: number
  created_at_ms: number
  updated_at_ms: number
  expires_at_ms: number | null
  origin_worker_id: string
  value: unknown
  raw_value: string
}

// --- Debug: message probe ---

export interface ProbeRequest {
  value: string
  key: string | null
  partition: number
  offset: number
  topic: string
  use_cache: boolean
}

export interface ProbeError {
  stage: string
  exception_class: string
  message: string
  traceback: string
  occurred_at_ms: number
}

export interface CollectResult {
  kafka: unknown[]
  postgres: unknown[]
  mongo: unknown[]
  http: unknown[]
  redis: unknown[]
  files: unknown[]
  custom: unknown[]
}

export interface ProbeStageResult {
  duration_seconds: number | null
  collect_result: CollectResult | null
  error: string | null
}

export interface ProbeTaskEntry {
  task_id: string
  parent_task_id: string | null
  labels: Record<string, string>
  source_offsets: number[]
  precomputed: boolean
  status: 'done' | 'failed' | 'replaced'
  exit_code: number | null
  duration_seconds: number | null
  stdin: string
  stdout: string
  stderr: string
  subprocess_exception: string | null
  on_task_complete_duration: number | null
  on_task_complete_result: CollectResult | null
  on_task_complete_error: string | null
  retry_of: string | null
  replacement_for: string | null
}

export interface ProbeCacheCall {
  op: 'get' | 'set' | 'peek' | 'delete' | 'contains'
  key: string
  scope: string | null
  outcome: 'hit' | 'miss' | 'suppressed'
  value_preview: string | null
  origin_stage: string
  ms_since_start: number
}

export interface PlannedSinkRecord {
  sink_type: string
  destination: string
  origin_stage: string
  payload: unknown
  extras: Record<string, unknown>
}

export interface ProbeCacheSummary {
  calls: number
  hits: number
  misses: number
  writes_suppressed: number
}

export interface ProbeTiming {
  total_wallclock?: number
  arrange?: number
  on_message_complete?: number
  on_window_complete?: number
}

export interface DebugReport {
  input: ProbeRequest & { timestamp?: number | null }
  deserialize_error: ProbeError | null
  parsed_payload: unknown
  message_label: string | null
  arrange: ProbeStageResult
  tasks: ProbeTaskEntry[]
  on_message_complete: ProbeStageResult | null
  on_window_complete: ProbeStageResult | null
  planned_sink_payloads: PlannedSinkRecord[]
  cache_calls: ProbeCacheCall[]
  cache_summary: ProbeCacheSummary
  timing: ProbeTiming
  errors: ProbeError[]
  truncated: boolean
}
