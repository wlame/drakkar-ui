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

- **Deployment posture (normative for backends):** this contract describes an
  operator surface for an **internal** service. Backends must not assume it is
  safe to expose on an untrusted network, and the auth, rate limiting and input
  checks specified here are defence in depth rather than a security perimeter —
  the perimeter is the operator's network and the application built on top.
  Backends should default to a loopback bind and warn when serving the UI
  without a token.

- **Base path / versioning:** all JSON APIs live under `/api/v1/...`, and
  nowhere else. Backends used to also serve legacy unprefixed `/api/...`
  aliases for their own built-in HTML pages; those pages are gone and the
  aliases went with them, so an unprefixed path is no longer a route on
  either backend. Probes (`/healthz`, `/readyz`) and the WebSocket (`/ws`)
  stay unprefixed (kubelet/browser contracts).
- **Auth:** when `auth_token` is configured, every `/api/*` route requires
  `Authorization: Bearer <t>` or `?token=<t>`; an empty token disables auth
  (dev-trust default). Failure → `401 {"detail":"Invalid or missing auth
  token"}`. `/healthz` + `/readyz` are always public. `/ws` self-manages
  (accept, then close `4401` unauthorized / `4403` forbidden-origin).
  Routes under `/api/v1/peer/` are always public too: workers call them on
  each other for the cache exchange and send no token (v1.23). The six
  `/api/v1/agent` routes (v1.31) are an exception the other way: they follow
  `agent.auth_token`, not `ui.auth_token`, and answer 401
  `{"error": "agent token required"}`; they are served with `ui.enabled:
  false` too.
- **`/ws` Origin:** checked on every handshake, with or without a token. An
  absent `Origin` (non-browser clients) and a same-origin one always pass;
  a non-empty `ui.allowed_origins` is a strict allowlist. With a token
  set, every other cross-origin handshake is `4403`. Without one, a
  cross-origin handshake passes — this is what the cluster view relies on —
  **unless** the request `Host` is a loopback address and the `Origin` host
  is not, which no peer worker ever is. A client must treat `4403` as
  terminal and not reconnect.
- **Cross-origin reads (CORS, v1.23):** the browser fans three reads out to
  every worker of the cluster: `GET /api/v1/debug/trace`,
  `/api/v1/debug/trace-by-label` and `/api/v1/debug/databases`. These paths
  answer cross-origin requests with the same origin rule as `/ws` (same
  table, same `ui.allowed_origins` key). An `OPTIONS` preflight on them
  needs no token. Allowed: `204` with `Access-Control-Allow-Origin:
  <origin>`, `Access-Control-Allow-Methods: GET`,
  `Access-Control-Allow-Headers: Authorization`,
  `Access-Control-Max-Age: 600` and `Vary: Origin`. Refused: `403
  {"error":"Origin not allowed"}`. A `GET` from an allowed cross origin
  carries `Access-Control-Allow-Origin: <origin>` and `Vary: Origin`; a
  `GET` from a refused origin carries no CORS header (the browser then
  blocks the answer), and auth applies as usual. No other path sends CORS
  headers. With a token set, every worker origin must be listed in
  `ui.allowed_origins` for the fan-out to work.
- **Content-Type:** `application/json` (no charset suffix), except the
  Markdown form of `/api/v1/agent/manual` (v1.31), which is
  `text/markdown; charset=utf-8`.
