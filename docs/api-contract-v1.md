# Drakkar UI API Contract — v1

The normative JSON/WS contract that **every** Drakkar backend (the Python
reference, the Go port, any future implementation) must implement identically,
so this one shared static UI works against any of them. This document lives in
the UI repo because it is a *requirement on backends*: the UI is the consumer,
the backends are the providers. Backends may additionally publish generated API
docs (e.g. Swagger/OpenAPI) describing what they implement, but the canonical
shapes are pinned here.

Derived from a static audit of both backend implementations (2026-06-28);
divergences found in that audit and their canonical resolutions are recorded in
the appendix.

## Conventions (apply to all endpoints)

- **Base path / versioning:** all JSON APIs live under `/api/v1/...`. Backends
  may keep serving legacy unprefixed `/api/...` aliases for their built-in
  pages; the UI only ever calls `/api/v1/*`. Probes (`/healthz`, `/readyz`) and
  the WebSocket (`/ws`) stay unprefixed (kubelet/browser contracts).
- **Auth:** when `auth_token` is configured, every `/api/*` route requires
  `Authorization: Bearer <t>` or `?token=<t>`; an empty token disables auth
  (dev-trust default). Failure → `401 {"detail":"Invalid or missing auth
  token"}`. `/healthz` + `/readyz` are always public. `/ws` self-manages
  (accept, then close `4401` unauthorized / `4403` forbidden-origin).
- **Content-Type:** `application/json` (no charset suffix).
- **Error envelopes:** `{"detail":"..."}` for 401/404/500/503;
  `{"detail":[{"loc":[...],"msg":"..."}]}` for 422; legacy `{"error":"..."}`
  for merge/download 400/404. The 422 shape is pinned **minimal** (`loc`+`msg`);
  the UI relies only on the HTTP status and `detail[].msg`, never on
  framework-specific extras (`type`/`input`/`ctx`/`url`).
- **Numbers:** whole-valued floats may render `100` or `100.0` depending on the
  backend language; a JS consumer normalizes both. Not an observable divergence.

## Endpoint catalog (canonical shapes)

### Probes
- `GET /healthz` → 200 `{"status":"ok"}`.
- `GET /readyz` → 200 `{"status":"ready"}` | 503
  `{"status":"not_ready","reasons":[...]}`.

### Stream
- `GET /ws` (WebSocket) — accept → token check → origin check; ≤100 events per
  drain pass, 20ms idle backoff, one recorder-event JSON object per text frame.
  Frame = a recorder event row (see **Recorder event row shape**). A frame is
  always a primitive-valued object; backends MUST NOT publish non-encodable
  values.

### Core
- `GET /api/v1/dashboard` → `{uptime:float, stats:{<event>:int,...,
  total_events:int}, partition_count:int, partitions:[int...], pool_active:int,
  pool_max:int, total_lag:int, webapp_tile?:{...}, links?:{...}}`. `webapp_tile`
  key present only when the webapp pipeline is enabled (key presence = feature
  flag). `webapp_tile.clients[]` element: `{name:str, rpm_limit:int}`.
  - `links` (optional, v1.1) — Prometheus/custom dashboard links. Key presence =
    feature flag: a backend without Prometheus/custom links configured omits it
    entirely and the UI renders none of the link sections. Shape:
    `{card_links:{lag?|consumed?|completed?|failed?|produced?:str},
    worker_links:[{category:str, links:[[name:str, url:str],...]},...],
    cluster_links:[[name:str, url:str],...],
    custom_links:[{<key>:str,...},...]}`. `card_links` attaches an
    external-link icon to the matching stat tile; `worker_links` render as a
    titled link-card grid; `cluster_links` and `custom_links` render as single
    flat wrap-list cards. `custom_links` entries are the configured dicts,
    typically `{name, url}`.
- `GET /api/v1/identity` (v1.1) → `{worker_id:str, cluster:str|null,
  config_summary:str}`. Worker self-identity; `config_summary` is the one-line
  human-readable config string the reference debug page shows in its banner
  (may be empty). Auth as all `/api/*` routes. v1-only — no legacy unprefixed
  `/api/identity` alias. Older backends 404; the UI degrades gracefully (plain
  page heading instead of the banner).
