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

// One condition of a timeline color rule (ui.timeline.color_rules[].when[]):
// a task label or a task field compared with op/value. Exactly one of
// label/field is set by a compliant backend; value is absent for the
// value-less ops exists/missing.
export interface TimelineCondition {
  label?: string
  field?: string
  op: string
  value?: string | number
}

// A first-match-wins bar-coloring rule. `when` is always an array (AND of
// its conditions), even when the source config wrote a single condition.
// `name` is '' when the rule has no display name — the legend falls back to
// generated condition text in that case.
export interface TimelineColorRule {
  name: string
  when: TimelineCondition[]
  color: string
}

// Which task label fills each special timeline role (tag/caption/highlight/
// filter/marker). Only bound roles are present; an unbound role is absent
// entirely, never an empty string.
export interface TimelineRoleBindings {
  tag?: string
  caption?: string
  highlight?: string
  filter?: string
  marker?: string
}

// Timeline history depth, bar-color rules, and label-role bindings from
// ui.timeline (v1.7). See src/lib/timelineRules.ts for the color-rule engine.
export interface TimelineConfig {
  history_factor: number
  max_age_minutes: number
  color_rules: TimelineColorRule[]
  labels: TimelineRoleBindings
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
  ui_source?: string // "release" | "embedded" | "builtin"
  // Named link-template bases (ui.link_bases), always present (possibly {})
  // on a fresh backend; absent entirely on backends that predate enrichment.
  link_bases?: Record<string, string>
  // Whether this backend has a deployment-provided renderers.js module
  // configured (ui.custom_renderers_path). Absent on backends that predate
  // the feature; gates whether loadCustomRenderers() is worth calling at all.
  custom_renderers?: boolean
  // ui.timeline config, verbatim. Absent on backends that predate it — the
  // UI keeps its legacy fixed-window, fixed-color timeline behavior then.
  timeline?: TimelineConfig
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
  // Captured stdout byte count; null while the task is running and on
  // failed-only tasks. Selected on the resync path (v1.7) so color rules
  // keyed on it work for resync-loaded rows, not only WS-updated ones.
  stdout_size?: number | null
}

export interface RecentTasksResponse {
  tasks: RecentTask[]
  lane_count: number
  /**
   * The server hit its row cap and older tasks inside the requested window are
   * missing. Surfaced rather than swallowed so a partial timeline is not shown
   * as a complete one — on a high-fan-out worker the cap is reachable.
   */
  truncated?: boolean
  /**
   * The recorder data could not be read at all (no reader connection, or the
   * bounded main-loop dispatch timed out), so the rest of this payload is an
   * empty placeholder rather than a measurement. Absent on backends that
   * predate the flag — those answer a degraded read with a bare `[]`, which
   * `normalizeRecentTasks` treats the same way. Clients keep the tasks they
   * already show and surface a notice; they never render this as "no tasks".
   */
  unavailable?: boolean
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
  /** WS-only companion to stdout_size on task_completed frames; absent on older backends. */
  stdout_lines?: number
  message_count?: number
  task_count?: number
  message_labels?: string[]
  metadata?: string
  labels?: string | null
  origin?: string
  client_name?: string | null
  request_id?: string | null
}

// --- Runtime health (GET /api/v1/runtime/health + /api/v1/debug/runtime/units) ---

/** One second of lag history: max and average over the ticks in it. */
export interface RuntimeLagBucket {
  t: number
  max_lag_ms: number
  avg_lag_ms: number
}

/** One recent stall, without stacks — those ride the runtime_stall event. */
export interface RuntimeStallSummary {
  t: number
  duration_ms: number
  stack_count: number
  top_location: string | null
}

export interface RuntimeHealthSnapshot {
  enabled: boolean
  state: 'healthy' | 'degraded' | 'stalled'
  /** What unit_count counts on this backend: "tasks" or "goroutines". */
  unit_label: string
  current_lag_ms: number
  heartbeat_age_ms: number
  window: RuntimeLagBucket[]
  recent_stalls: RuntimeStallSummary[]
}

/** Units sharing one (name, suspension point) pair. */
export interface RuntimeUnitGroup {
  name: string
  location: string
  count: number
  example: string
}

export interface RuntimeUnitCensus {
  unit_label: string
  total: number
  units: RuntimeUnitGroup[]
}