- **Error envelopes:** `{"detail":"..."}` for 401/404/500/503;
  `{"detail":[{"loc":[...],"msg":"..."}]}` for 422; legacy `{"error":"..."}`
  for merge/download 400/404, merge 500, `download-live` 400/404/500 (and 429 since v1.30),
  `/debug/databases` 400 (v1.30), `/debug/slice` 400/409/429/500/503 (v1.30),
  `/debug/databases/postgres` 404/503, `/debug/files` 403/404/409 and
  `/debug/autodiscover` 404 (v1.30), the six `/agent` routes
  400/401/404 (v1.31), the
  `/api/v1/peer/` routes and the CORS preflight 403. The 422 shape is pinned **minimal** (`loc`+`msg`);
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
- `GET /ws?events=<csv>` (WebSocket) — accept → token check (when configured) → origin check (always).

  **Frame shape** — one text frame per *drain pass*, carrying a batch:

  ```json
  {"dropped": 0, "events": [ {<event row>}, {<event row>} ]}
  ```

  - `events` — up to 100 recorder event rows (see **Recorder event row
    shape**), in record order. May be empty. Values are always primitives;
    backends MUST NOT publish non-encodable values.
  - `dropped` — events discarded for *this* client since the previous frame
    because its server-side queue was full. Non-zero means the client's
    in-memory state has a gap; it MUST resync from the database rather than
    continue applying deltas. Reported after the batch is drained, so a gap is
    never announced before the events preceding it.

  Batching is a server-side decision: how many events land in a frame is a
  timing detail and consumers MUST NOT depend on frame boundaries.

  **Subscription filter** — `?events=` is an optional CSV allowlist of `event`
  names. The server never encodes, queues or sends types outside it. Omit the
  parameter to receive every event. Clients SHOULD declare exactly the types
  they render: on a high-fan-out workload the per-task completion hooks are the
  largest event class by count, and most pages do not render them live.

  **Captured output is never streamed.** The `stdout` and `stderr` columns are
  persisted but omitted from every streamed event — the live views display
  `stdout_size`, and broadcasting the text would cost
  `len(output) x connected clients` for data nothing renders. Consumers needing
  the text fetch it from `/api/v1/task/{id}` or `/api/v1/events`.

  **`stdin_lines` / `stdout_lines` are nullable.** They are WS-frame-only
  fields — never recorder columns, and `/recent-tasks` has never carried them
  — and the backend counts them only when a live client is attached, because
  counting means walking the whole of every task's stdin and stdout on the
  hot path for a value that is otherwise discarded. A client MUST render a
  null as "size only", never as zero lines. The byte sizes (`stdin_size`,
  `stdout_size`) are always exact. The one case where a connected client can
  still see null is a deferred `task_started` whose frame is broadcast after
  the client attached; the timeline `field` rules on these two names treat a
  null the same way they treat any absent field.

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
  (may be empty). Auth as all `/api/*` routes. Older backends 404; the UI degrades gracefully (plain
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
- `GET /api/v1/workers` → array of worker objects (peers from the worker
  registry + current), each `{worker_name, cluster_name|null, ip_address|null,
  debug_port|null, debug_url|null, url, cluster, is_current}` plus the v1.18
  liveness fields, the v1.23 registry fields and the v1.24 fields
  `cluster_tasks_hash:str|null` and `cluster_tasks_match:bool|null` (see
  "v1.24 additions"); sorted clustered-first then by name.
- `GET /api/v1/debug/processors` → `{processors:{"<pid>":{queue_size,
  inflight_count, arranging:bool, arrange:null|{duration:float(2dp),
  message_count, labels:[...]}, pending_count, completed_count, total_tracked,
  last_committed:int|null, committable:int|null, first_offsets:[int...≤20],
  offset_states:{"<off>":str}, active_task_count, stuck_tasks?:[{name,
  stack:[str]}]}}, pool_active, pool_waiting, pool_max}`.
  `stuck_tasks[].stack` is best-effort/informational — a backend that cannot
  snapshot stacks emits `[]`; the UI tolerates it.

### Live
- `GET /api/v1/live/overview` → `{worker_id, running_tasks:int,
  pending_tasks:int,
  arranging:[{partition,duration,message_count,labels[≤10]}], pool_active,
  pool_waiting, pool_max, partition_count, max_ui_rows, ws_min_duration_ms,
  hook_flags:{task_complete,message_complete,window_complete},
  kafka_ui_base:str, kafka_ui_cluster:str, kafka_source_topic:str}`.
  `running_tasks` counts the in-flight tasks holding an executor slot (their
  subprocess is live); `pending_tasks` counts those arranged but still queued
  behind the pool gate. **Counts, not maps, since v1.20** — see below.
  The three `kafka_ui_*` keys are always present as strings, empty when the
  Kafka-UI deep-link integration is unconfigured; the UI renders deep links only
  when all three are non-empty. The UI fetches this endpoint once at boot to
  hydrate runtime config, and again on the Live page.
- `GET /api/v1/events?limit=200&after_id=0&partitions=&event_types=&origin=` →
  array of full recorder event rows (`SELECT *`, id DESC). Malformed
  `partitions` CSV → **422**. `limit` ≤ 10000 → 422 above. No DB → `[]`.
  `origin` (`kafka` | `http`) keeps only Kafka-origin tasks or webapp
  requests; omit it for both.
- `GET /api/v1/recent-tasks?minutes=2` →
  `{tasks:[<entry>...], lane_count:int, truncated:bool}` (no DB → `[]`). Each
  entry: `{task_id, partition, start_ts, end_ts, duration, status, args, pid,
  slot, labels, env, origin, client_name, request_id}`, plus the optional
  `stdout_size` (v1.7), `run_started_at` and `reported_run_seconds` (v1.29). Archived retry attempts
  keep the Python reference's ordering and the `task_id:r<float-ts>`
  composite-key format; consumers must not rely on positional order.

  `minutes` is bounded to **1..60** → 422 outside. The underlying scan is
  capped at `ui.max_rows * 3` events, keeping the **most recent**; when the cap
  is reached `truncated` is `true` and older tasks inside the window are
  absent. Both bounds exist because one source message can fan out to a
  thousand tasks — without them the query cannot complete inside the
  main-loop dispatch budget and the endpoint degrades to an empty timeline
  with no indication anything went wrong.
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
- `GET /api/v1/debug/databases[?parts=own,history,storage,recorder]` →
  `{own:[...], history:{folders:[...]}}` (v1.23; see "Sealed history"
  below). Since v1.30 it also answers `worker`, `recorder` and `storage`,
  and `parts` limits the answer; see [v1.30 changes](#v130-changes-2026-11-08).
- `POST /api/v1/debug/merge` body `{filenames:[path] (≥2)}` → `{filename,
  path, worker_count, event_count, state_count, cluster_name,
  source_files:[str]}`. Paths are relative to `storage.shared_dir` (v1.23). 400 on
  malformed JSON body; segment hardening rejects `/ \` leading-`.` `"` `;`
  and control chars; 404 for missing files; 500 when the merge itself
  fails; errors via `{"error":...}`.
- `GET /api/v1/debug/download/{path}` → file attachment; `Content-Type:
  application/x-sqlite3` (`.db`) or `application/gzip` (`.db.gz`),
  `Content-Disposition: attachment; filename="..."`, `Cache-Control:
  no-store, private`. `path` relative to `storage.shared_dir` (v1.23). Token may
  ride as `?token=` (plain `<a>` downloads cannot set headers). Since v1.30
  it takes `compress=gzip`.
- `GET /api/v1/debug/download-live` → a consistent snapshot of the serving
  worker's live recorder file (SQLite backup API), as an attachment with
  the live file's name, `Content-Type: application/x-sqlite3`,
  `Cache-Control: no-store, private`. 404 `{"error":...}` when no live file
  is open; 500 `{"error": "Snapshot failed: <reason>"}` when the copy
  fails. Token may ride as `?token=` (v1.23). Since v1.25 it takes
  `source=memory|file` and serves the memory store of a memory-only worker;
  see [v1.25 changes](#v125-changes-2026-11-01). Since v1.30 it takes
  `source=cache` and `compress=gzip`; see [v1.30 changes](#v130-changes-2026-11-08).
- `GET /api/v1/debug/slice?from=&to=[&scope=&sources=&partition=&offset_from=&offset_to=&task_id=&events=&label_key=&label_value=&output=&max_rows=&compress=]`
  → a SQLite file of the recorder events of one time range, built by the
  serving worker and streamed as an attachment (v1.30). Token may ride as
  `?token=`. See [v1.30 changes](#get-apiv1debugslice-new).
- `GET /api/v1/debug/databases/postgres` → the hour partitions of the
  recorder's Postgres table and the partitions the next upkeep drops (v1.30).
  See [v1.30 changes](#get-apiv1debugdatabasespostgres-new).
- `DELETE /api/v1/debug/files/{path}` → `204`; deletes one merge result
  (`merged/<name>.db`) when `ui.delete_enabled` is true (v1.30). See
  [v1.30 changes](#delete-apiv1debugfilespath-new).
- `GET /api/v1/debug/autodiscover` → `{registry, worker, workers:[...],
  truncated}`, the registry cards from the worker's last refresh (v1.30).
  See [v1.30 changes](#get-apiv1debugautodiscover-new).
- `GET /api/v1/debug/autodiscover/leases` → `{election, leases:[...]}`, the
  holder of each cluster task's lease as the store reports it (v1.30). See
  [v1.30 changes](#get-apiv1debugautodiscoverleases-new).
- `GET /api/v1/agent`, `/agent/manual`, `/agent/config`, `/agent/metrics`,
  `/agent/state` and `/agent/diagnose` → the agent insight routes (v1.31):
  read-only, off unless `agent.enabled`, with a token of their own. The UI
  does not call them. See [v1.31 changes](#v131-changes-2026-11-09).
- `GET /api/v1/debug/archives` → `{archives:[{name, cluster, folder, path,
  from_ts, to_ts, size_bytes}]}`, newest-first by `to_ts`, from every
  `history/<cluster>/` folder. See v1.8 and v1.23 below.
- `GET /api/v1/debug/trace?partition=&offset=[&history=1]` (partition and
  offset required int) → array of event rows. `partition` must fit int32 →
  422 otherwise. `history=1` searches sealed history only (v1.23) or the worker's Postgres history (v1.26).
- `GET /api/v1/debug/label-keys` → sorted array of distinct label-key strings.
- `GET /api/v1/debug/trace-by-label?key=&value=` (both required, non-empty →
  422) → array of event rows.
- `GET /api/v1/debug/metrics` → array of `{name, type, help,
  source:"framework"|"user", samples:[{name, labels:{...}, value:number}]}`.
  Untyped families report `type:"unknown"`; counter samples keep the `_total`
  suffix in `samples[].name`.
- `GET /api/v1/debug/periodic` → array grouped by name (sorted), each `{name,
  last_run_ts, last_duration, last_status, last_error, system:bool, total_ok,
  total_error, recent:[{ts,duration,status,error}]≤20}`, plus the v1.24
  `scope:"worker"|"cluster"` (absent before v1.24: read as `"worker"`).
- `POST /api/v1/debug/probe` body `ProbeInput` → `DebugReport` (below). 200 even
  on timeout (`truncated:true`); 503 `{"detail":"executor pool not ready"}` when
  the probe is unavailable; 422 on invalid input; **429
  `{error:str, max_waiters:int}` with `Retry-After: 1` when too many probes are
  already queued** (v1.20). `ProbeInput`: `{value:str
  (≤10MB), key:str|null, partition:int(≥0), offset:int(≥0), topic:str,
  timestamp:int|null, use_cache:bool}`.

  Probes serialize on a single lock — one runs at a time, by design, because
  a probe swaps process-wide handler state. Each queued probe already gives
  up at its own wall-clock cap, but the queue itself was unbounded, so a
  refreshed page or a script could stack requests that each pin memory and a
  connection on the server that also answers the Kubernetes probes. Backends
  shed past 16 queued. A client seeing 429 should retry, not treat it as a
  probe failure.

### Runtime health
- `GET /api/v1/runtime/health` → `{enabled:true, state:"healthy"|"degraded"|
  "stalled", unit_label:str ("tasks" py / "goroutines" go), current_lag_ms,
  heartbeat_age_ms, window:[{t, max_lag_ms, avg_lag_ms}] (one bucket per
  active second), recent_stalls:[{t, duration_ms, stack_count,
  top_location:str|null}]}`. 404 `{enabled:false, reason:str}` when the
  monitor is disabled or the backend does not implement it (Go, currently).
  Served from monitor memory — answers even while the runtime is stalled.
- `GET /api/v1/debug/runtime/units` → `{unit_label, total, units:[{name,
  location ("" when unknown), count, example}]}` sorted largest-first. Runs
  on the measured runtime; 503 when the dispatch times out (the runtime is
  not serving work — itself a diagnosis). Stall stacks travel on
  `runtime_stall` recorder events (metadata JSON: `{duration_ms,
  stacks:[{stack, location, count}], dropped_stacks, unit_count}`);
  `runtime_health` events carry `{kind:"transition"|"sample", state, lag_ms,
  unit_count}`.

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

### Peer API (worker to worker; public, v1.23)
- `GET /api/v1/peer/cache/changes?scopes=&after_ms=&after_key=&limit=` →
  `{rows:[PeerCacheRow], more:bool}`. Workers pull each other's cache rows
  with it; the UI never calls it. See "Cache exchange over HTTP" under
  v1.23 below for the parameters, the rule and the error answers.

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
  precomputed, status(done|failed|replaced), exit_code, duration_seconds, args,
  binary_path, stdin, stdout, stderr, subprocess_exception,
  on_task_complete_duration, on_task_complete_result, on_task_complete_error,
  retry_of, replacement_for}`.
  `args` is the argument list the task appended to the binary (empty for a
  precomputed task). `binary_path` is the task's **override only**, and is
  `null` when the task used the configured executor binary — the configured
  path is identical for every task and already visible in the config, so a
  non-null value means exactly "this task ran something else". Clients render
  it only when present.
- `ProbeCacheCall`: `{op(get|set|peek|delete|contains), key, scope,
  outcome(hit|miss|suppressed), value_preview, origin_stage, ms_since_start}`.
- `PlannedSinkRecord`: `{sink_type(kafka|postgres|mongo|http|redis|files),
  destination, origin_stage, payload, extras}`.
- `CollectResult` (in `arrange.collect_result` and
  `tasks[].on_task_complete_result`): per-sink arrays **may be absent; absent ⇒
  empty**. The UI reads each defensively (`result.kafka ?? []`).

## Recorder event row shape (used by /ws, /events, /trace, /trace-by-label)

**PINNED (v1.2).** Backends pass recorder rows through (`SELECT *`), and the
`events` table carries exactly these 20 columns, in DDL order:

```
id, ts, dt, event, partition, offset, task_id, args, stdout_size, stdout,
stderr, exit_code, duration, output_topic, metadata, pid, labels, origin,
client_name, request_id
```

Both backends pin this list in code and assert it against the live table in
a unit test (Python `drakkar/recorder/schema.py: EVENT_COLUMNS` +
`test_event_columns_pin_matches_live_table`; Go
`internal/recorder/schema.go: EventColumns` +
`TestEventColumnsPinMatchesLiveTable`). Adding/removing/reordering a column
is a contract change: update this section and BOTH backend pins together.

Column *presence* is the contract; *values* stay event-type-dependent
(nullable), so the UI keeps treating every column as optional. New event
TYPES are additive and do not touch this list — see `annotation` under
**v1.3 additions**, and the **Recorder event-type vocabulary** section
below for the pinned set of names the `event` column may carry. Framework
datetimes embedded in `metadata` JSON use the canonical cross-backend
format `YYYY-MM-DDTHH:MM:SS.ffffffZ` (fixed six-digit microseconds); the
`dt` column keeps its display format `YYYY-MM-DD HH:MM:SS.mmm`.

## Recorder event-type vocabulary (the `event` field)

**PINNED (v1.28).** An `event` field carries one of these 31
names and nothing else; every one of them is stored in the `events`
table and sent on `/ws`. The UI matches on these names,
so a name is as contractual as a column: adding, renaming or removing one is
a contract change that updates this section and both backends together.

Both backends declare the vocabulary once in code — Python
`drakkar/recorder/schema.py: EventType` (a `StrEnum`), Go
`internal/recorder/eventtype.go: EventType` — and pin it against one shared
fixture, `event_vocabulary.json`, which also records which backend emits
each name and whether it is stored. The Python repo owns the fixture
(`tests/fixtures/event_vocabulary.json`, regenerated by
`just gen-event-vocabulary`); the Go repo vendors a byte-identical copy at
`internal/recorder/testdata/event_vocabulary.json`.

| event | emitted by | carried on |
|---|---|---|
| `annotation` | both | `events` + `/ws` |
| `arranged` | both | `events` + `/ws` |
| `assigned` | both | `events` + `/ws` |
| `committed` | both | `events` + `/ws` |
| `consumed` | both | `events` + `/ws` |
| `message_complete` | both | `events` + `/ws` |
| `message_dlq` | both | `events` + `/ws` |
| `offload` | Python only | `events` + `/ws` |
| `partition_stalled` | both | `events` + `/ws` |
| `periodic_run` | both | `events` + `/ws` |
| `produced` | both | `events` + `/ws` |
| `resource_sample` | both | `events` + `/ws` |
| `revoked` | both | `events` + `/ws` |
| `runtime_health` | both | `events` + `/ws` |
| `runtime_lag_episode` | both | `events` + `/ws` |
| `runtime_probe` | both | `events` + `/ws` |
| `runtime_stall` | both | `events` + `/ws` |
| `sink_delivered` | both | `events` + `/ws` |
| `sink_error` | both | `events` + `/ws` |
| `sink_not_started` | both | `events` + `/ws` |
| `task_complete` | both | `events` + `/ws` |
| `task_completed` | both | `events` + `/ws` |
| `task_failed` | both | `events` + `/ws` |
| `task_started` | both | `events` + `/ws` |
| `webapp_request_auth_failed` | both | `events` + `/ws` |
| `webapp_request_completed` | both | `events` + `/ws` |
| `webapp_request_dropped_after_timeout` | both | `events` + `/ws` |
| `webapp_request_rate_limited` | both | `events` + `/ws` |
| `webapp_request_received` | both | `events` + `/ws` |
| `webapp_request_timeout` | both | `events` + `/ws` |
| `window_complete` | both | `events` + `/ws` |

A UI must treat an unknown `event` value as renderable-but-uncategorised
rather than an error: a mixed fleet can put rows from a newer backend in
front of an older UI. `offload` is currently Python-only — the Go backend
accepts `offload.*` config but does not run the pool yet, so it writes no
such row.

## Capability gaps (future, not required for v1 conformance)

- No cache **write/delete** endpoint (the cache browser is read-only).
- No DB-file **delete** endpoint (merge results stay in `<storage.shared_dir>/merged/` until `recorder.archive.merged_retention`).
- ~~No checksum on UI bundle release assets~~ — the release workflow now
  publishes a `drakkar-ui-<tag>.tar.gz.sha256` sidecar and both backends
  verify a downloaded bundle against it when present (absent sidecar —
  releases predating it — skips verification; structural validation of
  `index.html` at the archive root always applies). No signature yet.

## v1.1 additions (2026-07-03)

Two additive, backward-compatible extensions for dashboard/debug parity with
the Python reference pages:

- dashboard `links?` key (Prometheus card/worker/cluster links + custom links) —
  optional; key presence = feature flag. The Go backend currently omits it;
  the Python backend emits it when Prometheus/custom links are configured.
- `GET /api/v1/identity` (worker_id, cluster, config_summary) — feeds the debug
  page's config-summary banner. Backends without it 404; the UI falls back to
  the plain heading.

## v1.2 additions (2026-07-04)

Version visibility and a machine-readable surface description. All additive.

- `GET /api/v1/identity` gains four fields (older backends omit them; the UI
  must tolerate absence):
  - `backend:str` — `"python"` | `"go"`, the implementation flavor.
  - `backend_version:str` — backend-native version string (Python: installed
    `py-drakkar` package version; Go: git-describe build stamp, `"dev"` when
    unstamped).
  - `ui_version:str|null` — the drakkar-ui release tag this backend is
    serving (e.g. `"v0.1.1"`), `null` when no bundle could be resolved and
    the backend is running API-only.
  - `ui_source:str` — `"release"` (a fetched or cached bundle), or `""`
    when no bundle is being served. Backends no longer ship a built-in HTML
    fallback or a bundle baked into the binary/package: with nothing cached
    and no reachable release source they run API-only and answer every page
    request with **503** plus a JSON body naming the remedies (`error`,
    `detail`, `remedies[]`). The UI must tolerate unknown future values.
- `GET /api/v1/openapi.json` → the OpenAPI 3.1 document describing this
  surface, converted from the canonical `docs/openapi-v1.yaml` in this repo
  (vendored byte-identically into both backends). Protected by the same
  optional bearer token as every other API route.
- `GET /api-docs` → human-facing Swagger UI over that document (moved from
  `/docs` in v1.22, which now belongs to the operator docs site).
  Self-hosted assets only (no CDN — deployments are often firewalled);
  token-protected exactly like the other UI pages. Not part of the JSON
  API, listed here so backends stay drop-in identical.
- **Route-parity rule:** a backend's served route set — every `/api/v1/*`
  route plus `/healthz` and `/readyz` — MUST equal the `paths` of
  `docs/openapi-v1.yaml`. Each backend enforces this with a unit test that
  walks its live route table, so surface drift fails CI on the drifting side.

## v1.3 additions (2026-08-02)

Handler-emitted diagnostics. Additive: a new `event` VALUE on the existing
`events` table, no column change, no new endpoint. Older UIs that do not know
the type render it through their generic event path; older backends simply
never emit it.

- **`event = "annotation"`** — a record the handler attached to a pipeline
  entity from inside a hook, describing *why* it decided something. Reaches
  the UI through the existing `/ws`, `/api/v1/events`, `/api/v1/trace`, and
  `/api/v1/trace-by-label` surfaces.

  Anchor columns encode the scope:

  | scope | `partition` | `offset` | `task_id` |
  |---|---|---|---|
  | message | set | set | `null` |
  | task | set | `null` | set |
  | window | set | `null` | `null` |

  `labels` follows the same convention as task rows (JSON object or `null`).
  `metadata` is a JSON object with a fixed envelope:

  ```json
  {
    "kind": "input_selection",
    "scope": "message",
    "hook": "arrange",
    "window_id": 7,
    "offsets": [90, 91],
    "data": { }
  }
  ```

  - `kind` — handler-chosen name for what this annotation describes. Free
    text; the UI should treat it as a display/filter key, not an enum.
  - `scope` — `"message"` | `"task"` | `"window"`. Provided so the UI can
    label a row without inferring scope from which anchor columns are set.
    Unknown future values must degrade gracefully.
  - `hook` — the hook that emitted it (`"arrange"`, `"on_task_complete"`,
    `"on_error"`, `"on_message_complete"`, `"on_window_complete"`,
    `"arrange_http_request"`, `"on_http_request_complete"`).
  - `window_id` — per-partition monotone counter, or `null`. Unique only
    within one (partition, worker run); never a global id. The `arranged`
    event's metadata carries the matching `window_id` so the two can be
    correlated.
  - `offsets` — **window scope only**; `[]` for message and task scope.
    Window rows have no anchor column, so `/api/v1/trace` reaches them by
    matching this array against the traced offset. Message and task rows must
    leave it empty: they are already reachable through their own anchor
    column, and a non-empty array would additionally match every SIBLING
    offset in their emitting hook's window, putting one entity's diagnostics
    on another's trace. The UI does not need this field.
  - `data` — the handler's arbitrary JSON payload. Always an object, possibly
    empty. **Never partially written**: a payload that exceeded the backend's
    size budget is dropped whole rather than truncated, so a row that exists
    carries a complete document.

  Rendering guidance: annotations are user content, not framework telemetry —
  show them visually distinct from task lifecycle events, with `data`
  expandable rather than inlined (it can reach 16 KiB). `kind` is the natural
  row title. Correlating a live annotation with the batch that produced it:
  window rows match the `arranged` event's `metadata.window_id`, while message
  and task rows match the batch's own offsets and task ids — a UI should not
  rely on `window_id` for those, since older backends omit it entirely.

  Backend config (identical keys/defaults on both): the feature is on by
  default, individual payloads cap at 16 KiB, and one hook invocation may add
  at most 256 KiB. Dropped records are counted in
  `drakkar_recorder_annotations_dropped_total{reason}` — never silently lost.

- **`arranged` event metadata gains `window_id`.** Additive key inside the
  existing `metadata` JSON; consumers that ignore it are unaffected.

## v1.4 additions (2026-08-09)

Declarative UI enrichment for probe-details fields and table columns. All
additive: every new field is optional and null/absent-safe. A backend that
predates this section omits every field below entirely (not `null` — the
key itself is missing), and the UI renders exactly as it did before this
addition: plain text values, full row-model column sets, no row-click panel.
A backend that implements it always emits the field, explicit `null` when
unset (never omitted), matching the existing wire convention for optional
`ProbeDetailsEntry`/`ProbeDetailsColumn` fields like `columns`/`group_by`.

- `GET /api/v1/identity` gains `link_bases:{<name>:str,...}` — named URL
  bases from `ui.link_bases`, keyed by base name; `{}` (never absent) when
  unset. Probe-details link templates resolve `{<base>}` tokens against
  this map.
- `ProbeDetailsEntry` (and `ProbeDetailsColumn`, one column of a
  table/tables/tree entry) gain four presentation fields:
  - `link_template:str|null` — a template with `{value}` / `{row.<field>}`
    (columns and detail elements only) / `{<base>}` tokens, expanded into a
    clickable link. `{value}`/`{row.*}` substitutions are percent-encoded;
    the base is inserted raw. A token that fails to resolve (missing base,
    missing/null row field, null value) makes the WHOLE template fail —
    the UI then renders plain text, never a link with a hole in it.
  - `badge_colors:{<value>:str,...}|null` — present only on `view="badge"`
    entries/columns (a new `view` enum value). Maps expected values to one
    of `green|red|yellow|blue|gray|purple`; the key `"*"` is the fallback
    for unmapped values. A value with no match and no `"*"` renders as
    plain, uncolored text. Mutually exclusive with `link_template` in
    practice — a column declaring both renders as a badge, the link is not
    rendered — but the wire does not forbid sending both.
  - `format:str|null` — one of `duration_ms` (int ms → `"1 m 5 s"` style),
    `bytes` (int bytes → binary-unit string, e.g. `"10.0 MiB"`), `timestamp`
    (ISO-8601 string → canonical `"YYYY-MM-DD HH:MM:SS.sss"`), `number` (int
    or float → thousands-grouped string). Hovering a formatted value shows
    the raw underlying value.
  - `hint:str|null` — a tooltip, same template grammar as `link_template`
    but rendered unencoded (it's read, not navigated).
- `ProbeDetailsEntry` gains `detail:ProbeDetailsDetail|null` — a row-click
  side-panel layout for `table`/`tables`/`tree` entries, opened via a `›`
  affordance on each row:
  - `ProbeDetailsDetail`: `{title:str|null, elements:[ProbeDetailsElement]}`.
    `title` uses the same template grammar, `{row.<field>}` resolved from
    the clicked row.
  - `ProbeDetailsElement`: `{view:"string"|"keyvalue"|"table"|"links",
    field:str|null, label:str|null, links:[ProbeDetailsLink]|null}`. Every
    view but `"links"` carries `field` (a row-model field name) and leaves
    `links` null; `"links"` carries `links` and leaves `field` null.
  - `ProbeDetailsLink`: `{label:str, template:str}` — both always non-null.
  - Mutually exclusive with `link_template` on the same entry (a
    `view="string"` entry can have a link; a row-bearing entry can have a
    `detail`; nothing has both).

## v1.5 additions (2026-08-09)

Backend-declared dashboard pages and the UI's live-refresh
behavior for their widgets. Additive: one new endpoint, two new schemas. A
backend that predates this section has no `/api/v1/pages` route; the UI's
`loadUiPages()` treats that failure the same as any other optional-endpoint
miss and degrades to an empty page list, so the app shell renders unaffected
— just without the extra nav entries.

- `GET /api/v1/pages` → 200 `UIPage[]`, in declaration order. A handler
  opts in by registering `ui_pages` in its config. A handler that declares
  none — every Go worker today, or a Python worker without `ui_pages`
  configured — returns `[]`, never a 404: the empty-list case is the
  well-defined default, not an error. The UI shows no extra nav entries in
  that case, and `/p/<slug>` resolves to `NotFound` for any slug (there is
  nothing declared for it to match).
- **`UIPage`**: `{slug:str, title:str, widgets:[UIPageWidget]}`. `slug`
  routes at `/p/<slug>`; the nav gains one entry per declared page
  (`{label:title, path:"/p/<slug>"}`), appended after the four built-in
  entries. `/p/<slug>` looks the page up by `slug` against the pages the UI
  already fetched at boot — an unmatched slug is indistinguishable from any
  other unmatched route and renders `NotFound`.
- **`UIPageWidget`**: `{title:str, view:str, source:{kind:str,...},
  columns:[ProbeDetailsColumn]|null, field:str|null,
  badge_colors:{<value>:str,...}|null, format:str|null}`. `columns`,
  `field`, `badge_colors`, and `format` are the same presentation fields
  v1.4 added to `ProbeDetailsColumn`/`ProbeDetailsEntry`, reused verbatim —
  a page widget renders through the identical column model as a
  probe-details table, just addressed by a declared page instead of a probe
  run. `view` and `source.kind` are open strings on the wire (the OpenAPI
  `enum` lists what current UIs know how to render, not a closed set);
  an unrecognized value on either is forward-compatibility, not an error —
  see below.
- **Source kinds.** `source.kind` selects which existing read API backs the
  widget — declared pages add no new data endpoint, only new ways to
  project data already served elsewhere:

  | `kind` | maps to | widget rows |
  |---|---|---|
  | `events` | `GET /api/v1/events?event_types=<source.event_types joined by ",">&limit=<source.limit\|\|200>` | one row per event |
  | `annotations` | `GET /api/v1/events?event_types=annotation&limit=<source.limit\|\|200>`, filtered client-side to rows whose `metadata.kind` starts with `source.kind_prefix` (default `""` — no filter) | one row per matching annotation: `metadata` spread onto the row, plus `ts` and `kind` |
  | `tasks` | `GET /api/v1/live/task-results?limit=<source.limit\|\|200>` | one row per task result |
  | `metrics` | `GET /api/v1/debug/metrics`, summed over the samples of the family named `source.metric` | none (`[]`) — `metrics` is scalar-only, for `view:"stat"` widgets |

  The `ts` and `kind` stamped onto an `annotations` row are applied after
  spreading `metadata`, so they win over any `ts`/`kind` keys the payload
  itself happens to carry.

  `source.event_types` (an array of strings) is absent-safe: a missing or
  non-array value degrades to `[]`, which the backend reads as "no filter"
  (every event type). This path is defensive only — the backend contract
  requires `EventsSource.event_types` to be non-empty (validated at startup),
  so a compliant backend never sends an `events` widget without it. A widget
  that does reach the `[]` fallback also gets no live refresh (see below,
  `refreshEventTypes` returns `[]` for it too) and only updates on manual
  reload/navigation — an accepted consequence of a state the contract
  otherwise forbids, not a case worth special-casing in the UI. A
  `view:"stat"` widget ignores `source.kind` entirely and always resolves
  through `source.metric`; a `stat` widget with no `source.metric` is the
  misconfigured-stat case below, not a source-kind mismatch.

- **Live refresh.** The UI opens one WebSocket subscription per page,
  covering the union of every non-`stat` widget's implied event types
  (`events` → its own `source.event_types`; `annotations` →
  `["annotation"]`; `tasks` → `["task_complete","task_completed",
  "task_failed"]`; `metrics` → `[]`, since a metrics-backed row widget has
  no live signal to key on). No socket opens when that union is empty (an
  all-`stat` page, or a page whose widgets all resolve to no event types).
  A matching frame schedules that widget's refetch; matches arriving within
  the same 500ms window collapse into one refetch rather than one per
  event, so a fan-out burst (hundreds of `task_completed` frames for one
  message) costs one refetch, not hundreds. `stat` widgets never subscribe
  to the socket — they refetch on a flat 30s interval instead, since a
  metric sum has no single WS event that means "this changed." Both the
  socket and the interval are scoped to the page's current widget set and
  are torn down and rebuilt on navigation, and torn down for good on
  unmount.

- **Forward compatibility.** An unrecognized `view` or `source.kind` is
  normal version skew between an older UI and a newer backend (or a
  config-authoring mistake), not an error — each half of the pair is
  reported independently so the fault is attributable at a glance, in the
  widget's own body:

  | condition | message |
  |---|---|
  | `view` itself is unrecognized | `This widget needs a newer UI (unsupported view '<view>').` |
  | `view` is known but `source.kind` is not | `This widget needs a newer UI (unsupported source '<kind>').` |
  | `view:"stat"` with no `source.metric` | `This widget is misconfigured: a 'stat' view needs a source with a 'metric' field.` |

  The `view` check runs first, so a widget with both an unrecognized `view`
  and an unrecognized `source.kind` is reported only for the `view` — it is
  never blamed for a source problem it does not, in the UI's eyes, have.

## v1.6 additions (2026-08-09)

Deployment-provided custom cell renderers: an escape hatch for presentation
the built-in link/badge/format enrichment (v1.4) can't express — a table
column, a scalar probe-details entry, or a detail-panel element can name a
renderer function instead of relying on the UI's generic cell markup.
Additive and opt-in: a backend that predates this section omits
`custom_renderers` from `GET /api/v1/identity` and every `renderer` field
from `ProbeDetailsColumn`/`ProbeDetailsEntry`/`ProbeDetailsElement`; the UI
never fetches the module and never reaches `CustomCell`.

- `GET /api/v1/identity` gains `custom_renderers:bool` — true when the
  backend has `ui.custom_renderers_path` configured. The UI only fetches
  `GET /api/v1/ui/renderers.js` when this flag is true; a backend that omits
  it entirely (predates the flag) or reports `false` never triggers the
  fetch.
- `GET /api/v1/ui/renderers.js` serves the configured module byte-for-byte,
  same-origin, `Content-Type: text/javascript`. Cached with a content-hash
  `ETag`; the browser's own HTTP cache handles `If-None-Match` → `304` for
  an unchanged module, so re-navigating the app after boot re-imports the
  same bytes without a full re-download. `404` (with a `reason` in the
  body) when nothing is configured. v1-only, no legacy unprefixed alias.
  - The dynamic `import()` used to load the module cannot carry an
    `Authorization` header, so on a backend with `ui.auth_token` configured
    the token rides as a `?token=` query parameter instead — the same
    mechanism the WebSocket handshake and file downloads already use
    (`downloadUrl` in `src/lib/api.ts`).
- **Module contract.** The served module's default export is a plain
  object mapping renderer names to functions:

  ```js
  export default {
    statusPill: (value, row, cell) => {
      /* ... */
      return anHTMLElement
    },
  }
  ```

  Each function has the signature `(value, row, cell) => HTMLElement`:
  - `value` — the cell's raw decoded value (the same value the built-in
    link/badge/format path would have received).
  - `row` — the full row object for a table/tables/tree column, or the
    clicked row for a detail-panel element; `undefined` only for a scalar
    entry (there is no sibling row to hand over).
  - `cell` — a small context object, currently `{key?: string}`: the
    column key, the entry key, or the detail element's field name,
    whichever declared the renderer.
  - The function must return a real `HTMLElement` synchronously. Anything
    else — a string, a Promise, `undefined` — is treated as a failure (see
    below).

- **Trust model.** The module is deployment-owned code, not content
  Drakkar generates — it runs with the same trust as the rest of `ui.*`
  config (link templates, badge colors) and with full DOM access to
  whatever element it returns. Serving it same-origin is a deliberate
  choice: a deployment that configures `ui.custom_renderers_path` is
  choosing to run its own JS in the debug UI's origin, the same way it
  already chooses the URLs behind its link templates.
- **Fallback rules.** Loading and rendering are both best-effort; nothing a
  broken or unconfigured renderer does can take the surrounding
  table/panel down with it. Every one of the following degrades to the
  cell's plain-text fallback plus one `console.warn`, never a thrown error
  the UI must catch elsewhere:
  1. `ui.custom_renderers_path` unconfigured, or `custom_renderers` is
     `false`/absent on `GET /api/v1/identity` — the module is never
     fetched.
  2. The fetch/dynamic-import fails (network error, non-200, syntax error
     in the module).
  3. The module's default export is not a plain object.
  4. No entry exists under the declared `renderer` name.
  5. The named entry is not a function.
  6. The function throws.
  7. The function returns something other than an `HTMLElement`.

  The fallback text is the plain rendering the cell would have used had no
  renderer been declared at all: for a table/tables/tree column, the same
  `text` `renderCell` would compute from the column's other fields; for a
  scalar `view="custom"` entry or a detail-panel `view="custom"` element —
  neither of which calls `renderCell` — `String(value)`, or `"—"` for
  `null`/`undefined`/`""`, matching every other scalar/detail view's own
  null rendering.

- **Where `renderer` is legal, and exclusivity.** `renderer:str|null` is
  added to `ProbeDetailsColumn` (table/tables/tree columns — also covers
  `UIPageWidget.columns`, which reuses the same schema), `ProbeDetailsEntry`
  (scalar entries, gated by a new `view="custom"` enum value), and
  `ProbeDetailsElement` (detail-panel elements, same new `view="custom"`
  value). On the wire, `renderer` is **boot-time exclusive** with
  `link_template`/`badge_colors`/`format` — the backend validates this at
  startup (a column or entry declaring both is a config error, rejected
  before the worker serves any probe), not negotiated per request. The UI
  therefore never has to choose between, say, a badge and a custom
  renderer at render time; each call site checks `renderer` first purely
  so the branch order matches the schema's stated precedence, not because
  two declarations could ever collide in practice. `hint` is not in that
  exclusion list, so a column may declare `renderer` and `hint` together;
  the resolved hint still lands as the `title` attribute on the cell's
  `<td>` wrapper, next to whatever the renderer mounts inside it.

## v1.7 additions (2026-08-10)

Timeline tuning: configurable history depth, declarative bar-color rules,
and label-role bindings for the Live timeline, replacing the previous
hardcoded 10-minute window and fixed origin/status coloring. Additive: one
new `Identity` field, two new schemas, one new query parameter, one new
response field. A backend that predates this section omits `timeline` from
`GET /api/v1/identity` entirely, which is the only thing the UI checks —
it keeps its previous fixed-window, fixed-color timeline behavior whenever
that field is absent.

- `GET /api/v1/identity` gains `timeline: TimelineSettings`, the
  `ui.timeline` config verbatim: `{history_factor:int, max_age_minutes:int,
  color_rules:[TimelineColorRule], labels:{tag?,caption?,highlight?,
  filter?,marker?}}`. `labels` carries only the bound roles — an unbound
  role is absent, never an empty string.
- **`TimelineColorRule`**: `{name:str, when:[TimelineRuleCondition],
  color:str}`. `when` always arrives as an array — even a single-condition
  rule is normalized to a one-element list on the backend — and is
  evaluated as an AND: every condition must match for the rule to apply.
  `name` is `''` when the rule has no display name; the legend then falls
  back to generated condition text (see below).
- **`TimelineRuleCondition`**: `{label?:str, field?:str, op:str,
  value?:str|number}`. Exactly one of `label`/`field` is present
  (backend-validated at startup; both or neither is a boot error): `label`
  reads a task label (`labels[key]`, absent when the key is unset), `field`
  reads one of a fixed set of task fields (`status`, `origin`,
  `client_name`, `exit_code`, `duration`, `stdout_size`, `stdout_lines`,
  `stdin_size`, `stdin_lines`, `partition`). `op` is one of `eq`, `ne`,
  `contains`, `prefix`, `gt`, `ge`, `lt`, `le`, `exists`, `missing`; `value`
  is absent for the value-less ops `exists`/`missing`, required otherwise.
- **UI-side evaluation** (`src/lib/timelineRules.ts` — these semantics are
  enforced client-side, not carried on the wire):
  - A missing label or a null/undefined field is "absent": every op except
    `missing` fails against it, and `missing` succeeds; `exists` is the
    inverse. Deliberate consequence: `{field: stdout_size, op: eq, value:
    0}` matches only a finished empty-output task — a running task's
    `stdout_size` is still `null`.
  - `gt`/`ge`/`lt`/`le` parse both sides with `parseFloat`; either side
    failing to parse (`NaN`) makes the condition false.
  - `eq`/`ne` compare numerically when both sides parse as finite numbers,
    else as strings (`String(actual) === String(value)`); `ne` is the exact
    negation of `eq`.
  - `contains`/`prefix` are case-sensitive substring/prefix checks on the
    string form of both sides.
  - Rules evaluate in config order; the first rule whose `when` fully
    matches wins. No match → `origin === 'http'` gets `#9c27b0` (today's
    `.bar.http` styling, now an overridable implicit rule rather than a CSS
    `!important`), else the task's status color (`completed` `#34d399`,
    `failed` `#f87171`, `running` `#fbbf24`).
  - `color` is a palette name or a literal `#rrggbb` hex. The eight-name
    palette is defined once, in `TIMELINE_PALETTE`:

    | name | hex | | name | hex |
    |---|---|---|---|---|
    | green | `#34d399` | | gray | `#9ca3af` |
    | red | `#f87171` | | lightgray | `#d1d5db` |
    | yellow | `#fbbf24` | | purple | `#a78bfa` |
    | blue | `#60a5fa` | | orange | `#fb923c` |

    An unrecognized name (or a malformed hex) falls back to `gray`.
  - The legend shows one chip per configured rule: `name` when set,
    otherwise generated text per condition (`<target> <op> <value>`, e.g.
    `stdout_size eq 0`) joined with `&` for a multi-condition rule.
- `GET /api/v1/recent-tasks`:
  - New optional `limit` query parameter (`1`–`100000`). Omitted → the
    backend resolves it from `history_factor × <executor pool size>` (pool
    not yet attached → `× 8`, matching the existing lane-count fallback),
    itself clamped to `100000` since neither config value has its own
    ceiling.
  - `minutes`'s allowed range rises to `1`–`1440`; requests are
    additionally clamped server-side to `ui.timeline.max_age` when
    that config is smaller.
  - Each `RecentTaskEntry` gains `stdout_size:int|null` — the existing
    recorder column, now selected on the resync path so color rules keyed
    on it work for resync-loaded rows too, not only rows a
    `task_completed` WS frame has already patched. `null` while the task is
    running and on failed tasks — neither backend writes `stdout_size` on
    `task_failed` — set only once the task completes.
  - `truncated:bool` is now a required field on `RecentTasks`, formalizing
    behavior the UI already read: `true` when the row cap dropped older
    events from the query window, or when the assembled result was trimmed
    down to `limit` tasks.
  - `unavailable:bool` (optional) marks a payload the backend could not
    fill: the recorder read failed because no reader connection was
    available, or the bounded main-loop dispatch timed out. `tasks` is then
    an empty placeholder, not a measurement — the worker may well be busy.
    A backend that predates this field answers the same condition with a
    bare `[]` instead of an object, so a client must treat any response
    that is not an object carrying a `tasks` array as equivalent to
    `unavailable: true` rather than as zero tasks. **Degradation
    semantics**: on either form, clients keep the tasks, lane count, and
    truncation state they are already showing and surface a notice that the
    data is stale; they clear the notice on the next payload that carries
    real data. Rendering an empty timeline here is wrong — it is
    indistinguishable from an idle worker.

## v1.8 additions (2026-08-10)

Read-only access to compressed recorder archives: the periodic archive pass
(`recorder.archive.enabled`) folds a finished time window's raw
`<worker>-*.db` files into one gzip-compressed, merged sqlite db per
cluster and deletes the raw files it merged. Additive: two new endpoints,
two new schemas. A backend that predates this section has no
`/api/v1/debug/archives` route; the UI's Archives section treats that 404
the same as any other optional-endpoint miss and hides itself entirely —
the raw-databases list above it is unaffected.

- `GET /api/v1/debug/archives` → `{archives:[ArchiveEntry]}`, newest-first
  by `to_ts`, already sorted server-side. Name-only: every field is parsed
  from the archive file name, so listing costs one directory scan plus one
  `stat` per match, never an open of the file itself.
- **`ArchiveEntry`**: `{name:str, cluster:str, from_ts:number, to_ts:number,
  size_bytes:int}`. `from_ts`/`to_ts` are the window's epoch-second bounds
  (`[from_ts, to_ts)`), not per-event timestamps — a file belongs to the
  window holding its own start time, so an archive can carry a handful of
  events past its own `to_ts`.
- **Name grammar**: `<cluster>-<from>__<to>.db.gz`, where `<cluster>` is
  `[a-zA-Z0-9_-]+` (files with no cluster set fall under `default`) and
  `<from>`/`<to>` are `YYYY-MM-DD_HH-MM` in UTC, minute precision — window
  bounds always land on a multiple of the configured window width, so
  seconds carry no information. `name` is opaque to the UI: it is passed
  straight through to the download endpoint and never parsed client-side.
- `GET /api/v1/debug/archives/{name}` (removed in v1.23; archives download through `/debug/download/{path}`) → the archive file as an attachment:
  `Content-Type: application/gzip`, `Content-Disposition: attachment;
  filename="..."`, `Cache-Control: no-store, private`. `name` must match
  the naming grammar above and resolve inside the backend's storage folder; a
  rejected, path-escaping, or missing name all answer `404`, never a
  distinguishable error — same non-disclosure shape as `/debug/download`.
  The token rides as `?token=` exactly like `/debug/download`, since a
  plain `<a>` navigation cannot carry an `Authorization` header.
- **Not offered for merging.** The UI never lists an archive as a merge
  candidate — the Archives section is read-only, with no selection
  checkboxes and no path into the merge request. `/debug/merge` itself does
  not reject an archive filename passed to it by hand: filename hardening
  only checks for path traversal and unsafe characters, so a well-formed
  archive name resolves and passes that check. The merge engine then fails
  to open it as sqlite (it is gzip bytes) and — per its existing "a source
  that cannot be opened or read is skipped rather than failing the whole
  merge" behavior — silently drops it from the result instead of rejecting
  the request; the response is still `200`, just without that source
  counted in `source_files`.

## v1.9 additions (2026-08-11)

Two additive event TYPES around host resources, no new endpoint, no
events-table change. A backend that predates this section simply never
emits them.

- **`resource_sample` event** (persisted — an ordinary events-table row),
  one per state-sync tick: `metadata` JSON with `rss_bytes:int`,
  `threads:int`, `open_fds:int`, `cpu_self_pct:number`,
  `cpu_children_pct:number`, `rx_bytes_total:int`, `tx_bytes_total:int`,
  `interval_s:number` — **every field optional**; a field is omitted when
  its platform source is unavailable, and the first sample after start
  carries no `cpu_*_pct` / `interval_s`. `cpu_children_pct` counts *reaped*
  subprocesses (CPU lands when a task's process exits), so the series is
  bursty by nature. Clients must ignore unknown metadata keys.
- **`net_io` WS frame** (broadcast only, never persisted — the pinned
  20-column row shape is untouched), described below; the UI readout stays
  hidden on backends that never send it. **Retired in v1.19** together
  with the `rx_bytes_total` / `tx_bytes_total` keys above.

- **`net_io` WS frame**, one per state-sync tick (default 10s), in the
  standard event wire shape: `{ts, dt, event:"net_io", metadata:<JSON str>}`.
  Metadata: `{rx_mib_s:number, tx_mib_s:number, rx_bytes_total:int,
  tx_bytes_total:int, interval_s:number}`. Rates are MiB/s averaged over
  `interval_s`; totals are the raw kernel counters the rates were diffed
  from.
- **Semantics**: counters come from `/proc/net/dev`, summed across all
  non-loopback interfaces — **host-wide per network namespace** (the worker,
  its subprocesses, and anything else sharing the namespace; per-process
  network accounting does not exist without root/eBPF). On platforms
  without `/proc/net/dev` (macOS) the backend sends no frames at all.
- **Client behavior**: subscribers must opt in via `?events=` as with any
  type; the UI adds `net_io` to the Live page and per-peer cluster-view
  subscriptions and shows `RX x.x · TX x.x MiB/s`. A reading is dropped
  whenever the socket leaves `connected` — a stale rate must not read as
  current. An interval in which the kernel counters went backwards
  (interface bounce) produces no frame rather than a nonsense rate.

## v1.10 additions (2026-08-14)

One additive optional field and one additive event type, both introduced
by the Python backend's handler `offload()` API (CPU-bound hook work
moved to a thread pool so the event loop stays responsive). No new
endpoint, no events-table change.

- **`offload` object on `GET /api/v1/live/overview`** — optional;
  key-presence is the feature flag. Shape:
  `{running:int, queued:int, max_threads:int}` — computations currently
  executing on the offload pool, calls waiting for a free pool thread,
  and the configured pool size. A backend without an offload pool (the
  Go worker — goroutine preemption makes one unnecessary; see its
  runtime-health doc for the pattern) omits the key entirely and the UI
  readout stays hidden.
- **`offload` event** (persisted — an ordinary events-table row), one per
  `handler.offload()` call, recorded at completion. Columns: `partition`
  (nullable — `NULL` when offload ran outside a framework-invoked hook),
  `offset` / `task_id` following the annotation anchoring rules
  (message-anchored / task-anchored / neither for window-wide hooks),
  `duration` (execution seconds, queue wait excluded). `metadata` JSON:
  `{hook:str, function:str, queued:number, status:"ok"|"error"|"cancelled",
  window_id:int|null, offsets:int[]}` plus optional `error:str` (truncated
  to 500 chars) when `status="error"`. `offsets` is non-empty only for
  window-scoped rows, mirroring window-scoped annotations' trace-matching
  contract. Clients must ignore unknown metadata keys.

## v1.11 additions (2026-08-14) — retired in v1.19

Four additive optional keys on the existing `net_io` WS frame's metadata,
no new frame, no events-table change:
`nfs_read_mib_s:number`, `nfs_write_mib_s:number`,
`nfs_read_bytes_total:int`, `nfs_write_bytes_total:int`.

- **Why**: the frame's `rx/tx` counters are per **network namespace**
  (`/proc/net/dev`). A containerized worker reading files over a
  kernel-NFS mount generates traffic through the **host's** interfaces —
  invisible to the container's counters, so the RX readout sits near
  zero while the host moves a GiB/s. The NFS pair comes from
  `/proc/self/mountstats` instead, which follows the *mount* namespace
  and therefore does see bind-mounted NFS volumes from inside a
  container.
- **Semantics**: sum of the `bytes:` line's server-read / server-write
  columns across every visible `nfs*` mount — bytes actually transferred
  to/from NFS servers, page-cache hits excluded. Per-mount counters:
  other host processes using the same mount contribute. Read = data from
  the server (RX-like), write = data to the server (TX-like).
- **Presence rules**: all four keys appear together, only on ticks where
  an NFS mount was visible on both ends of the interval and its counters
  did not go backwards (remount). Backends without mountstats (macOS,
  the Go worker for now) or without NFS mounts simply omit them.
- **Client behavior**: the UI shows an `NFS: R x.x · W x.x MiB/s`
  readout next to the Net readout on the Live header and peer strips,
  hidden whenever the current frame lacks the pair; a half-formed pair
  is ignored. Clients must ignore unknown metadata keys, as ever.

## v1.12 additions (2026-08-14)

Four additive optional fields on `GET /api/v1/debug/databases` rows, plus
a behavioral note. No new endpoint.

- **Fields**: `kind: "recorder"|"merged"|"cache"|"unknown"`,
  `live_for: string` (worker currently writing the file, `''` when none —
  resolved from the `*-live.db` / `*-cache.db` symlinks; a cache DB
  counts as in-use when its worker's recorder is live in the same
  directory), `stats_pending: bool`, `cache_entry_count: int|null`
  (kind=`cache` only). Cache databases now appear as rows, displayed
  under their stable symlink name (`<worker>-cache.db`) while `path`
  points at the scanned `.actual` file.
- **Behavior**: backends may serve statistics from a shared
  `.dbstats.db` cache in the storage folder, keyed by `(path, mtime_ns, size_bytes)`
  (schema `db_stats_v1`, identical across backends — a mixed fleet
  shares the file). The file *list* is always a live directory scan, so
  externally deleted files disappear on the next request; only derived
  statistics are cached. `stats_pending: true` marks rows whose
  statistics were not computed yet (cold cache, per-request inline scan
  budget exhausted); a
  background warmer fills them in, so clients should simply re-poll.
  Clients must ignore unknown keys, as ever.

## v1.13 additions (2026-08-19)

Three new endpoints under `GET /api/v1/debug/kafka/*`: ad-hoc reads of the
worker's configured Kafka topics. Also `ui.kafka_read_enabled` (default
true) — when false all three serve `403 {"error":...}` (probe/merge
pattern: routes stay registered, policy refuses).

- **Alias addressing.** Clients never name a raw Kafka topic. The path's
  `{alias}` is one of: `source` (the pipeline input topic), `dlq` (the
  dead-letter topic), or a Kafka sink's operator-chosen instance name. A
  sink named `source`/`dlq` is not readable (reserved aliases win; backends
  log a warning). Raw topic names and broker addresses never appear in
  requests or responses. `GET /debug/kafka/topics` lists
  `{topics:[{alias, kind:"source"|"dlq"|"sink"}]}`.
- **No consumer-group side effects** (normative): backends must read with
  assign/seek-style consumers that join no consumer group and commit no
  offsets. Reads are invisible to the pipeline's group and every other
  group.
- **`GET /debug/kafka/{alias}/message?partition=&offset=`** — exactly one
  record, `200 KafkaReadMessage`. `404 {"detail":...}` for unknown
  alias/partition, offset outside current watermarks, or a
  compacted/deleted slot (detail names the next surviving offset); `502`
  when brokers do not answer within the backend's deadline.
- **`GET /debug/kafka/{alias}/messages?from_ts=&to_ts=&limit=&partition=`**
  — `200 application/x-ndjson`, one `KafkaReadMessage` JSON object per
  line. Window: first offsets at/after `from_ts` (epoch ms, broker-side
  offsets-for-times) up to `to_ts` (inclusive-start, records past `to_ts`
  end that partition), `limit` messages (server cap 10000), or the
  end-of-topic snapshot taken at request start — whichever comes first.
  Ordering is monotonic per partition, best effort across partitions.
  Mid-stream broker failure ⇒ final `{"error":"..."}` line, stream ends.
  `422` when `to_ts < from_ts`.
- **`KafkaReadMessage`**: `{alias, partition, offset, timestamp_ms:int|null,
  key:str|null, key_encoding, payload:str, payload_encoding:"utf-8"|"base64",
  payload_size_bytes, headers:[{key, value:str|null, value_encoding}]}`.
  Byte fields are utf-8 text when the bytes decode, else base64, with the
  encoding flagged. `timestamp_ms` is null when the broker reports no
  timestamp. The record's topic is echoed as `alias`, never as the raw
  name. Since v1.27 a `dlq` record carries `dk-` headers after the source
  headers (see **v1.27 changes**); the shape is unchanged.
- **Security posture** (normative): the endpoints sit behind the standard
  optional `auth_token` gate. When any readable alias resolves to a
  non-PLAINTEXT Kafka security config while `auth_token` is empty (and the
  API is enabled), backends log a startup warning naming the exposed
  aliases — and keep serving; the operator owns the trade-off.

## v1.14 additions (2026-08-19)

Timed consume pause — a Live-page debug control that stops message intake
for a bounded period. Three endpoints, plus config
`ui.consume_pause.{enabled, durations}` (default: disabled,
presets `[15, 60, 300, 900]`).

- **`GET /debug/consume-pause`** — always `200 ConsumePauseState =
  {enabled, durations_seconds:[int], active, resume_at_ms:int|null,
  requested_seconds:int|null}`. `enabled: false` is the signal the UI
  hides its control on.
- **`POST /debug/consume-pause`** `{duration_seconds: 1..3600}` — pauses
  fetching on the assigned partitions and arms an auto-resume timer;
  answers the new state. Posting during an active pause replaces the
  deadline. `403 {"error":...}` when `ui.consume_pause.enabled=false`
  (**opt-in** — the flag defaults to false, unlike probe/merge, because
  pausing affects the pipeline's work); `503 {"detail":...}` while the
  consumer is not running; `422` outside [1, 3600].
- **`POST /debug/consume-resume`** — ends the pause now; idempotent
  (`200` with the inactive state either way). `403` when disabled.
- **Semantics** (normative): the pause must never leave the consumer
  group or trigger a rebalance — backends pause partitions (the
  backpressure primitive) while the poll loop and heartbeats continue.
  No offsets move. Partitions assigned during a pause arrive paused. The
  pause composes with backpressure: it blocks backpressure's resume
  while active, and a debug resume leaves backpressure-held partitions
  paused until queues drain. Stall-paused partitions
  (`dlq.on_send_failure=stall`) are never touched in either direction.
  The auto-resume deadline is authoritative server-side
  (`resume_at_ms`); clients render countdowns from it and re-poll to
  reconcile.

## v1.15 additions (2026-08-19)

Host-pressure sampling and runtime lag episodes: which resource the host is
fighting for, and what the runtime was doing while it lagged. Additive
throughout — new optional metadata keys on an existing event, two new event
types, two optional fields on `RuntimeHealthSnapshot`, two nullable
`worker_state` columns, no new endpoint. Backends that predate this section
simply omit everything; clients must ignore unknown keys, as ever.

### `resource_sample` — new optional metadata keys

Same cadence and optionality rules as v1.9 (one sample per state-sync tick;
a key is omitted when its platform source is unavailable — never zeroed):

- `load1:number`, `load5:number` — `/proc/loadavg`, host-wide.
- `psi_cpu_some_avg10:number`, `psi_io_some_avg10:number`,
  `psi_io_full_avg10:number`, `psi_mem_some_avg10:number`,
  `psi_mem_full_avg10:number` — kernel pressure-stall averages
  (`/proc/pressure/*`, 10-second windows, percent). `some` = at least one
  task stalled on the resource; `full` = all non-idle tasks stalled at
  once. Absent on kernels without PSI or in containers that mask it.
- `cpu_throttled_periods:int`, `cpu_throttled_ms:number` — cgroup CPU
  throttling **deltas over the sample interval** (v2 `cpu.stat`, v1
  fallback). Zero deltas are reported as `0`, distinct from "no cgroup
  limit" which omits the keys.
- `nfs_mounts:[{mount:str, ops:int, rtt_ms:number, retrans:int}]` — one
  entry per visible NFS mount with activity in the interval, from
  `/proc/self/mountstats` per-op counters. `ops` = operations completed in
  the interval, `rtt_ms` = average server round-trip per operation over the
  interval (the shared-storage-contention discriminator: throughput can
  look normal while RTT multiplies), `retrans` = retransmissions in the
  interval. A mount with zero ops and zero retrans is skipped; the whole
  key is omitted when no NFS mount is visible. Same mount-namespace
  semantics and caveats as the v1.11 `net_io` NFS keys.
- Backend-specific keys (documented so a mixed fleet knows what it sees;
  currently emitted by the Go backend only): `goroutines:int`,
  `sched_latency_p99_ms:number`, `gc_pause_p99_ms:number` — Go
  `runtime/metrics` percentiles computed over the sample interval.
  Scheduler-latency p99 is the Go-side CPU-starvation signal.

### `runtime_lag_episode` event (persisted)

One row per **lag episode**: the span from the runtime-health monitor
leaving `healthy` to its return (or to the `runtime_health.max_episode`
cap, default `5m` — a longer incident produces several
back-to-back rows). Episodes exist because a single long blocking call is
already captured by `runtime_stall`, while *diffuse* degradation — many
small delays, CPU starvation — previously produced a `stalled` badge with
no recorded evidence. `duration` column = episode wall seconds. `metadata`
JSON:

- `duration_ms:number`, `peak_lag_ms:number`, `lag_sum_ms:number` —
  wall length, worst single lag, and accumulated lag over the episode.
- `cpu_ms:number` (optional) — CPU time consumed **by the runtime's own
  scheduler thread** during the episode (Python: the event-loop thread via
  `/proc/self/task/<tid>/stat`; Go: process `getrusage`, the closest
  analogue). Omitted when unreadable.
- `cpu_ratio:number` (optional) — `cpu_ms / duration_ms`.
- `verdict:"blocked"|"cpu_bound"|"starved"|"inconclusive"` — the monitor's
  classification: `blocked` = the loop sat in one dominant call site with
  little CPU (the stacks name it); `cpu_bound` = the loop itself consumed
  the wall time (the stacks show the hot site); `starved` = the process
  wanted CPU and did not get it — host-level contention, look at the
  host-pressure keys; `inconclusive` = none of the patterns dominated.
- `stall_count:int` — hard `runtime_stall` events that fired inside this
  episode (their rows still exist independently and carry the full
  stacks).
- `sample_count:int`, `stacks:[{stack:str, location:str, count:int}]`,
  `dropped_stacks:int` — repeated scheduler-thread stack samples taken
  through the whole episode (not only while the heartbeat was stale),
  deduplicated by innermost frame, capped by
  `runtime_health.max_stall_stacks`. On the Go backend, `stacks` entries
  are goroutine-dump groups (`count` = goroutines in the group) and may be
  empty.
- `unit_count:int` — live tasks/goroutines at episode close.
- Optional evidence, best-effort at close: `cpu_throttled_ms:number`
  (throttling delta across the episode), `psi_cpu_some_avg10:number`,
  `load1:number`.

### `runtime_probe` event (persisted, opt-in)

A flight-recorder profiler for tuning production: disabled unless
`runtime_health.probe_interval_seconds > 0` (default `0`). Every interval
the monitor's sampler thread records one probe **regardless of state**:

- `lag_ms:number` — current lag at capture.
- `unit_count:int` — last-known live-unit count.
- `stacks:[{stack:str, location:str, count:int}]` — Python: the event-loop
  thread's stack, a single entry with `count: 1`; Go: the top goroutine
  groups by count, one representative stack each.

Capture cost is one thread-stack read (Python) or one goroutine dump (Go)
per interval; the key is off by default because it writes rows forever.

### `RuntimeHealthSnapshot` — two optional fields

Served by monitor memory, so they answer **during** an incident even when
the persisted-event read path is degraded — clients should render stall
evidence from the snapshot when event queries return nothing:

- `current_episode: RuntimeCurrentEpisode | null` — the open episode, with
  a running verdict; `null` between episodes. Absent field = pre-v1.15
  backend.
- `recent_episodes: [RuntimeEpisodeSummary]` — closed episodes, newest
  last, bounded server-side (50).

### `worker_state` — two new nullable columns

`health_state TEXT` (`healthy`/`degraded`/`stalled`, `NULL` when the
monitor is off) and `loop_lag_ms REAL` (point-in-time lag at the sync
tick), refreshed every state-sync tick like the pool columns. Merged
fleet databases can now answer "which worker was degraded when" without
replaying events. Readers must tolerate their absence in databases
written by older backends.

## v1.16 additions (2026-08-20)

Task cost, speed, and throughput: an opt-in per-task number that
correlates with the task's computational hardness, and the rates derived
from it. Additive throughout — two optional metadata keys, two optional
row fields, one new broadcast-only WS frame, one nullable `worker_state`
column, no new endpoint.

- **Concept.** The operator picks a numeric task label (any unit: bytes,
  a computed hardness score, …) and names it in backend config:
  `throughput.cost_label` (empty default = feature off), with
  `throughput.min_cost` as the smallest value worth counting. A task's
  **cost** is that label parsed as a float. **speed** = cost / duration
  (cost-units per second, per task). **throughput** = sum of the cost of
  tasks completed in the last N seconds / N, for the fixed window set
  N ∈ {1, 5, 30, 60, 300}, alongside **task_rate** (count / N) and
  **tasks** (count).
- **Counting rules** (normative): a task is counted iff the feature is
  configured AND the task completed successfully (failed work is not
  throughput) AND it is not a precomputed fast-track task (no subprocess
  ran; near-zero durations would fabricate absurd speeds) AND its label
  parses as a finite number AND `cost >= min_cost` AND `duration > 0`.
  Below-threshold and otherwise-excluded tasks carry NO cost/speed
  anywhere — the keys are absent, never zeroed.
- **`task_completed` metadata**: counted tasks gain optional
  `cost: number` and `speed: number` keys. Clients must ignore unknown
  keys, as ever.
- **`GET /api/v1/recent-tasks` rows**: same optional `cost` / `speed`
  fields (absent or null when not counted).
- **`throughput` WS frame** (broadcast only, never persisted — the pinned
  20-column row shape is untouched), one per second while the feature is
  configured, in the standard event wire shape
  `{ts, dt, event: "throughput", metadata: <JSON str>}`. Metadata:
  `{"windows": {"1": {"throughput": number, "task_rate": number,
  "tasks": int}, "5": {...}, "30": {...}, "60": {...}, "300": {...}}}` —
  all five keys always present (**v1.19 trims the set to `1`/`5`/`30`**);
  quiet windows report zeros, so an idle or
  stalled worker draws a real dip rather than a gap. Subscribers opt in
  via `?events=` as with any type. No frames at all when the feature is
  off — the UI hides its readouts entirely.
- **`worker_state`**: new nullable TEXT column `throughput` holding the
  same five-window object as JSON at each state-sync tick (NULL =
  feature off). worker_state rows are an append-only time series, so
  merged fleet databases get replayable throughput history without a new
  event type. Readers must tolerate the column's absence in databases
  written by older backends.
- **Prometheus** (same names on both backends): `drakkar_task_speed`
  (histogram, per counted task), `drakkar_throughput{window="1|5|30|60|300"}`
  and `drakkar_task_rate{window=...}` (gauges, refreshed each second).
  Nothing is registered when the feature is off.

## v1.17 additions (2026-08-22)

User-defined application config in the config reference: one OPTIONAL new
group on `GET /api/v1/config-reference` (shapes pinned in
`docs/openapi-v1.yaml`: `ConfigReferenceResponse` /
`ConfigReferenceGroup` / `ConfigReferenceEntry`). Additive — no new
endpoint, no entry-shape change.

- **The `app` group.** When the worker's operator has declared
  application config — the user-defined section under the shared
  `drakkar.yaml`'s `app:` key, overridable through a **user-chosen** env
  prefix — the response gains one extra group: `key: "app"`,
  `title: "Application"`, `doc_anchor: "app-config"`. Entry shape and
  semantics are identical to every other group (same
  `ConfigReferenceEntry` fields, same secret masking, same `is_default`
  computation).
- **`env` prefix.** Entries in this group carry env names built from the
  operator's chosen prefix (e.g. `MYAPP_SCORING__URL`), not the
  framework's `DK_` prefix. Clients must not assume any prefix; `env` is
  display/copy text, as everywhere else.
- **`doc_anchor` target.** `app-config` names the standalone docs *page*
  published at `/app-config/` on both backends' docs sites — unlike the
  framework groups, whose anchors are fragments within the
  `/config-reference/` page. Clients resolving `doc_anchor` into a link
  must special-case this slug (the UI keeps a page-slug table).
- **Absence** (normative): backends MUST omit the group entirely when no
  app config is bound — never an empty `app` group. Group presence is the
  feature signal, as with `webapp_tile`.
- **Unknown groups** (normative, previously implicit): clients MUST
  render groups they do not recognize generically from `key`, `title`,
  `doc_anchor`, and `entries`, never keying behavior on a closed list of
  group keys. Group-specific presentation (like the `app` tag above) may
  only ever be additive on top of the generic rendering.

## v1.18 additions (2026-08-22)

Worker liveness on the workers listing: two OPTIONAL fields per row of
`GET /api/v1/workers` (shape pinned in `docs/openapi-v1.yaml`: `Worker`).
Additive — no new endpoint, no change to the existing fields or the
clustered-first sort order.

- **`last_seen_ts: number | null`** — epoch seconds of the newest
  heartbeat in that worker's recorder database; `null` when no heartbeat
  is known.
- **`online: boolean`** — `true` iff the heartbeat is fresher than the
  serving backend's `autodiscover.offline_after`.
- **Current worker** (normative): the row with `is_current: true` always
  reports `online: true` — the backend answering the request is alive by
  construction.
- **Absence** (normative): pre-v1.18 backends omit BOTH fields entirely,
  never `null`-ed or defaulted. Clients MUST degrade to the previous
  behavior and treat every worker as online when the fields are absent.
- **Operational meaning.** In this version peers were discovered through the shared storage folder,
  and a crashed worker's `-live.db` symlink can linger long after its
  process died. Such a worker keeps its row but now reports
  `online: false`, so clients can gray it out and skip live (WebSocket)
  connections to it instead of retrying a dead address.

## v1.19 changes (2026-08-23)

A pruning release — nothing new, two surfaces retired. Pre-1.0: no
compatibility shims on either side.

- **`net_io` WS frame retired** (the v1.9 frame and its v1.11 NFS keys).
  Backends no longer sample `/proc/net/dev` or the `bytes:` line of
  `/proc/self/mountstats`, send no `net_io` frames, and ignore `net_io`
  in a `?events=` subscription like any unknown type. The UI no longer
  subscribes to it and has no `Net: RX/TX` or `NFS: R/W` readouts. The
  per-mount NFS **health** (`nfs_mounts` RTT / retransmits on
  `resource_sample`, v1.15) is unaffected — that is latency, not a byte
  rate, and the Runtime tab still shows it.
- **`resource_sample`** no longer carries `rx_bytes_total` /
  `tx_bytes_total`. Readers must already tolerate absent keys (every
  field is optional), so nothing changes for them beyond the keys never
  appearing again.
- **Throughput window set is `1`, `5`, `30`** seconds (`60` and `300`
  dropped) in the `throughput` WS frame, the `worker_state.throughput`
  JSON, and the Prometheus `window` label of `drakkar_throughput` /
  `drakkar_task_rate`. The UI requires exactly the three pinned keys when
  parsing a frame and ignores extra keys, so a v1.16–v1.18 backend's
  five-window frame still parses; `worker_state` rows written before
  v1.19 keep their five-window JSON. The Live timeline draws the `5`
  window by default; the switcher (`1s` / `5s` / `30s`) and the current
  reading moved from the toolbar into the timeline's gear popover.
- **UI presentation** (informative, not contractual): the consume-pause
  presets (v1.14) are behind a `Pause consuming` popover button in the
  Live header instead of their own row; the active-pause banner is
  unchanged. The timeline color legend is swatches only, each naming its
  meaning on hover.

## v1.20 changes (2026-08-23)

- **`live/overview.running_tasks` / `.pending_tasks` are integers.** They
  were objects keyed by `task_id`, each value
  `{task_id, args, partition, source_offsets}`. No UI release ever read
  either map, and `openapi-v1.yaml` has always typed both as `integer` —
  the maps were cost with no consumer.

  The cost was real on both sides. A backend built one entry per in-flight
  task on every poll, `args` included, and derived the running/pending
  split from an SQL anti-join (`task_started` rows with no terminal row)
  with no time bound and no `LIMIT`, forcing a recorder flush first. One
  source message can arrange a thousand tasks, so both scaled with
  in-flight work and history size rather than with worker size, and a page
  refresh on a busy worker could stall the event loop for seconds.

  Backends now report the split from in-memory pipeline state: the
  executor pool's set of slot-holding task ids, probed against the
  partition processors' in-flight sets. That is O(max_executors ×
  partitions) and touches no database, so the Live page also keeps
  answering when the recorder DB is wedged.

  Pre-1.0: no compatibility shim. A client reading the old maps sees a
  number; a v1.20 backend never emits an object here.

- **`POST /api/v1/debug/probe` answers 429** when more than 16 probes are
  already queued (`{error, max_waiters}` plus `Retry-After: 1`). Probes
  serialize on one lock; the queue in front of it had no bound. See the
  Debug section above.

- **HTTP transport limits** (informative, not a wire change): both backends
  now bound keep-alive idle time (120 s), request header size (64 KiB) and
  request body size on every HTTP surface, and the Python backend — which
  had none of these — additionally bounds its webapp body READ in time
  (`sources.http.request_timeout` + 30 s, answering **408**), which Go already
  got from `http.Server.WriteTimeout`. Deployments should still front these
  ports with a proxy that enforces its own read timeouts.

## v1.21 additions (2026-08-28)

### Custom timeline events

Operator-declared event types drawn on the live timeline. Optional end to
end: a backend without the keys/endpoint below is a valid older backend and
the UI renders no overlay.

**Identity: `timeline.events`** — new OPTIONAL key on the existing
`timeline` object: the declared event types, `enabled: false` entries
omitted (the UI never learns about disabled types).

```json
"timeline": { "...existing keys...": "...",
  "events": [
    {"name": "deployment_marker", "kind": "marker", "color": "purple",
     "line": "dotted", "label": "deploy {text}", "show": true,
     "link": "{grafana}/d/deploys?from={ts_ms}", "action": "link"}
  ]
}
```

Field domains: `name` `[a-z_][a-z0-9_]*` unique; `kind` `marker|range|flag`;
`color` timeline color name or `#rrggbb`; `line` `solid|bold|dotted`
(markers only, default `solid`, omitted otherwise); `label` optional
template (only `{text}` substitutes); `show` bool (initial UI visibility);
`link` optional URL template (present iff `action` is `link`); `action`
`none|link|highlight|filter` (default `none`). At most 50 entries.

**Instance wire shape** — an instance is an ordinary `annotation` event
(row and WS frame unchanged in shape), window-scoped (`offset` and
`task_id` null), with this metadata envelope:

```json
{"kind": "timeline_event", "scope": "window", "hook": "on_message_complete",
 "window_id": 41, "offsets": [1200, 1201],
 "data": {"type": "deployment_marker", "ts_ms": 1756350000000,
          "end_ts_ms": null, "text": "v2.1 deployed",
          "values": {"sha": "ab12f"},
          "match": null}}
```

`data.type` names a declared event type. `ts_ms`/`end_ts_ms` are
epoch-milliseconds integers; `end_ts_ms` is non-null iff the type's kind is
`range`. `values` is a flat object for tooltips and `{key}` link variables.
`match` is `null` or exactly one of `{"window_id": 41}`,
`{"offsets": [[0, 1200], [0, 1201]]}` (partition/offset pairs),
`{"label": ["request", "req-123"]}`.

Link templates resolve `{ts_ms}`, `{end_ts_ms}`, `{text}`, any `{key}`
from `values`, and `{base}` names from identity `link_bases`. A template
variable missing at render time → the UI renders the element without a
link. Instances whose `type` has no declaration are ignored by the UI.

**New endpoint `GET /api/v1/timeline/events?minutes=N`** — history
backfill for the timeline's visible window.

- `minutes` optional int, default and cap: the backend clamps to
  `timeline.max_age_minutes`.
- Response: `{"events": [InstanceEnvelope...], "unavailable": false}`,
  newest-first, capped at the backend's `ui.max_rows`; each entry is the
  metadata envelope above plus `"ts": <row epoch seconds float>` and
  `"partition": <int>` from the event row. Degraded reader →
  `{"events": [], "unavailable": true}` (HTTP 200).
- 404 on backends predating v1.21 — the UI must tolerate it.

**Live delivery** — instances arrive on the existing `/ws` `annotation`
frames; the UI filters `metadata.kind == "timeline_event"`. No new WS
event name.

## v1.22 changes (2026-08-29)

### Swagger relocation

The built-in OpenAPI/Swagger page moves from `GET /docs` to `GET /api-docs`
(assets: `/api-docs/swagger-ui-bundle.js`, `/api-docs/swagger-ui.css`).
`GET /docs` is no longer the API docs. Rationale: the path now belongs to
the operator docs site below. The UI never linked `/docs`, so no UI change
is required for the relocation itself.

### Operator docs site

Backends MAY serve an operator-supplied prebuilt static site under
`GET /docs/` (a static mount, NOT part of the JSON API; not listed in this
spec's `paths`). Serving rules: paths resolved and contained within the
configured directory; escapes and missing files are 404 (no SPA shell
fallback); directory requests serve `index.html`; the mount sits behind the
same auth gate as the SPA pages (open with no token, token-gated otherwise);
the token may ride as `?token=` on any `/docs/` request, exactly as on
`/api/v1/debug/download` and `/ws`, since a browser-issued page load carries
no `Authorization` header; unconfigured or missing directory → 404 with a
short JSON hint naming `ui.docs.site_dir`. Backends MUST register
`GET /docs/` unconditionally: when the feature is unconfigured, or the
configured directory is missing, the mount still answers and returns that
hint-404 — never the SPA shell.

### Identity: `docs` key (optional)

Present only when the feature is enabled:

```json
"docs": {
  "title": "Ranking Pipeline Docs",
  "anchors": [
    {"match": {"label": "module", "value": "vendor"},
     "path": "architecture/scanners/#vendor-scanning",
     "title": "Vendor scanning"}
  ]
}
```

`match` carries exactly one of `label` (with optional `value`), `sink`,
`event`, `page`. What each selector names: `label` a task label key, and
`value` one specific value of that key; `sink` a configured sink instance
name; `event` a declared timeline event type name (`timeline.events[].name`);
`page` a declared UI page slug. `path` is relative into the site, optional
`#fragment`, no `..`/scheme/leading slash. `title` omitted when empty. Most
specific match wins (`label`+`value` over key-wide `label`). At most 200
entries, and backends reject exact-duplicate matches at config load — two
anchors whose `match` objects are identical (same selector, same key, same
value or value absent on both); `label`+`value` and the key-wide `label`
are different matches, not duplicates. The UI renders contextual anchors
from this list and must tolerate the key's absence (older backend).

### Built-in `docs` link base

When the feature is enabled, identity `link_bases` includes a built-in
entry `"docs": "/docs"` (a same-origin path, unlike user bases which are
absolute URLs). User configs may not define a base named `docs` — backends
reject it at config load. Link templates may thus use `{docs}/page/#anchor`
anywhere templates already resolve bases.

## v1.23 changes (2026-10-14)

### Workers list from the worker registry

`GET /api/v1/workers` keeps its array shape, its fields and its
clustered-first sort order (shape pinned in `docs/openapi-v1.yaml`:
`Worker`). Peers now come from the backend's worker registry (cards
published by each worker) instead of a scan of a shared database folder.

Peer rows:

- **`worker_name`, `cluster`, `url`** — from the peer's card.
  `cluster_name` is the card's cluster, or `null` when that is `""`.
  `debug_url` equals `url`.
- **`ip_address: null`, `debug_port: null`** — a card carries a URL, not an
  address and a port. Clients MUST use `url` (or `debug_url`).
- **`online: boolean | null`** — `true`/`false` from the card's age on the
  registry's own clock against `autodiscover.offline_after`;
  **`null`** when the provider gives neither an online flag nor an age. Clients MUST
  treat `null` as "unknown", not as offline.
- **`last_seen_ts: number | null`** — epoch seconds on the serving worker's
  clock: `now − age` when the age is known, else `null`.
- **New optional fields**, present when the card carries them:
  `backend` (`"python"` | `"go"`), `version` (string), `state`
  (`"starting"` | `"running"` | `"draining"`), `started_at` (RFC 3339
  micro), `instance` (16 lowercase hex, new at every process start).

Current worker row (normative): `is_current: true`, `online: true`,
`ip_address: null`, `debug_port` = the UI port, `debug_url` =
`api.public_url` or `null`, and `url` = `api.public_url` when set, else
`http://<detected ip>:<port>/`. It carries its own `backend`, `version`,
`state`, `started_at` and `instance`.

Absence (normative): pre-v1.23 backends omit the five new fields and send
`ip_address`/`debug_port` values from their database scan. Clients MUST
render a row without the new fields exactly as before, and MUST NOT require
`ip_address` or `debug_port`.

### Merge failure answer

`POST /api/v1/debug/merge` answers **500** `{"error": "Merge failed:
<reason>"}` when the merge itself fails (a source cannot be read, the
output cannot be written). It uses the legacy `{"error"}` envelope of the
merge route's 400 and 404 answers, not the `{"detail"}` envelope of the
Conventions section. A failed merge leaves no output file.

### Sealed history: databases, downloads, merge, archives, trace

A worker now writes its recorder file only while it is live. At rotation
and at a clean stop it **seals** the file (rollback journal, closed) and
moves it into `<storage.shared_dir>/history/<cluster>/`, with a meta file
`<name>.db.meta.json` beside it. Merge results go to `<storage.shared_dir>/merged/`.
The debug routes below read those folders. Paths in requests and answers
are relative to `storage.shared_dir` and use `/` separators.

- **`GET /api/v1/debug/databases`** → an object, no longer an array:

  ```
  {"own": [OwnDb], "history": {"folders": [HistoryFolder]}}
  ```

  `OwnDb` is one of the serving worker's own files in `storage.dir`: the
  live file (`kind: "live"`) and files closed but not sealed yet
  (`kind: "backlog"`), with statistics measured on request:
  `{filename, worker_name, cluster_name: str|null, kind, event_count,
  event_counts: {<type>: int}, first_event_ts: float|null,
  last_event_ts: float|null, size_bytes}` (timestamps in epoch seconds, as
  before). Own files are not downloadable through `/debug/download`.

  `HistoryFolder` is `{folder, kind: "history"|"merged", cluster: str|null,
  files: [HistoryFile]}` — one per `history/<cluster>` folder (sorted by
  cluster), then `merged`. `HistoryFile` is `{path, name, kind:
  "sealed"|"archive"|"merged", size_bytes, modified_at, meta}`:
  `modified_at` is RFC 3339 micro; `meta` is the meta file object for a
  sealed file (keys `schema`, `worker`, `instance`, `cluster`,
  `first_event_ts`, `last_event_ts`, `sealed_at` — RFC 3339 micro or
  `null` — `size_bytes`, `tables`, `event_types`) and `null` for archives,
  merge results and a sealed file whose meta file is missing or unreadable.
  A meta file without its database is not listed. Files are sorted by name.
  A worker with neither a memory store nor a recorder file answers
  `own: []`; its `history.folders` follow the shared-folder rule: they are
  listed whenever a shared folder resolves, in every recorder mode (v1.25).

- **`GET /api/v1/debug/download/{path}`** — `path` is
  `history/<cluster>/<name>.db`, `history/<cluster>/<archive>.db.gz` or
  `merged/<name>.db`. Every segment follows the old filename hardening (no
  `/ \`, no leading `.`, no `"` `;` or control characters); the resolved
  file must stay inside `storage.shared_dir`. `Content-Type` is
  `application/x-sqlite3` for `.db` and `application/gzip` for `.db.gz`.
  404 for any other path or a missing file. Token may ride as `?token=`.

- **`POST /api/v1/debug/merge`** — `filenames` holds paths as above, `.db`
  only (sealed files and merge results; at least 2). The output is written
  to `merged/merged-<YYYY-MM-DD__HH_MM_SS>-<token>.db` (temp file plus
  rename). The answer gains `path` (the output's path, for
  `/debug/download`); `filename` is its name. Errors as before (400, 404,
  500 with `{"error"}`).

- **`GET /api/v1/debug/archives`** → archives of **every**
  `history/<cluster>/` folder; each entry gains `folder`
  (`history/<cluster>`) and `path`.
  **`GET /api/v1/debug/archives/{name}` is removed**: archives download
  through `/debug/download/{path}`.

- **`GET /api/v1/debug/trace`** — without `history`, it searches the serving
  worker's own live file and own unsealed files only. With **`history=1`**
  it searches **only** the sealed files of `history/<own cluster>/`, newest
  first, within the backend's `recorder.search.max_files` /
  `recorder.search.timeout` budget. Rows keep `worker_name`. A client that wants
  both calls both and merges the rows.
- **`GET /api/v1/debug/trace-by-label`** searches the serving worker's own
  live file only.

Absence (normative): pre-v1.23 backends answer `/debug/databases` with an
array. Clients MUST detect the array and show that the databases view is
not available on that worker, rather than rendering it with the new layout.

### Cache exchange over HTTP

Workers exchange `cluster` and `global` cache rows over HTTP instead of
reading each other's cache files. The cache file is now private to its
worker.

**`GET /api/v1/peer/cache/changes`** — public (no token), JSON.

| Parameter | Rule |
|---|---|
| `scopes` | `cluster`, `global` or `cluster,global`. Required. |
| `after_ms`, `after_key` | The cursor: both or neither. Absent = from the start. `after_ms` is an integer. |
| `limit` | Integer from 1 to 1000. Default 500. |

A repeated parameter: the last value wins. The checks run in the order of
the table, before the 404 check below, and the first failure answers
**400** `{"error": <message>}`:

| Failure | `error` |
|---|---|
| `scopes` missing, empty, unknown, or with an empty item | `scopes must be cluster, global or both` |
| only one of `after_ms`, `after_key` | `after_ms and after_key must be given together` |
| `after_ms` not an integer | `after_ms must be an integer` |
| `limit` not an integer, or outside 1..1000 | `limit must be an integer from 1 to 1000` |

**200** `{"rows": [PeerCacheRow], "more": bool}`. `PeerCacheRow` is
`{key, scope, value, size_bytes, created_at_ms, updated_at_ms,
expires_at_ms: int|null, origin_worker_id}` — `value` is the stored JSON
text, unparsed. Rule (normative): only rows whose `origin_worker_id` is the
serving worker's own name, whose `scope` is in `scopes`, and that are not
expired on the serving worker's clock, with `(updated_at_ms, key)` greater
than `(after_ms, after_key)`, ordered by `(updated_at_ms, key)`, at most
`limit` rows. `more` is true when more such rows exist. The `local` scope
is never served, and no worker relays another worker's rows.

**404** `{"error": "The cache exchange is off on this worker"}` when the
cache or `cache.exchange.enabled` is off, autodiscover is off or the cache engine has stopped.
**503** `{"error": "The cache did not answer in time"}` when the read does
not finish within 5 seconds or fails.

The worker card's `features.cache` tells peers whether a pull is worth
making: per scope, `{"ms": <updated_at_ms>, "key": <key>}` of the newest
row this worker originated, the key cut to its first 128 characters so the
card stays under its 4096-byte limit (a scope with no rows is absent). It is
absent when the cache or the exchange is off. A card with no `features`
object at all (the `static` registry provider) is pulled every cycle.

**`GET /api/v1/debug/download-live`** — see "Debug tools". The UI shows a
download button on the `live` row of each worker's own files.

**Cross-origin reads** — see "Conventions". The UI fans `trace`,
`trace-by-label` and `databases` out to every same-cluster worker that is
not offline, and shows the workers that did not answer.

Absence (normative): a pre-v1.23 worker answers the fan-out reads without
CORS headers, so the browser reports a network error for it; clients MUST
list such a worker as unreachable and keep the other workers' rows. A
worker without a `live` row in its own files (memory-only mode) gets no
download button for a file. Since v1.25 its `memory` row has its own
download button; see [v1.25 changes](#v125-changes-2026-11-01).

## v1.24 additions (2026-11-01)

### Cluster task hash on the workers list

A periodic task with `scope: cluster` runs on one worker of a cluster per
slot. Every worker in a cluster must declare the same cluster tasks, so each
worker publishes a hash of its cluster task definitions in its registry card
(`features.periodic.cluster_hash`: 16 lowercase hex characters). Two fields
on the rows of `GET /api/v1/workers` show the result of comparing it:

- **`cluster_tasks_hash: string | null`** — the worker's cluster task hash:
  16 lowercase hex characters. On the current worker's row it is the hash of
  its own definitions. On a peer's row it is the hash in the peer's card, or
  `null` when the card carries none in that form (no `features`, no
  `periodic` object, a value that is not 16 lowercase hex characters).
- **`cluster_tasks_match: boolean | null`** — whether the peer declares the
  same cluster tasks as the serving worker. `true` on the current worker's
  row. On a peer's row: `null` when either hash is unknown or the peer is in
  another cluster (cluster names compare as exact strings); otherwise `true`
  when the two hashes are equal and `false` when they differ. A peer that is
  offline still gets a verdict; the backend's mismatch warning and gauge
  count online peers only.

`false` means the two workers disagree about which cluster tasks exist or how
they are scheduled, so a slot may be run by a worker that does not know the
task. `null` means unknown and is not a warning.

Absence (normative): backends older than v1.24 omit both fields. Clients MUST
treat an absent field as unknown, exactly like `null`, and MUST render the
row as before. In this release the UI draws nothing from these fields; the
types carry them for a later view.

### Scope of a periodic task

Each group of `GET /api/v1/debug/periodic` gains an optional **`scope`**:
`"worker"` or `"cluster"`. It is `"cluster"` when the latest run recorded of
that task was a cluster-scope slot run, else `"worker"`. A backend older than
v1.24 omits it; clients MUST then treat the group as `"worker"`. The group
`system` flag is unchanged: the history archive pass is a system task with
scope `"cluster"`.

## v1.25 changes (2026-11-01)

The recorder keeps recent events in a memory store, with or without a
recorder file. Two shapes change; nothing else in `/api/v1` does.

### `GET /api/v1/debug/databases`: the memory row

`own[].kind` gains **`"memory"`** (the other values are `"live"` and
`"backlog"`). A worker with an open memory store answers one memory row,
first in `own`, before the `live` and `backlog` rows:

```json
{"filename": "w-1-memory", "worker_name": "w-1", "cluster_name": "search",
 "kind": "memory", "event_count": 40, "event_counts": {"task_started": 20},
 "first_event_ts": 1760432400.0, "last_event_ts": 1760432460.0,
 "size_bytes": 65536}
```

- `size_bytes` is the data in use, `(page_count - freelist_count) *
  page_size`. It is not the RAM that the store holds.
- `event_count` comes from the id range, `first_event_ts` and
  `last_event_ts` from the smallest and largest `ts`. `event_counts` is one
  count per event type. If the count does not finish within 2 seconds, the
  row answers `event_counts: {}`.
- `cluster_name` is the cluster stored with the memory events, else the
  worker's own cluster.
- The memory row is not a file. `filename` is a label only, and
  `GET /api/v1/debug/download/{path}` does not serve it. Use
  `download-live` with `source=memory`.
- A worker that keeps no memory store (`store_events: false`) has no memory
  row; its file rows are as before.
- `history.folders` is listed whenever a shared folder resolves, in every
  recorder mode.

### `GET /api/v1/debug/download-live`: the `source` parameter

New optional query parameter **`source`**: `memory` or `file`. When absent,
the default is `file` if a live recorder file is open, else `memory`.

| Case | Answer |
|---|---|
| `source=file`, no live file | 404 `{"error": "No live recorder file on this worker"}` |
| `source=memory`, no open memory store | 404 `{"error": "No memory store on this worker"}` |
| any other value | 400 `{"error": "source must be memory or file"}` |
| the copy failed | 500 `{"error": "Snapshot failed: <reason>"}` |

The memory snapshot is one consistent SQLite database with the recorder
tables. It is an attachment named
`<worker>-memory-<YYYY-MM-DD__HH_MM_SS>.db` (UTC time of the snapshot). The
`Content-Type` and `Cache-Control: no-store` are the same as for the file
snapshot. A copy that does not finish within 30 seconds fails with 500.

### Event row `id`

The `id` of an event row is unique and increasing within one worker process.
It continues across recorder file rotations and starts again at 1 after a
restart. (Before v1.25 each file started at 1, so a poll with `after_id`
could see nothing after a rotation until the new ids passed the old ones.)
The bundled UI polls with `after_id: 0`; the note serves other clients.

### Absence (normative)

- A backend older than v1.25 sends no memory row. Clients MUST then show
  none. A client sends `source=file` only from the `live` row; an older
  backend ignores the parameter and serves the live file, which is the right
  answer.
- A client older than v1.25 on a newer backend shows the memory row without
  a download button and with the title of a `backlog` row. This is wrong but
  harmless; its `live` button calls without `source` and gets the live file.

## v1.26 changes (2026-11-03)

The recorder can keep its history in Postgres. One meaning and one error
answer change, both for `GET /api/v1/debug/trace` with `history=1` on a
worker whose recorder keeps its history in Postgres. No shape changes.

- **Source.** With `history=1`, such a worker searches the rows of its own
  cluster in Postgres, not the sealed files. Without `history`, the search
  is unchanged (own live file and own unsealed files, or the memory store).
- **Row shape.** The same as before: the recorder event columns plus
  `worker_name`.
- **Complete answer.** The answer is never cut by a file budget.
- **Failure.** A Postgres search that fails or does not finish in time
  answers **503** with `{"detail": "history search failed"}`. This applies to
  `history=1` only; the search without `history` keeps its rule.

The bundled UI shows the hint "(search history to look in the cluster
history too)" and, when the history search fails, the note "(the history
search failed)".

### Absence (normative)

- A backend older than v1.26 searches sealed files only and never answers
  503 for this request.
- A client older than v1.26 on a newer backend shows the old hint and
  handles the 503 as a failed history search, which is right.

## v1.27 changes (2026-11-05)

A DLQ record is now the original source message with facts in `dk-`
headers, and the recorder has two new event types. No `/api/v1` shape
changes.

### DLQ records (informational)

A record on the dead-letter topic is the failed source message: its key and
value are the source key and value, byte for byte. `GET
/api/v1/debug/kafka/dlq/message` and `/messages` pass the record through as
before (`KafkaReadMessage`). The `headers` list holds the source message's
own headers first, in their order, minus every header whose name starts
with `dk-`. Then come the `dk-` headers, all UTF-8 text, in this order:

| Header | Value |
|---|---|
| `dk-record-version` | `1` |
| `dk-stage` | `parse`, `execute` or `sink` |
| `dk-error` | the error text with URL credentials redacted, then cut to 2000 bytes at a UTF-8 character boundary |
| `dk-sink` | `<sink_type>/<sink_name>` of the failed sink (`sink` stage only) |
| `dk-task-id` | the failed task's id (`execute` stage only) |
| `dk-attempts` | decimal: for a `sink` failure the hook-level attempts of that sink for this message (`0` for an open circuit); for an `execute` failure the task's attempts; absent for `parse` |
| `dk-delivered-sinks` | `<sink_type>/<sink_name>` of every sink that had delivered a result of this message before the record was written, sorted and joined with `,`; absent when none |
| `dk-source-topic` | the source topic (absent for an HTTP request) |
| `dk-source-partition` | decimal (absent for an HTTP request) |
| `dk-source-offset` | decimal (absent for an HTTP request) |
| `dk-source-timestamp` | the source message's timestamp in epoch ms; for an HTTP request the time it was received |
| `dk-request-id` | the request id (HTTP request only) |
| `dk-worker` | the worker name |
| `dk-instance` | the worker instance id |
| `dk-failed-at` | the canonical datetime of the failure (`YYYY-MM-DDTHH:MM:SS.ffffffZ`) |

A header with no value is not written; `0` is a value, and an empty
delivered-sinks list is no value. For an HTTP request the
value is the raw request body and the key is absent. The bundled UI shows
the `dk-` headers as a table above the value and the source headers below
it. Its probe prefill takes topic, partition, offset and timestamp from the
`dk-source-*` headers (each one, when present; else the record's own
partition, offset and `timestamp_ms`, and the configured source topic), and
it does not probe a record whose value or key comes as base64, because the
probe takes text. The probe sends the timestamp as the existing
`ProbeInput.timestamp`.

### Recorder events

Two new event types, both stored in `events` and sent on `/ws`:

- **`message_dlq`**: a source message is written to the DLQ; no later
  delivery of it starts. `partition`, `offset`; for an HTTP request
  `origin` is `"http"`, `request_id` is set, `partition` is `-1` and
  `offset` is null. `metadata`: `stage`, `sink`, `error`,
  `delivered_sinks`, `attempts`.
- **`sink_not_started`**: the delivery of a result to a sink does not
  start, because its message is on the DLQ or a `depends_on` dependency
  failed. `partition`; `metadata`: `sink`, `reason` (`message_dlq` or
  `dependency_failed`).

A `sink_error` row stands for one failed delivery attempt. Its `metadata`
is `sink_type`, `sink_name`, `error`, `attempt` (`0`: the sink's circuit was
open) and the new field **`action`**: `retry`, `skip` (also for a window
result), `dlq` (a record was written) or `failed` (the delivery wrote no
record). `attempt` is not new.

### Absence (normative)

- A backend older than v1.27 writes DLQ records without `dk-` headers.
  Clients MUST then treat every fact as absent and probe the record at its
  own coordinates. Such a backend never sends `message_dlq` or
  `sink_not_started`, and it writes no `action` in `sink_error` metadata.
- A client older than v1.27 on a newer backend shows the `dk-` headers as
  ordinary headers and probes the record at its DLQ coordinates. It renders
  the two new event types as uncategorised events (see the vocabulary
  section).

## v1.28 changes (2026-11-07)

The backends read one config layout, and a worker may run without its UI.
All additions are optional keys; the `throughput` frame and the `cost` and
`speed` keys are removed.

### Routes of a worker without a UI

`api.enabled` and `ui.enabled` decide which routes a worker serves.

| Route | Needs |
|---|---|
| `/healthz`, `/readyz`, `/api/v1/peer/cache/changes` | `api.enabled` |
| everything else: `/ws`, `/api/v1/*`, `/api-docs`, `/docs`, the pages | `api.enabled` and `ui.enabled` |

With `ui.enabled: false` the worker fetches no bundle, and every route of
the second row answers 404, except a WebSocket handshake on `/ws`, which
answers 403. `auth_token` guards the second row as before;
the three routes of the first row are public. A registry card carries the
worker's URL from `api.public_url`, else `http://<outbound ip>:<api.port>/`.

### `capabilities` on `GET /api/v1/identity`

`Identity` gains an optional `capabilities` object:

```json
{"recorder": {"enabled": true, "provider": "sqlite", "history_search": true},
 "memory": {"enabled": true, "window_seconds": 120, "max_rows": 12000},
 "autodiscover": {"enabled": false, "provider": null},
 "cache_exchange": false}
```

- `recorder.enabled`: the recorder runs. `recorder.provider`: the recorder
  persistence: `none`, `sqlite` or `postgres`. It is `none` when the recorder
  is off (`recorder.enabled` is false), and also when the recorder keeps its
  events in memory only. `recorder.history_search` is true when
  `recorder.enabled` is true.
- `memory`: the in-memory event store. `window_seconds` and `max_rows` are
  its limits.
- `autodiscover.enabled`: the worker registers itself and lists peers.
  `autodiscover.provider`: the registry provider, or null when off.
- `cache_exchange`: true when the cache and its exchange are on and
  autodiscover is on.

A backend older than v1.28 omits `capabilities`. The UI then treats every
capability as on. The UI with `capabilities`:

- hides the worker switcher and the cluster views when `autodiscover.enabled`
  is false;
- hides the history option of the Trace page when `recorder.history_search`
  is false;
- shows the memory window on the event views when `recorder.enabled` is false
  ("last 2 minutes, in memory");
- leaves workers with `ui_enabled: false` out of its fan-out and out of the
  links of the switcher.

### `ui_enabled` on `Worker` rows

Rows of `GET /api/v1/workers` gain optional `ui_enabled` (boolean or null),
taken from the card's `features.ui`, a boolean that the worker publishes in
its registry card. A missing key or null means on.

### Removal of `custom` sinks

`custom` is no longer a value of `PlannedSinkRecord.sink_type`, and
`CollectResult` has no `custom` array. There are no plugin sinks. A client
keeps `sink_type` a string and MUST tolerate `custom` from an older backend.

### Config reference entry types

`ConfigReferenceEntry.type` is a free string. Two values are added:
`duration` (a time span, for example `30s`) and `size` (a byte count, for
example `64MiB`). No schema change; a client that does not know a type shows
the raw value.

### Removal of throughput

- The `throughput` event and its `/ws` frame are gone. The event vocabulary
  has 31 names.
- The `cost` and `speed` keys are gone from `task_completed` metadata and
  from the rows of `GET /api/v1/recent-tasks`. `throughput.cost_label` and
  `throughput.min_cost` are gone from the backend config.
- The Prometheus metrics `drakkar_task_speed`, `drakkar_throughput` and
  `drakkar_task_rate` are not registered.
- New recorder files have no `throughput` column in `worker_state`. A reader
  MUST tolerate the column in files written by older backends and ignore it.
- A client MUST ignore a `throughput` frame, and the `cost` and `speed` keys,
  from an older backend.

### Absence (normative)

A backend older than v1.28 sends no `capabilities` and no `ui_enabled`; the
UI treats both as on.

## v1.29 changes (2026-11-08)

A task's run bar shows how long its subprocess ran, measured off the event
loop, so a busy worker loop no longer stretches the bar. All additions are
optional keys; no route changes.

### `duration` of `task_completed` and `task_failed`

`duration` is the process run time in seconds, from the spawn to the exit.
The backend reads the exit time when the kernel reports the exit, not when
its event loop handles it. Before v1.29 `duration` ended when the loop
handled the exit, so it included loop stalls. A task ends when its process
has exited and its output pipes have closed: when a descendant keeps the
pipes open after the process exited, the run ends when they close (read by
the loop). A timed-out task ends when the timeout fired (read by the loop).
A launch failure and a precomputed result keep their old meaning.

### New metadata keys of `task_completed` and `task_failed`

Stored in `events.metadata` and sent on `/ws`:

| Key | Type | Meaning |
|---|---|---|
| `run_started_at` | number | Unix seconds of the spawn, 6 decimals. Absent for a launch failure and a precomputed result. |
| `exit_notice_ms` | number | Milliseconds from the process exit to the moment the worker handled it, 1 decimal. A loop-stall signal. `0` means the worker handled the exit before the backend's exit watcher reported it, so the loop was not stalled; on a healthy worker this is the common value. Absent when the exit could not be timed off the loop, when a descendant of the process kept its output pipes open after the process exited (the run then ends when the pipes close), and for a timed-out task. |
| `reported_run_seconds` | number | The run time the handler's optional `task_run_seconds` hook reported for this task, 6 decimals. Present only when the hook gave a valid value (a finite number from 0 to `duration` plus 0.05). |
| `kind` | string | v1.31, `task_failed` only. The failure kind: `nonzero_exit`, `timeout`, `launch_failure` or `internal`. Absent in rows written before v1.31. |
| `source_offsets` | [int] | v1.31, `task_failed` only. The Kafka offsets of the source messages of the task, in the task's order. Absent for a task of the HTTP source and in rows written before v1.31. The row's `offset` column stays unset. |

`task_started` does not change: its `ts` is the spawn time within
microseconds, and it stays the key of a retry's archived row
(`<task_id>:r<start_ts>`).

### New keys of `GET /api/v1/recent-tasks` rows

`RecentTaskEntry` gains optional `run_started_at` (number or null) and
`reported_run_seconds` (number or null), copied from the completion event's
metadata. `start_ts` and `end_ts` keep their meaning (the `ts` of
`task_started` and of the completion event).

### The bar (normative for the UI)

- A finished task with `run_started_at` and `reported_run_seconds` draws
  `[run_started_at, run_started_at + reported_run_seconds]`.
- Else a finished task with `run_started_at` and `duration` draws
  `[run_started_at, run_started_at + duration]`.
- Else (a running task, a launch failure, an older backend) the bar is
  `[start_ts, end_ts]`, with `end_ts` = now while running.

Lanes, sorting, the retry archive key and the age cut keep using
`start_ts` and `end_ts`. The hover shows `exit_notice_ms` when it is above
50 ms, and both run times when `reported_run_seconds` is present.

### Absence (normative)

A backend older than v1.29 sends none of the three metadata keys and none of
the two row keys. The UI then draws the bar from `start_ts` and `end_ts`, as
before.

## v1.30 changes (2026-11-08)

The Databases view of the UI shows where a worker keeps its data and lets
an operator download it. v1.30 lands in parts: each part adds its
subsections here together with the routes that serve it. Every addition is
optional, and a client MUST degrade when a key or a route is missing.

The first part changes three existing routes. The second part adds
`GET /api/v1/debug/slice`. The third part adds
`GET /api/v1/debug/databases/postgres`, `DELETE /api/v1/debug/files/{path}`,
`GET /api/v1/debug/autodiscover` and `GET /api/v1/debug/autodiscover/leases`,
and the `delete_enabled` key of the `history` part.

### `GET /api/v1/debug/databases`: the `parts` parameter

New optional query parameter **`parts`**: a comma list of `own`, `history`,
`storage` and `recorder`. When absent, all four are answered. A part that
is not asked for is absent from the answer, and the backend does not do
its work: a peer asked for `own,storage,recorder` does not list the shared
history folder.

| Case | Answer |
|---|---|
| every item is a known part (repeats are allowed) | 200, the parts asked for |
| an item is not a known part; an empty item (`parts=`, `parts=own,`) counts as one | 400 `{"error": "unknown part '<p>'; known: history, own, recorder, storage"}`, for the first such item |

`own` and `history` keep their shapes. The key `worker` is always present.

### `GET /api/v1/debug/databases`: the `worker` block

```
"worker": {"name": str, "cluster": str|null, "instance": str}
```

`cluster` is `null` when the worker has no cluster name. `instance` names
this process; it is the instance of the worker's registry card and of its
sealed files' meta files.

### `GET /api/v1/debug/databases`: the `recorder` block (part `recorder`)

What the recorder of the worker runs, read from its config and from memory.
No database or file is read for it.

```
"recorder": {
  "enabled": bool,                              // recorder.enabled
  "provider": "none"|"sqlite"|"postgres",       // the effective provider
  "memory": {"window_seconds": int, "max_rows": int, "max_bytes": int} | null,
  "sqlite": {
    "rotation_interval_seconds": int,
    "archive": {"enabled": bool, "scope": "cluster"|"worker"|null,
                "next_slot_ts": float|null, "window_seconds": int,
                "due_after_seconds": int, "retention_days": int,
                "merged_retention_days": int}
  } | null,
  "postgres": PostgresStatus | null
}
```

- `provider` is `none` when the recorder is off, else `recorder.provider`.
- `memory` holds the bounds of the memory store (the time window, the row
  cap and the data budget); `null` when the worker keeps no memory store.
- `sqlite` is present only with provider `sqlite`, else `null`.
  `archive.scope` is what the archive pass covers: `cluster` (one worker
  of the cluster archives the shared history, chosen per slot), `worker`
  (each worker archives its own files) or `null` (no archive pass runs).
  `next_slot_ts` is the epoch second of the next archive slot, `null` when
  no pass runs. `retention_days` 0 keeps archives for ever;
  `merged_retention_days` 0 keeps merge results for ever.
- `postgres` is present only with provider `postgres`, else `null`:

```
PostgresStatus = {
  "connection": str,            // the entry name under connections.postgres
  "schema": str,
  "table": str,                 // the table name without the schema
  "initial_retention_hours": int,
  "max_size_bytes": int,        // 0 = no limit
  "store_completed_output": bool,
  "writer": {
    "started": bool,
    "queue_rows": int,
    "queue_bytes": int,
    "rows_written": int,
    "dropped": {"queue_full": int, "rejected": int, "no_partition": int, "shutdown": int},
    "breaker_open": bool,
    "last_upkeep": {"at": str, "held_lock": bool, "created": [str],
                    "dropped": [str], "dropped_for_size": [str]} | null
  } | null
}
```

- The DSN is never part of the answer. The connection name and the schema
  are not secrets.
- `writer` is this worker's writer to the table; `null` when the worker
  writes no rows (`recorder.capture.events: false`) or before the recorder
  started. `started` is false until the writer has opened its connection
  and found the table. `queue_rows` and `queue_bytes` count the rows and
  the text waiting, the chunk in flight included; the text is counted as
  `recorder.postgres.max_queue` counts it. `rows_written` and
  `dropped` count rows since the process started; the reasons are those
  of the metric `drakkar_recorder_postgres_dropped_rows_total`.
- `last_upkeep` is the last partition upkeep this worker ran: `at` (RFC
  3339 micro), `held_lock` (false when another writer of the table held
  the upkeep lock; the three lists are then empty), the partitions it
  created, dropped by the stored retention, and dropped for
  `max_size`. `null` before the first upkeep. A failed upkeep leaves the
  previous value.

### `GET /api/v1/debug/databases`: the `storage` block (part `storage`)

The worker's own folder `<storage.dir>/<sanitized cluster>/<worker>/` and
the folders of the other workers of its cluster on the same host.

```
"storage": {
  "dir_set": bool,
  "own_folder": str,
  "shared_dir_set": bool,
  "shared_is_storage_dir": bool,
  "files": [{"name": str, "kind": "cache"|"watchdog"|"owner_lock",
             "size_bytes": int, "modified_at": str, "entries": int|null}],
  "temp_files": {"count": int, "size_bytes": int},
  "siblings": [{"worker": str, "files": int, "size_bytes": int,
                "newest_modified_at": str|null, "in_use": bool|null,
                "online": bool|null}] | null
}
```

- `dir_set` is true when `storage.dir` is set. `own_folder` is
  `<sanitized cluster>/<worker>`, relative to `storage.dir`; `""` when
  `storage.dir` is empty. No absolute path is sent.
- `shared_dir_set` is true when `storage.shared_dir` is set.
  `shared_is_storage_dir` is true when the shared folder is `storage.dir`
  (`storage.shared_dir` is empty or names the same folder).
- `files` lists the files of the own folder that are not recorder files
  (those are in `own`), sorted by name: the cache file (`cache`; its size
  includes its `-wal` and `-shm` files, and `modified_at` is the newest of
  them), the crash marker (`watchdog`) and the owner lock file
  (`owner_lock`). `modified_at` is RFC 3339 micro. `entries` is the
  number of cache rows; `null` for the other kinds, and when the count did
  not finish within 1 second or failed. Empty when there is no own folder.
- `temp_files` counts the download temp files in the own folder (copies
  made for a snapshot download, and their sidecars): the files of a
  download in progress, and files a crashed process left (the worker
  deletes those at its next start).
- `siblings` lists the other worker folders of
  `<storage.dir>/<sanitized cluster>/`, sorted by worker. `files`,
  `size_bytes` and `newest_modified_at` cover the regular files in the
  folder except the owner lock file (`newest_modified_at` is `null` with
  no such file). `in_use` is true when a process holds the folder's owner
  lock, false when it is free, and `null` when the folder has no lock
  file or the test failed. The test takes a shared lock and frees it at
  once; an orphan pass that runs at that moment skips the folder for one
  round. `online` is the registry's verdict for the worker name: `null`
  with autodiscover off or when the registry cannot tell. `siblings` is
  `null` when `storage.dir` is empty or the cluster folder cannot be
  listed.

### Compressed downloads

`GET /api/v1/debug/download/{path}` and `GET /api/v1/debug/download-live`
take the new optional query parameter **`compress`**, whose one value is
`gzip`. With it the answer is the same bytes as a gzip stream: the
attachment name gains `.gz`, `Content-Type` is `application/gzip`, there
is no `Content-Length`, and `Cache-Control` stays `no-store, private`.

| Case | Answer |
|---|---|
| `compress` with any other value (an empty one too) | 400 `{"error": "compress must be gzip"}`, before any other check |
| `compress=gzip` on an archive path (`history/<cluster>/<archive>.db.gz`) | 400 `{"error": "the file is already compressed"}`, before the file is looked up |

The other answers of both routes do not change.

### `GET /api/v1/debug/download-live`: `source=cache`

`source` gains the value **`cache`**: a consistent copy of the worker's
cache file (`VACUUM INTO` on a read-only connection; the cache keeps
writing during the copy), as an attachment named
`<worker>-cache-<YYYY-MM-DD__HH_MM_SS>.db` (UTC time of the copy).
`Content-Type` and `Cache-Control` are those of the other sources. A copy
that does not finish within 30 seconds is stopped and its partial file
deleted; a cache too large to copy in that time cannot be downloaded this
way.

| Case | Answer |
|---|---|
| the worker has no cache file (the cache is off, `storage.dir` is empty, or the file does not exist yet) | 404 `{"error": "No cache on this worker"}` |
| any value but `memory`, `file` or `cache` | 400 `{"error": "source must be memory, file or cache"}` (was `source must be memory or file`) |
| the copy did not finish within 30 seconds | 500 `{"error": "Snapshot failed: the cache copy did not finish in 30 s"}` |
| the copy failed | 500 `{"error": "Snapshot failed: <reason>"}` |

One cache copy runs at a time on a worker, apart from the one memory copy
(v1.25), so a cache copy never makes a memory download wait. A second
cache request waits up to 30 seconds for the running cache copy, then
answers 500 `{"error": "Snapshot failed: another cache snapshot is still
running"}`.

### `GET /api/v1/debug/download-live`: limits of every source

Each snapshot is an unlinked temp file in the worker's own folder (or a
buffer in RAM) until its download ends, so the open debug UI must not be
able to fill the disk with them. Since v1.30, for every `source`:

- One live-file copy runs at a time, in a slot of its own (as the memory
  and cache copies do). A second `source=file` request waits up to 30
  seconds, then answers 500 `{"error": "Snapshot failed: another file
  snapshot is still running"}`.
- The snapshots being copied or still being sent are bounded per worker; a
  request counts from the moment it passes this check, so concurrent
  requests cannot pass it on the same room. After the 400 checks and before
  any 404, a request answers:

| Case | Answer |
|---|---|
| snapshots still being sent hold 2 GiB on this worker | 429 `{"error": "snapshots still being sent hold 2 GiB on this worker; wait for one to end"}`, `Retry-After: 5` |
| snapshots still being sent number 16 on this worker, after the check above | 429 `{"error": "16 snapshots are still being sent on this worker; wait for one to end"}`, `Retry-After: 5` |

- A download whose client takes no chunk for 120 s is ended, and its
  snapshot leaves the count.

### `GET /api/v1/debug/slice` (new)

Builds a SQLite file with the recorder events of one time range, filtered,
on the serving worker, and streams it as an attachment. The worker builds
the file into a private temp file (or in RAM when `storage.dir` is empty),
unlinks it and streams it, so no file is held between requests. The UI
opens the route as a plain link (a navigation, also to a peer's origin), so
the route takes only query parameters and answers no CORS. The token may
ride as `?token=`.

Parameters (all text in the query; any other parameter, `token` too, is
ignored):

| Parameter | Rule | Default |
|---|---|---|
| `from`, `to` | epoch seconds, a decimal number (ASCII digits, an optional fraction and exponent) from 0 to 253402300799 (the last second of the year 9999); `to > from`; `to - from <= 604800` (168 h) | required |
| `scope` | `worker` or `cluster` | `worker` |
| `sources` | comma list; each must be a source of the scope on this worker (below) | every source of the scope |
| `partition` | whole number 0 to 2147483647 | none |
| `offset_from`, `offset_to` | whole numbers in the signed 64-bit range; need `partition`; `offset_from <= offset_to` | none |
| `task_id` | 1 to 256 characters | none |
| `events` | comma list of at most 40 recorder event types | all |
| `label_key`, `label_value` | both or neither; the key 1 to 128 characters without `"` or `\`, the value 1 to 1024 characters | none |
| `output` | `0` writes `stdout` and `stderr` as NULL; `1` keeps them | `1` |
| `max_rows` | whole number 1 to 1000000 | 200000 |
| `compress` | `gzip` | none |

Sources of a scope:

| Recorder provider | `scope=worker` | `scope=cluster` |
|---|---|---|
| `sqlite` | `memory` (when a memory store is open), `files` (the live and backlog files), `history` (own sealed files; when a shared folder resolves) | `history`: every sealed file of the own cluster folder |
| `postgres` | `memory` (when open), `postgres` (the table rows of this worker) | `postgres`: the table rows of the own cluster, every worker |
| recorder off | `memory` (when open) | none |

The checks run in this order; the first rule broken answers 400
`{"error": "<message>"}`:

1. `from and to must be finite numbers of epoch seconds` (also for a bound outside 0 to 253402300799)
2. `to must be greater than from`
3. `the time range is at most 168h`
4. `scope must be worker or cluster`
5. `source '<s>' is not available on this worker; available: <sorted list joined with ", ", or none>`
6. `partition must be a whole number from 0 to 2147483647`
7. `offset_from and offset_to need partition`
8. `offset_from and offset_to must be whole numbers from -9223372036854775808 to 9223372036854775807`
9. `offset_from must not be greater than offset_to`
10. `task_id must be 1 to 256 characters`
11. `events must name at most 40 event types`
12. `event '<e>' is not a recorder event type`
13. `give label_key and label_value together`
14. `label_key must be 1 to 128 characters without " or \`
15. `label_value must be 1 to 1024 characters`
16. `output must be 0 or 1`
17. `max_rows must be a whole number from 1 to 1000000`
18. `compress must be gzip`

A `scope=cluster` request on a worker with no cluster source skips check 5.
A request with no parameters therefore always answers 400 (check 1), on
every worker and while a build runs: the UI uses that to tell the route
exists (404 means it does not).

| Status | When | Body |
|---|---|---|
| 200 | the file is built (it may hold 0 rows) | the file |
| 400 | a rule above fails | `{"error": "<message>"}` |
| 409 | `scope=cluster` on a worker with no cluster source (recorder off), after every 400 check | `{"error": "scope cluster needs the shared history or the Postgres table"}` |
| 429 | another slice is building on this worker (one build at a time), after the 409 check | `{"error": "a slice is already being built on this worker"}`, `Retry-After: 5` |
| 429 | finished slices that are still being sent hold 2 GiB on this worker, after the check above | `{"error": "slices still being sent hold 2 GiB on this worker; wait for one to end"}`, `Retry-After: 5` |
| 429 | slices being built or still being sent number 16 on this worker (a request counts from the moment it passes this check), after the check above | `{"error": "16 slices are still being sent on this worker; wait for one to end"}`, `Retry-After: 5` |
| 503 | the Postgres read failed or found no free read slot | `{"error": "postgres read failed"}` |
| 500 | the slice file could not be written | `{"error": "Slice failed: <reason>"}` |

Headers of a 200: `Content-Type: application/x-sqlite3` (or
`application/gzip` with `compress=gzip`), `Content-Disposition: attachment;
filename="<name>"`, `Content-Length` (absent with `compress`),
`Cache-Control: no-store, private`, `X-Drakkar-Slice-Rows` (the event rows
in the file), and `X-Drakkar-Slice-Truncated` (`rows`, `bytes`, `time` or
`files`; absent when the file is complete).

File name: `<worker>-slice-<from>__<to>.db` for `scope=worker`,
`<cluster>-cluster-slice-<from>__<to>.db` for `scope=cluster` (the
sanitized cluster, `default` when it has none); `-partial` before `.db`
when a limit cut the file; `.gz` after it with `compress=gzip`. `<from>`
and `<to>` are UTC, `%Y-%m-%d_%H-%M-%S`, the fraction of a second dropped.

Limits. A limit never answers an error: the worker finishes the file with
the rows it has and marks it (header, file name, `slice.truncated`).

| Limit | Value | Mark |
|---|---|---|
| rows in the file | `max_rows` (at most 1000000) | `rows` |
| the file on disk | 1 GiB, checked after each batch | `bytes` |
| the file in RAM (no `storage.dir`) | 64 MiB, checked after each batch | `bytes` |
| the whole build | 60 s | `time` |
| sealed files read | `recorder.search.max_files` (newest first); later files are skipped and the build goes on | `files` |

A batch ends at 5000 rows or 8 MiB of text, whichever comes first, so a
file ends at most one batch past its size limit. A download whose client
takes no chunk for 120 s is ended; the file of a finished slice stays
pinned (an unlinked temp file or a buffer in RAM) only while its download
runs.

A Postgres read that the 60 s limit (or the server's statement timeout,
which is set to the time left) cuts keeps the rows it read and marks the
file `time`; only an error of the read or no free read slot answers 503.
The Postgres reads of the UI (the history search and the slice) share 2
slots per worker process.

Rows and ids. Each source row is written once:

- `sqlite`, `scope=worker` with `files`: the worker asks the recorder for
  one flush first (at most 5 s; the note `flush_timed_out` or
  `flush_failed` says when it did not end), then reads the files only:
  after the flush every memory row is also in the live file, so `memory`
  adds nothing. `memory` without `files` reads the memory store first
  (after a flush of the recorder into it), and own sealed files then leave
  out each row the store gave (the same process and id; without a meta
  file, the same id and time).
- `postgres`: the worker runs its Postgres write stage once (at most 3 s),
  reads the memory store, then the table rows of this worker without the
  rows of this process newer than the store's read, and leaves out each
  table row the store gave (the same process and id). A row the store
  evicts during the build is then still written once. One gap is left: a
  row that left the store while it still waited for the write stage after
  that run is in neither source; the note `postgres_queue_waiting` then
  says rows of this worker were still waiting.
- Recorder off: the memory store.

Ids are renumbered from 1 in the order the rows are written: the memory
store first, then the files oldest first, then the table. Rows of one worker from two process lifetimes can carry the same
id, so the source ids are not kept.

The file. `scope=worker` has the tables of a recorder file (`events`,
`worker_config`, `worker_state`); `worker_config` comes from the newest
file read, else from the memory store. `scope=cluster` has the tables of a
merge result (`workers`, `events` with `worker_id`, `worker_states`); a
cluster file built from the table has one `workers` row per worker, with
`source_file` `postgres`. Both add two tables that describe the slice:

```sql
CREATE TABLE slice (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    schema      INTEGER NOT NULL,   -- 1
    created_at  TEXT    NOT NULL,   -- RFC 3339 with microseconds, UTC
    scope       TEXT    NOT NULL,   -- worker | cluster
    worker      TEXT,               -- the building worker
    cluster     TEXT,
    from_ts     REAL    NOT NULL,
    to_ts       REAL    NOT NULL,
    filters     TEXT    NOT NULL,   -- sorted compact JSON of the filters
    rows        INTEGER NOT NULL,
    truncated   TEXT,               -- rows | bytes | time | files | NULL
    notes       TEXT    NOT NULL    -- JSON list: flush_timed_out, flush_failed, source_unreadable, postgres_queue_waiting
);
CREATE TABLE slice_sources (
    kind    TEXT    NOT NULL,       -- memory | live | backlog | sealed | postgres
    name    TEXT,                   -- file base name; NULL for memory and postgres
    worker  TEXT,
    rows    INTEGER NOT NULL
);
```

`filters` always holds `max_rows`, `output` and `sources` (the sorted
sources read), and every other filter only when given (`events` sorted
without repeats). The DDL, the messages, the file names and the filters
JSON are pinned in `tests/fixtures/slice_contract.json` of the Python
backend.

The whole cluster. No worker calls another worker. With `sqlite` the
cluster file holds the sealed history of the cluster folder; the parts not
sealed yet are one link per worker (`scope=worker&sources=files` on that
worker's origin), which the UI lists before the cluster file. With
`postgres` the cluster file is the table rows of the cluster; the newest
seconds may be missing. With the recorder off there is no cluster file
(409); the UI offers one memory link per worker.

### `GET /api/v1/debug/databases`: `delete_enabled` in the `history` part

The `history` object gains **`delete_enabled`** (boolean): the value of
`ui.delete_enabled`. The UI offers the delete of a merge result only when it
is `true`, so it never sends a `DELETE` that the worker refuses. A backend
that predates the third part sends no key: the UI then offers no delete.

### `GET /api/v1/debug/databases/postgres` (new)

The hour partitions of the recorder's Postgres table and what the next
upkeep drops. Only on a worker whose effective recorder provider is
`postgres`; the table is the one of the `recorder.postgres` block of
`/debug/databases`. No query parameter. Not a CORS path: the UI reads it on
its own worker only.

The worker opens one connection of its own (never the write pool), takes one
of the read slots that the history search and the slice download share (2 per
worker process; a third read does not wait), and runs four existing
statements in one transaction after `statement_timeout` (the time of
`recorder.search.timeout` in whole milliseconds, at most 3600 s) and
`jit off`: `server_now`, `retention_read`, `partitions_list` and
`partition_sizes`. No other SQL is sent. The answer never names the DSN.

```json
{
  "server_now": 1762596000.25,
  "stored_retention_hours": 6,
  "partitions": [
    {"name": "recorder_events_p2026110804", "from_ts": 1762574400, "to_ts": 1762578000, "size_bytes": 8192}
  ],
  "total_bytes": 8192,
  "next_drops": {"retention": [], "size": []}
}
```

- `server_now`: the database server's clock, epoch seconds. The upkeep
  judges every hour by this clock.
- `stored_retention_hours`: the retention stored in the table comment
  (`retention_hours=<n>`, 1 to 168), or `null` when the comment holds none.
  The upkeep drops by this value only, never by this worker's
  `recorder.postgres.initial_retention`.
- `partitions`: every partition of the table whose name is `<table>_p` plus a
  UTC hour, ascending; `from_ts` and `to_ts` are the hour bounds in epoch
  seconds; `size_bytes` is `pg_total_relation_size`, or `null` when the
  partition went away during the read. A child table of another name is left
  out.
- `total_bytes`: the sum of the known sizes.
- `next_drops.retention`: the partitions whose hour ended
  `stored_retention_hours` before `server_now` or earlier (none without a
  stored retention). `next_drops.size`: the oldest partitions the size cap
  drops after those, while the rest is above this worker's
  `recorder.postgres.max_size` (none when it is 0). Both use the same rules
  as the upkeep, so they show what the next upkeep would drop at
  `server_now`.

Answers: 200 as above; 404 `{"error": "the recorder provider is not postgres"}`;
503 `{"error": "postgres read failed"}` when the read failed, ran out of
time or found no free slot. A 503 logs `ui_read_postgres_failed` (warning,
`endpoint`, `reason` `error`, `timeout` or `busy`, `error`), at most one line
per 60 s for this endpoint.

### `DELETE /api/v1/debug/files/{path}` (new)

Deletes one merge result. It is the only delete of the UI: sealed files,
archives, the own folder, other worker folders, task locks and Postgres
partitions are never deleted from the UI.

- `path` is relative to the shared folder and must be `merged/<name>.db`,
  with the same checks as `GET /api/v1/debug/download/{path}` (safe
  segments, no link, the resolved file inside the folder).
- **403** `{"error": "The delete endpoint is disabled by configuration (set
  ui.delete_enabled=true to enable it)"}` while `ui.delete_enabled` is false
  (the default). Checked first, before the path.
- **404** `{"error": "File not found"}` for a path of another shape (a
  sealed file or an archive included), an unsafe segment, a link, or a file
  that does not exist.
- **409** `{"error": "the file is in use on this worker"}` while this
  worker sends the file to a client (`/debug/download/{path}`) or reads it
  as the source of a merge. Another worker that reads the file is not
  known; on a local folder its read goes on (the file is removed when the
  last reader closes it).
- **204** with no body after the file is deleted. The worker logs
  `debug_file_deleted` (info, `category` `debug`, `path`).

Not a CORS path. A worker with no shared folder answers 404.

### `GET /api/v1/debug/autodiscover` (new)

The registry as this worker sees it, from the snapshot of its last refresh.
No store is read. No query parameter.

```json
{
  "registry": {
    "provider": "postgres",
    "connection": "main",
    "started": true,
    "refreshed_at": "2026-11-08T10:00:00.125000Z",
    "last_publish_at": "2026-11-08T10:00:02.500000Z",
    "breaker_open": false,
    "offline_after_seconds": 60
  },
  "worker": {"name": "w-1", "cluster": "search", "instance": "0123456789abcdef", "key": "drakkar.fleet_workers (worker = 'w-1')"},
  "workers": [
    {
      "worker": "w-2", "instance": "fedcba9876543210", "cluster": "search", "state": "running",
      "backend": "python", "version": "2.5.0", "url": "http://10.0.0.2:8080/",
      "started_at": "2026-11-08T09:00:00.000000Z", "heartbeat_at": "2026-11-08T09:59:58.000000Z",
      "age_seconds": 2.1, "online": true, "key": "drakkar.fleet_workers (worker = 'w-2')",
      "features": {}
    }
  ],
  "truncated": false
}
```

- `registry.connection`: the name of the connection entry, `null` for the
  `filesystem` provider. No DSN, URL or token is sent.
- `registry.refreshed_at` and `last_publish_at`: the last successful refresh
  and the last successful publish of this worker's own card, `null` before
  the first. `started`: a provider start succeeded. `breaker_open`: the
  registry's breaker.
- `worker`: this worker. Its own card is not in `workers` (the registry
  leaves it out of its snapshot); `key` is where the store keeps it.
- `workers`: one row per card of the last refresh, the own cluster first,
  then by cluster and worker name; at most 1000 rows, and `truncated` is
  `true` when more were listed. `age_seconds` and `online` follow the
  liveness rule of `/api/v1/workers`. The card fields are sent as the card
  holds them (`features` as an object, `{}` when absent).
- `key` (here and in `worker`): where the store keeps the card, `null`
  before the provider started. `filesystem`: the card file relative to the
  shared folder (`fleet/workers/<worker>.json`); `postgres`:
  `<schema>.fleet_workers (worker = '<worker>')`; `redis`:
  `<prefix>fleet:workers:<worker>`; `consul`:
  `<prefix>/fleet/workers/<worker>`.

Answers: 200; 404 `{"error": "autodiscover is off"}`.

### `GET /api/v1/debug/autodiscover/leases` (new)

The cluster tasks of this worker and who holds the lease of each, as the
election's store reports it. No query parameter.

```json
{
  "election": {"provider": "redis", "started": true, "breaker_open": false},
  "leases": [
    {
      "task": "history.archive", "scope": "search/history.archive", "system": true,
      "lease_seconds": 60, "next_slot_ts": 1762599600,
      "last_slot": {"slot": 1762596000, "outcome": "won", "at": "2026-11-08T10:00:00.004000Z"},
      "status": "held",
      "holder": {"worker": "w-2", "instance": "fedcba9876543210", "acquired_at": "2026-11-08T10:00:00.010000Z",
                 "age_seconds": null, "age_approximate": false, "expires_in_seconds": 41.5},
      "key": "drakkar:task-locks:search/history.archive"
    }
  ]
}
```

- `election` is `null` when the worker runs no cluster task (it then has no
  election), and `leases` is empty. `started`: the provider has started. It
  starts at the first slot that needs it; this read never starts it.
- One row per cluster task of the worker, sorted by name: the user tasks and
  `history.archive` when the worker runs it as a cluster task. `system` is
  true for a framework task. `next_slot_ts` is the next slot (epoch
  seconds). `last_slot` is the last slot of the task on this worker, `null`
  before the first: its slot, its outcome (`won`, `held_elsewhere`, `late`,
  `election_failed`) and when it was decided.
- `status`: `held` (`holder` is set), `free` (no lease is stored),
  `not_started` (the election has not started: no store call), `breaker_open`
  (the election's breaker is open: no store call), `busy` (another request's
  reads run on this worker now: no store call; try again), or `failed` (the
  read failed or did not answer in time, or the UI reads' own breaker is open
  after earlier failed reads).
- `holder`: `worker`, `instance` and `acquired_at` (text, as the store keeps
  it; `null` when the stored lease names no holder); `age_seconds`: the time
  since the last refresh on the store's clock, when the store keeps it
  (`filesystem`, `postgres`); `age_approximate`: `true` when the age compares
  the store's file time with the worker's own clock (`filesystem`, whose read
  writes nothing to the store and so cannot sample the file server's clock);
  `expires_in_seconds`: the time left before the
  lease ends, from the store (`redis`), or the lease length minus the age
  (`filesystem`, `postgres`). A negative value means the lease ran out and the
  store keeps it until another worker takes the scope. `consul` reports
  neither. `holder` is `null` unless `status` is `held`.
- `key`: where the store keeps the lease, `null` before the provider started.
  `filesystem`: the lock file relative to the shared folder
  (`tasks/<cluster>/<task>.lock`); `postgres`:
  `<schema>.task_locks (scope = '<scope>')`; `redis`:
  `<prefix>task-locks:<scope>`; `consul`: `<prefix>/task-locks/<scope>`.

Each read is one call of the election's provider with the operation
`holder` (one attempt, at most 2 s), on the worker's main loop, through a
caller of the UI's own with a breaker of its own: the provider metrics count
it as `drakkar_provider_calls_total{feature="ui",op="holder"}`, and a failed
or slow read never counts against the election's breaker, so it never makes a
slot call wait or skip. One batch of reads runs per worker at a time (a
second request answers every row `busy`); inside a batch at most 2 reads run
at once, and one with `postgres`, whose read borrows a pooled connection. The
`filesystem` read writes nothing to the store and runs on a thread apart from
the slot calls. A failed row logs
`ui_read_provider_failed` (warning, `category` `debug`, `endpoint`,
`provider`, `op`, `error`), at most one line per 60 s for this endpoint. The
whole read ends after 5 s; rows that did not answer are `failed`. The
Postgres provider reads with the statement `holder` and the Redis provider
with `GET` and `PTTL` (pinned in `tests/fixtures/fleet_providers.json` of the
Python backend).

Answers: 200.

### Absence (normative)

- A backend older than v1.30 ignores `parts` and answers every part; it
  sends no `worker`, `recorder` or `storage` key.
- A v1.30 backend answers 400 for a part it does not know. A client that
  sends a part added after v1.30 reads once more without `parts` when it
  gets 400, so a newer client still reads an older worker. The UI then hides the
  panels those keys feed (the mode strip, the own folder rows, the other
  folders of the host) and keeps the rest of the view.
- An older backend ignores `compress` and sends the plain file under its
  plain name. The UI offers the compressed download only on a worker that
  sends the `recorder` block.
- An older backend refuses `source=cache` with 400. The UI offers the cache
  download only from a `cache` row of `storage.files`.
- A backend older than the second part answers 404 on `/debug/slice`. The
  UI probes its own worker with a request that has no parameters (400
  means the route exists) and counts a peer without the `recorder` block as
  one without the route.
- A backend older than the third part answers 404 on
  `/debug/databases/postgres`, `/debug/autodiscover` and
  `/debug/autodiscover/leases`, and 404 or 405 on `DELETE /debug/files`. It
  sends no `history.delete_enabled`. The UI hides the Postgres partitions
  and the Autodiscover blocks it cannot read, says "not available on this
  worker", and offers no delete.

## v1.31 changes (2026-11-09)

The agent insight routes explain a running worker to an AI agent: the
concepts of the framework, the meaning of config keys, metrics and events,
recipes for common questions, the live state and rule-based findings. They
are read-only. The UI does not call them. A client MUST degrade when a
route is missing: a backend older than v1.31 answers 404 on all six.

### Switch, token and common rules

All six routes are `GET` under `/api/v1/agent`. They are served by the API
server and need `api.enabled` only: they exist with `ui.enabled: false`,
like `/healthz`.

Every route checks, in this order:

| Step | Case | Answer |
|---|---|---|
| 1 | `agent.enabled` is false (the default) | 404 `{"error": "the agent surface is off; set agent.enabled to true"}` |
| 2 | `agent.auth_token` is not empty and the request has no `Authorization: Bearer <token>` header, or the token is wrong (compared in constant time) | 401 `{"error": "agent token required"}` |
| 3 | a parameter is not understood | 400 `{"error": "<message>"}`, the messages below. The checks run in this order and the first failure answers: `parts`, `detail`, `format`, `topic`, then `names` and `prefix`. |

The agent token is its own: `ui.auth_token` and `?token=` do not apply to
these routes. Every answer carries `Cache-Control: no-store`. Answers are
`application/json`; the Markdown form of the manual is
`text/markdown; charset=utf-8` and also carries `no-store`. Errors use the
legacy `{"error": "..."}` envelope. A query parameter that a route does not
list is ignored, on every route.

Parameters, by route:

| Parameter | Routes | Rule |
|---|---|---|
| `parts` | manual, config, state | a comma list of the parts the route names; absent: all parts. An unknown or empty item (`parts=`, `parts=a,`) answers 400 `{"error": "unknown part '<p>'; known: <sorted parts joined with ", ">"}`, for the first such item. Repeats are allowed. |
| `detail` | manual, config, metrics, state, diagnose | `brief` (default) or `full`; another value answers 400 `{"error": "detail must be brief or full"}`. Effect: manual, `brief` gives `key` and `summary`, `full` every field; config, `advice` only in `full`; metrics, `promql` and `related` only in `full`; state and diagnose, none (the value is still validated). |
| `format`, `topic` | manual | see the manual |
| `names`, `prefix` | metrics | see the metrics route |

The index takes no parameters.

### `GET /api/v1/agent`: the index

```
{
  "schema": 1,
  "framework": {"backend": "python"|"go", "version": str,
                "registry_version": str},       // 16 hex characters
  "worker": {"name": str, "cluster": str|null, "instance": str},
  "capabilities": Capabilities,                 // as /api/v1/identity (v1.28)
  "include_payloads": bool,                     // agent.include_payloads
  "app_notes": bool,                            // the handler gave notes
  "routes": [ {"path": str, "parts": [str], "approx_tokens": {part: int},
               "use": str} ],
  "start_here": str
}
```

- `registry_version` is the first 16 hex characters of the SHA-256 of the
  canonical bytes of the knowledge registry. A cache of manual answers is
  valid while it is unchanged.
- `cluster` is `null` when the worker has no cluster name.
- `routes` has one row for each of `/api/v1/agent/manual`,
  `/api/v1/agent/config`, `/api/v1/agent/metrics`, `/api/v1/agent/state`
  and `/api/v1/agent/diagnose`, in this order. `parts` lists the parts the
  route accepts (empty for a route with no `parts`).
- `approx_tokens` is `ceil(bytes / 4)` where `bytes` is the UTF-8 size of
  the `detail=brief` JSON answer of that part. A route with no parts
  (metrics, diagnose) has `{"all": n}` for its whole answer. For the manual it is
  computed once at start; for a live part it is estimated from the last
  answer (0 before the first).
- `start_here` is one sentence that names the first concepts to read and
  the next route to call.

### `GET /api/v1/agent/manual`

Parts: `concepts`, `config`, `metrics`, `events`, `recipes`, `routes`,
`rules`, `app` (the notes of the handler; an empty list when it gave none).

Extra parameters:

| Parameter | Rule | Error |
|---|---|---|
| `topic` | a reference `<kind>:<key>` (kinds `concept`, `config`, `metric`, `event`, `recipe`, `route`, `rule`; a handler entry is `app:<kind>:<key>`). It overrides `parts`. The answer has the topic entry in `full` detail and the entries it references, one level deep, in `brief`, each under the part of its kind (`concept` under `concepts`, `config` under `config`, `metric` under `metrics`, `event` under `events`, `recipe` under `recipes`, `route` under `routes`, `rule` under `rules`, `app:` entries under `app`). `detail` is not applied to a topic answer. | 404 `{"error": "no such topic '<ref>'"}`, also for a malformed reference (no colon, unknown kind) |
| `format` | `json` (default) or `markdown` | 400 `{"error": "format must be json or markdown"}` |

JSON answer: `{"parts": {"<part>": [entry, ...]}}`, entries in registry
file order; with `topic`, the same shape with the entries found. An entry
of `detail=brief` is `{"key", "summary"}`; of `detail=full` it has every
field of its kind:

| Part | Fields of a full entry (after `key` and `summary`) |
|---|---|
| `concepts` | `body` (Markdown), `principles` (list of text), `related` (list of references) |
| `config` | `advice`, `related` |
| `metrics` | `meaning`, `healthy`, `promql` (list of `{title, query}`; `{{worker}}` and `{{cluster}}` filled from `ui.prometheus.worker_label` and `cluster_label`), `related` |
| `events` | `when`, `fields` (map field to meaning), `action`, `related` |
| `recipes` | `question`, `steps` (list of `{do, why}`), `causes` (list of `{cause, check, fix}`), `related` |
| `routes` | `use`, `cost` (`cheap`, `moderate`, `heavy`), `related` |
| `rules` | `severity` (`info`, `warning`, `critical`), `title`, `explain` (a reference), `suggestion`, `inputs` (list of state paths and metric names) |
| `app` | the handler's entries as it gave them, each `key` prefixed `app:` |

An optional field with no value is absent. Markdown answer
(`Content-Type: text/markdown; charset=utf-8`): one `#` heading per part and
one `##` heading per entry, in the same order; the rendering is pinned by
the worked example of `tests/fixtures/agent_contract.json`.

### `GET /api/v1/agent/config`

Parts: the root sections (`worker`, `cluster`, `connections`, `sources`,
`executor`, `threads`, `sinks`, `dlq`, `storage`, `recorder`, `cache`,
`autodiscover`, `metrics`, `logging`, `runtime_health`, `api`, `ui`,
`agent`, `app`).

```
{"entries": [ {"path": str, "value": str, "default": str,
               "origin": "default"|"yaml"|"env"|"on_startup",
               "type": str, "secret": bool, "meaning": str,
               "advice": str} ]}                // advice: detail=full only
```

- One entry per configured instance: the real map names, never `*`
  (`sinks.kafka.results.topic`). Sorted by `path` in byte order. `value` and `default` are in the canonical text of
  `config-metadata.json` (units as text, such as `30s`).
- A secret value is `"***"` when set and `""` when empty. This covers every
  secret flag of the config metadata, and `agent.auth_token`.
- `origin`: `default` (not given), `yaml` (given in the file), `env` (given
  by a `DK_` variable), `on_startup` (value changed by the handler's
  `on_startup`). Precedence: `on_startup` over `env` over `yaml` over
  `default`.
- `meaning` is the description of the key in the config metadata; `advice`
  comes from the registry and is absent when the registry has none.
- The `app` section is open: its keys are listed with their origin. A key
  whose name contains `password`, `secret`, `token`, `key` or `dsn` (any
  letter case) has its value masked like a secret and `secret: true`. `meaning` is the
  description from the handler's notes, else `""`.

### `GET /api/v1/agent/metrics`

Parameters: `names` (comma list of metric names), `prefix` (a name
prefix). The two combine: a metric must match one of `names` or the
`prefix` (when both are absent, every metric). `parts` is not used.

```
{"metrics": [ {"name": str, "type": str, "help": str,
               "meaning": str|null, "healthy": str|null,
               "promql": [{"title": str, "query": str}],   // full only
               "related": [str],                           // full only
               "samples": [ {"labels": {str: str}, "value": number|null}
                          | {"labels": {str: str}, "count": number|null,
                             "sum": number|null,
                             "buckets": [{"le": str, "count": int}]} ],
               "samples_total": int} ],
 "unknown": [str]}
```

- Framework metrics and the handler's metrics. A handler metric carries
  the handler's notes when given, else `meaning` and `healthy` are `null`.
- At most 100 samples per family. Label names are sorted, and samples are
  sorted by their label values in that name order (byte order); the first
  100 are sent. `samples_total` is the full count. `_created` series are
  never samples. A counter is reported under its family name with the
  `_total` suffix as exposed. A family with no samples is listed with
  `samples: []`. A histogram has one sample per label set: `count`, `sum`
  and `buckets`, a list of `{"le": "<upper bound>", "count": <cumulative
  integer>}` objects in bound order, `le` a string in the Prometheus text
  form (`"0.005"`, `"1"`, `"+Inf"`).
- A NaN or infinite `value`, `count` or `sum` is `null`.
- `unknown` lists the asked `names` that no metric has, in the asked order.
- `promql` and `related` are present only with `detail=full`, with the
  `{{worker}}` and `{{cluster}}` placeholders filled.

### `GET /api/v1/agent/state`

Parts: `health`, `budget`, `partitions`, `sinks`, `recorder`,
`autodiscover`, `recent_failures`. One snapshot, read from the existing
readers; nothing new is measured.

```
"health": {"state": str, "heartbeat_age_ms": number|null,
           "current_lag_ms": number|null, "window_peak_lag_ms": number|null,
           "stalls_total": int, "open_episode": str|null,
           "uptime_seconds": number}
"budget": null | {"tasks": int, "max_tasks": int, "bytes": int, "max_bytes": int,
           "waiting_loops": int, "backpressure_active": bool,
           "pool_active": int, "pool_max": int, "pool_waiting": int}
"partitions": null | [ {"partition": int, "queued": int, "pending_offsets": int,
                 "committed": int|null, "lag": int|null, "paused": bool,
                 "paused_by": [str], "dead": bool} ]
"sinks": null | [ {"type": str, "name": str, "breaker_open": bool,
            "delivered_total": int, "failed_total": int,
            "last_delivery_seconds": number|null} ]
"recorder": the `recorder` block of /api/v1/debug/databases (v1.30)
"autodiscover": {"enabled": bool, "provider": str|null,
                 "peers_online": int|null, "peers_offline": int|null,
                 "cluster_tasks_match": bool|null}
"recent_failures": null | {"failures": [ {"task_id": str, "ts": number,
                                   "partition": int|null,
                                   "offset": int|null,
                                   "exit_code": int|null,
                                   "duration": number|null,
                                   "error_kind": str|null,
                                   "stderr_tail": str,    // payloads only
                                   "args": [str],          // payloads only
                                   "args_truncated": bool} ],  // payloads only
                    "note": str}                          // see below
```

- `health.state` takes the values of the runtime health monitor (`state` of
  `/api/v1/runtime/health`), and `"off"` when `runtime_health.enabled` is
  false.
- `open_episode` is the verdict of the open lag episode, `null` when none.
- `budget`, `partitions`, `sinks` and `recent_failures` are read on the
  worker's main loop. Each of them is `null` when the main loop did not
  answer within the dispatch limit (a stalled worker); an empty list means
  there is nothing to list.
- `paused_by` is a sorted list of `backpressure`, `debug` and `death`.
  `lag` is the cached value of `drakkar_consumer_lag` for the partition (no
  broker request), `null` before its first refresh. `partitions` is empty
  without a Kafka source.
- `sinks[].breaker_open` is true while the circuit breaker is open or half
  open. `delivered_total` and `failed_total` count delivery calls, not
  payloads; a delivery skipped on an open circuit counts as failed.
  `last_delivery_seconds` is the age in seconds of the last successful
  delivery, `null` before the first.
- The `autodiscover` fields other than `enabled` are `null` with
  autodiscover off.
- `recent_failures` holds the last 20 `task_failed` events, newest first
  (`ts` descending, then event id descending), read from the recorder
  memory store only. `ts` is epoch seconds (float, as stored); `duration`
  is seconds (float) or `null`. With no memory store, `failures` is empty
  and `note` is `"no recorder store on this worker"`; `note` is absent
  otherwise.
- `offset` is the smallest of the `source_offsets` of the failed task (the
  `task_failed` metadata, v1.31), `null` when the event has none.
- `stderr_tail` (the last 2048 bytes of stderr, cut at a UTF-8 boundary),
  `args` and `args_truncated` are present only when
  `agent.include_payloads` is true. `args` keeps the task args while the
  compact JSON of the kept list stays within 2048 UTF-8 bytes; it stops at
  the first arg that does not fit, and `args_truncated` is true when an arg
  was left out. A stored arg that is not a string is written as its
  compact JSON text. These fields are the only payload text any agent
  route can send: the snapshot that diagnose rules read holds them only
  with the switch on, and evidence never carries payload text.

### `GET /api/v1/agent/diagnose`

Runs every diagnose rule on one state snapshot plus the metric values.

```
{"findings": [ {"rule": str, "severity": "critical"|"warning"|"info",
                "title": str, "evidence": object, "explain": str,
                "suggestion": str} ],
 "checked": [str],
 "failed": [ {"rule": str, "error": str} ]}
```

- `findings` are sorted by severity (`critical`, `warning`, `info`), then
  by `rule`. `explain` is a reference into the manual.
- `checked` lists every rule that ran, failed ones included, in the order
  of the registry (framework rules first, then the handler's). A handler
  rule is named `app:<key>`.
- A rule that raises is listed in `failed` with its error text (free text,
  not part of the contract) and does not stop the others. A handler rule runs off the event loop with a limit of
  1 second; a rule that exceeds it is listed in `failed` with
  `timed out after 1 s`.
- A rule reads only the parts and fields it needs. A part that is `null`,
  or a row without one of the fields a rule reads, gives no finding for
  that part or row; it does not fail the rule. `lag-growing` sums only the
  known lags (`null` lags are left out; with no known lag the call changes
  nothing).
- The rules `lag-growing`, `recorder-dropping` and `dlq-writing` compare
  with a baseline kept in memory on the worker process, each with its own.
  Calls are serialized on the baselines; the first call ever only sets
  them. `lag-growing`: the baseline (sum of lags and its time) is kept
  until a call comes at least 60 seconds after it; that call compares with
  it and then replaces it, and a call within 60 seconds compares nothing and
  keeps it. `recorder-dropping` and `dlq-writing`: any later call compares
  with the baseline and replaces it, with no minimum age.

### Status codes

| Route | Codes |
|---|---|
| all six | 200, 404 (switch off), 401 (token) |
| index | none besides the common three |
| config, state | 400 (`parts`, `detail`) |
| manual | 400 (`parts`, `detail`, `format`), 404 `no such topic '<ref>'` |
| metrics, diagnose | 400 (`detail`) |

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
| 9 | probe `sink_type` enum | `kafka`, `postgres`, `mongo`, `http`, `redis`, `files` (`custom` removed in v1.28) | Python |
| 10 | merge/download/trace input hardening | Go's stricter validation | Python |
| 11 | metrics untyped family / counter sample name | `"unknown"` / keep `_total` | Go |
| 12 | 422 envelope richness | minimal `{loc,msg}`; UI reads msg only | UI |
| 13 | WS non-encodable values | never publish such | both |