- `GET /api/v1/partitions` → array of per-partition rows: partition-summary
  columns (`partition, last_consumed, last_committed, last_committed_offset,
  consumed_count, completed_count, failed_count`) enriched per row with
  `is_live:bool, queue_size:int, pending_offsets:int, committed_offset:int|null,
  high_watermark:int|null, lag:int`; array sorted by partition. `[]` when
  nothing recorded.
- `GET /api/v1/task/{id}` → single-task detail: `{task_id, events:[<row>...],
  started|null, completed|null, failed|null, duration:float|null,
  source_offsets|null, args, labels, task_env, partition|null, pid|null,
  exit_code|null, binary_path, origin, client_name|null, request_id|null,
  webapp_request_body|null, webapp_response_body|null}`. A `:r…` retry suffix
  on `{id}` is stripped to the base id. stdout/stderr live inside the event rows.
- `GET /api/v1/sinks` → array of `{sink_type, name, ui_url, delivered_count,
  delivered_payloads, error_count, retry_count, last_delivery_ts:float|null,
  last_delivery_duration:float|null, last_error:str|null, last_error_ts:float|null}`.
- `GET /api/v1/workers` → array of worker objects (peers via shared db_dir +
  current), each `{worker_name, cluster_name|null, ip_address|null, debug_port,
  debug_url|null, url, cluster, is_current}`; sorted clustered-first then by name.
- `GET /api/v1/debug/processors` → `{processors:{"<pid>":{queue_size,
  inflight_count, arranging:bool, arrange:null|{duration:float(2dp),
  message_count, labels:[...]}, pending_count, completed_count, total_tracked,
  last_committed:int|null, committable:int|null, first_offsets:[int...≤20],
  offset_states:{"<off>":str}, active_task_count, stuck_tasks?:[{name,
  stack:[str]}]}}, pool_active, pool_waiting, pool_max}`.
  `stuck_tasks[].stack` is best-effort/informational — a backend that cannot
  snapshot stacks emits `[]`; the UI tolerates it.

### Live
- `GET /api/v1/live/overview` → `{worker_id, running_tasks, pending_tasks,
  arranging:[{partition,duration,message_count,labels[≤10]}], pool_active,
  pool_waiting, pool_max, partition_count, max_ui_rows, ws_min_duration_ms,
  hook_flags:{task_complete,message_complete,window_complete},
  kafka_ui_base:str, kafka_ui_cluster:str, kafka_source_topic:str}`.
  The three `kafka_ui_*` keys are always present as strings, empty when the
  Kafka-UI deep-link integration is unconfigured; the UI renders deep links only
  when all three are non-empty. The UI fetches this endpoint once at boot to
  hydrate runtime config, and again on the Live page.
- `GET /api/v1/events?limit=200&after_id=0&partitions=&event_types=` → array of
  full recorder event rows (`SELECT *`, id DESC). Malformed `partitions` CSV →
  **422**. `limit` ≤ 10000 → 422 above. No DB → `[]`.
- `GET /api/v1/recent-tasks?minutes=2` → `{tasks:[<entry>...], lane_count:int}`
  (no DB → `[]`). Each entry: `{task_id, partition, start_ts, end_ts, duration,
  status, args, pid, slot, labels, env, origin, client_name, request_id}`.
  Archived retry attempts keep the Python reference's ordering and the
  `task_id:r<float-ts>` composite-key format; consumers must not rely on
  positional order.
- `POST /api/v1/live/arrange-tasks` body `{task_ids:[str] (≤5000)}` → map keyed
  by task_id of `{task_id, status, start_ts, end_ts, duration, partition,
  source_offsets, pid, args, labels, exit_code, origin, client_name,
  request_id}`; no DB/empty → `{}`.