/** Payload of a runtime_stall event's metadata JSON. */
export interface RuntimeStallPayload {
  duration_ms: number
  stacks: { stack: string; location: string; count: number }[]
  dropped_stacks: number
  unit_count: number
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
  // Key-presence is the feature flag (contract v1.10): only backends with
  // an offload thread pool behind handler.offload() send this; the Go
  // worker omits it and the readout stays hidden.
  offload?: {
    running?: number
    queued?: number
    max_threads?: number
  }
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

// --- Debug: archives ---

// One compressed recorder archive (GET /api/v1/debug/archives, v1.8): a
// merged, gzip-compressed sqlite db that a periodic archive pass folded a
// finished time window into and removed the raw files for. Parsed entirely
// from the file name `<cluster>-<from>__<to>.db.gz` on the backend, so
// from_ts/to_ts are epoch-seconds window bounds, not per-event timestamps.
// Archives are terminal — never candidates for /debug/merge, so this type
// deliberately has no filename-selection counterpart in the UI.
export interface ArchiveEntry {
  name: string
  cluster: string
  from_ts: number
  to_ts: number
  size_bytes: number
}

// GET /api/v1/debug/archives response envelope. archives is newest-first by
// to_ts, already sorted server-side — the UI renders it as received.
export interface ArchivesResponse {
  archives: ArchiveEntry[]
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

// --- Debug: config reference ---

// One config field joined against the live worker's actual value (GET
// /api/v1/config-reference). `env` and `value` are null for an unexpanded `*`
// template entry (a dynamic-instance field with zero configured instances) —
// there is no single env var or live value to report. `secret` values arrive
// pre-masked as '••••••' from the server; the UI never sees the real value.
export interface ConfigReferenceEntry {
  path: string
  env: string | null
  description: string
  full_description: string
  type: string
  value: unknown
  default: unknown
  is_default: boolean
  secret: boolean
}

export interface ConfigReferenceGroup {
  key: string
  title: string
  doc_anchor: string
  entries: ConfigReferenceEntry[]
}

export interface ConfigReferenceResponse {
  groups: ConfigReferenceGroup[]
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
  /** Language-specific class name; treat as opaque. */
  exception_class: string
  message: string
  /**
   * Not required by the schema. There is deliberately NO `traceback` field:
   * the contract forbids emitting it (docs/api-contract-v1.md, divergence 7)
   * — tracebacks stay server-side.
   */
  occurred_at_ms?: number
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
  /** Arguments the task appended to the binary. Empty for a precomputed task. */
  args: string[]
  /**
   * The task's binary OVERRIDE, or null when it used the configured executor
   * binary. Only the override is reported, so a non-null value means exactly
   * "this task ran something else" — render it only when present.
   */
  binary_path: string | null
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

// Enrichment fields (link_template/badge_colors/format/hint) are optional:
// always present (possibly null) on a fresh backend, absent entirely on one
// that predates enrichment — read defensively.
export interface ProbeDetailsColumn {
  key: string
  label: string
  link_template?: string | null
  badge_colors?: Record<string, string> | null
  format?: string | null
  hint?: string | null
  /** Named deployment-provided cell renderer for this column; null when unused. */
  renderer?: string | null
}

/** One external link inside a detail panel's 'links' element. */
export interface ProbeDetailLink {
  label: string
  template: string
}

/** One block of a declared detail panel, rendered top to bottom. */
export interface ProbeDetailElement {
  view: 'string' | 'keyvalue' | 'table' | 'links' | 'custom'
  field?: string | null
  label?: string | null
  links?: ProbeDetailLink[] | null
  /** Named deployment-provided cell renderer for a 'custom' element; null when unused. */
  renderer?: string | null
}

/** A declared right-panel layout, opened by clicking a row. */
export interface ProbeDetail {
  title?: string | null
  elements: ProbeDetailElement[]
}

export interface ProbeDetailsEntry {
  key: string
  label: string
  /**
   * 'tables' renders one sub-table per [group, rows[]] pair of an ordered
   * pair-array value (first-append order on every backend); 'tree' renders
   * flat rows grouped client-side by the group_by keys.
   */
  view: 'string' | 'keyvalue' | 'dict' | 'table' | 'tables' | 'tree' | 'badge' | 'custom'
  /** Present only when view is 'table', 'tables', or 'tree'; null otherwise. */
  columns: ProbeDetailsColumn[] | null
  /**
   * Ordered grouping keys for view='tree' (outermost first, max depth 4),
   * a subset of columns. Null for other views; absent on backends that
   * predate the tree view — read defensively.
   */
  group_by?: string[] | null
  link_template?: string | null
  badge_colors?: Record<string, string> | null
  format?: string | null
  hint?: string | null
  /** Named deployment-provided cell renderer for this entry; null when unused. */
  renderer?: string | null
  /** A declared right-panel layout for this row-bearing view; null/absent otherwise. */
  detail?: ProbeDetail | null
}

export interface ProbeDetailsSection {
  title: string
  entries: ProbeDetailsEntry[]
}

export interface ProbeDetailsWrite {
  field: string
  op: 'set' | 'append' | 'update'
  origin_stage: string
  ms_since_start: number
}

export interface ProbeUserDetails {
  /** The registered model's bare type name. */
  model: string
  layout: { sections: ProbeDetailsSection[] }
  /** One decoded value per registered field, keyed by field name. */
  data: Record<string, unknown>
  writes: ProbeDetailsWrite[]
}

// --- Declared UI pages (GET /api/v1/pages) ---

// One widget on a declared page. `view` is forward-compatible: a backend may
// declare a view this UI doesn't yet know how to render, so it stays a bare
// string rather than a closed union — the page shell renders it regardless of
// whether the widget body understands `view`; unrecognized views are handled
// at the render site (Task 5), not rejected here. `columns` reuses the same
// column shape as probe-details tables (link templates, badge colors, format,
// hint) so a table-view widget gets that enrichment for free.
export interface UIPageWidget {
  title: string
  view: 'table' | 'keyvalue' | 'string' | 'badge' | 'stat' | string
  source: { kind: string; [k: string]: unknown }
  columns?: ProbeDetailsColumn[] | null
  field?: string | null
  badge_colors?: Record<string, string> | null
  format?: string | null
}

// One backend-declared page (drakkar.ui_pages config): a nav entry plus an
// ordered list of widgets. GET /api/v1/pages returns a bare array of these,
// empty when the backend declares nothing.
export interface UIPage {
  slug: string
  title: string
  widgets: UIPageWidget[]
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
  /**
   * Null when the handler registered no user-details model. Optional (not just
   * nullable) because the field is absent entirely on older backend responses
   * that predate it — the OpenAPI schema doesn't list it as required.
   */
  user_details?: ProbeUserDetails | null
  truncated: boolean
}