- `GET /api/v1/live/task-results?limit=200` ([0,5000]) → array of `{ts, task_id,
  partition, source_offsets, hook_duration, exec_duration, status, exit_code,
  output_message_count}`.
- `GET /api/v1/live/message-results?limit=200` ([0,5000]) → array of `{ts,
  partition, offset, duration, end_to_end_duration, task_count, succeeded,
  failed, replaced, output_message_count}`.
- `GET /api/v1/live/window-results?limit=200` ([0,5000]) → array of `{ts,
  partition, window_id, duration, task_count, output_message_count}`.
- `POST /api/v1/live/sink-breakdown` body `{partition:int (REQUIRED),
  offsets:[int] (≤5000)}` → `{"<topic>":count}` (null topic → `"(unknown)"`);
  empty → `{}`. Missing `partition` → 422.

### Debug tools
- `GET /api/v1/debug/databases` → array of `{filename, path, worker_name,
  cluster_name, event_count, event_counts:{<type>:int}, first_event_ts:float|null,
  last_event_ts:float|null, has_events, has_config, has_state, size_bytes}`.
- `POST /api/v1/debug/merge` body `{filenames:[str] (≥2)}` → `{filename,
  worker_count, event_count, state_count, cluster_name, source_files:[str]}`.
  400 on malformed JSON body; filename hardening rejects `/ \` leading-`.` `"`
  `;` and control chars; 404 for missing files; errors via `{"error":...}`.
- `GET /api/v1/debug/download/{filename}` → file attachment; `Content-Type:
  application/x-sqlite3`, `Content-Disposition: attachment; filename="..."`,
  `Cache-Control: no-store, private`. Filename hardening as merge. Token may
  ride as `?token=` (plain `<a>` downloads cannot set headers).
- `GET /api/v1/debug/trace?partition=&offset=` (both required int) → array of
  event rows. `partition` must fit int32 → 422 otherwise.
- `GET /api/v1/debug/label-keys` → sorted array of distinct label-key strings.
- `GET /api/v1/debug/trace-by-label?key=&value=` (both required, non-empty →
  422) → array of event rows.
- `GET /api/v1/debug/metrics` → array of `{name, type, help,
  source:"framework"|"user", samples:[{name, labels:{...}, value:number}]}`.
  Untyped families report `type:"unknown"`; counter samples keep the `_total`
  suffix in `samples[].name`.
- `GET /api/v1/debug/periodic` → array grouped by name (sorted), each `{name,
  last_run_ts, last_duration, last_status, last_error, system:bool, total_ok,
  total_error, recent:[{ts,duration,status,error}]≤20}`.
- `POST /api/v1/debug/probe` body `ProbeInput` → `DebugReport` (below). 200 even
  on timeout (`truncated:true`); 503 `{"detail":"executor pool not ready"}` when
  the probe is unavailable; 422 on invalid input. `ProbeInput`: `{value:str
  (≤10MB), key:str|null, partition:int(≥0), offset:int(≥0), topic:str,
  timestamp:int|null, use_cache:bool}`.

### Cache browser (all 404 `{"detail":"Cache is disabled"}` when cache is off)
- `GET /api/v1/debug/cache/entries?limit=200&offset=0&scope=&search=&expired_only=`
  → `{entries:[{key, scope, value(raw str), size_bytes, created_at_ms,
  updated_at_ms, expires_at_ms:int|null, origin_worker_id}], total, limit,
  offset}`. `limit` [0,1000] → 422 outside; `offset` ≥0.
- `GET /api/v1/debug/cache/entry/{key}` (key may contain slashes/colons) →
  entry row + `value:<decoded JSON>|null` + `raw_value:str`; 404 not-found,
  500 read-fail.
- `GET /api/v1/debug/cache/stats` → `{entries_in_memory, bytes_in_memory,
  entries_in_db, bytes_in_db}`.

## Probe `DebugReport`

Full structure: `{input, deserialize_error|null, parsed_payload|null,
message_label|null, arrange:ProbeStageResult, tasks:[ProbeTaskEntry],
on_message_complete:ProbeStageResult|null, on_window_complete:ProbeStageResult|null,
planned_sink_payloads:[PlannedSinkRecord], cache_calls:[ProbeCacheCall],
cache_summary:{calls,hits,misses,writes_suppressed}, timing:{total_wallclock,
arrange, on_message_complete, on_window_complete}, errors:[ProbeError],
truncated:bool}`.

- `ProbeError` / `deserialize_error`: `{stage, exception_class, message,
  occurred_at_ms}` — **no `traceback` field** (it must not be emitted).
  `exception_class` content is language-specific; treat as opaque.
- `ProbeTaskEntry`: `{task_id, parent_task_id, labels, source_offsets,
  precomputed, status(done|failed|replaced), exit_code, duration_seconds, stdin,
  stdout, stderr, subprocess_exception, on_task_complete_duration,
  on_task_complete_result, on_task_complete_error, retry_of, replacement_for}`.
- `ProbeCacheCall`: `{op(get|set|peek|delete|contains), key, scope,
  outcome(hit|miss|suppressed), value_preview, origin_stage, ms_since_start}`.
- `PlannedSinkRecord`: `{sink_type(kafka|postgres|mongo|http|redis|files|custom),
  destination, origin_stage, payload, extras}`.
- `CollectResult` (in `arrange.collect_result` and
  `tasks[].on_task_complete_result`): per-sink arrays **may be absent; absent ⇒
  empty**. The UI reads each defensively (`result.kafka ?? []`).

## Recorder event row shape (used by /ws, /events, /trace, /trace-by-label)

Currently under-specified: backends pass recorder rows through (`SELECT *`).
Columns include `id, event, ts, dt, partition, offset, task_id, args, stdout,
stdout_size, stderr, exit_code, duration, output_topic, metadata, pid, labels,
origin, client_name, request_id` (presence is event-type-dependent). A dedicated
recorder-event-schema audit + pin is a v1.x TODO; until then the UI treats every
column as optional.

## Capability gaps (future, not required for v1 conformance)

- No cache **write/delete** endpoint (the cache browser is read-only).
- No DB-file **delete** endpoint (merged files accumulate in db_dir).
- No checksum/signature on UI bundle release assets (backends validate
  structurally: `index.html` at archive root).

## v1.1 additions (2026-07-03)

Two additive, backward-compatible extensions for dashboard/debug parity with
the Python reference pages:

- dashboard `links?` key (Prometheus card/worker/cluster links + custom links) —
  optional; key presence = feature flag. The Go backend currently omits it;
  the Python backend emits it when Prometheus/custom links are configured.
- `GET /api/v1/identity` (worker_id, cluster, config_summary) — feeds the debug
  page's config-summary banner. Backends without it 404; the UI falls back to
  the plain heading.

## Appendix: divergence resolutions from the 2026-06 audit

Canonical choices where the two reference backends disagreed; each backend
reconciles its side.

| # | Endpoint / field | Canonical | Reconciled by |
|---|---|---|---|
| 1 | dashboard `webapp_tile.clients[]` | `rpm_limit` (not `rpm`) | Go |
| 2 | processors `arrange.duration` | rounded to 2dp | Go |
| 3 | processors `stuck_tasks[].stack` | best-effort, may be `[]` | spec note |
| 4 | recent-tasks retry order + archived id format | Python reference behavior | Go |
| 5 | sink-breakdown `partition` | required → 422 when absent | Go |
| 6 | events malformed `partitions` | 422 (not 500) | Python |
| 7 | probe `traceback` | omitted | Python |
| 8 | probe `CollectResult` empty sink arrays | absent ⇒ empty; UI defensive | UI |
| 9 | probe `sink_type` enum | includes `"custom"` | Python |
| 10 | merge/download/trace input hardening | Go's stricter validation | Python |
| 11 | metrics untyped family / counter sample name | `"unknown"` / keep `_total` | Go |
| 12 | 422 envelope richness | minimal `{loc,msg}`; UI reads msg only | UI |
| 13 | WS non-encodable values | never publish such | both |
