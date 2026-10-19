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
- **`/ws` Origin:** checked on every handshake, with or without a token. An
  absent `Origin` (non-browser clients) and a same-origin one always pass;
  a non-empty `ui.allowed_ws_origins` is a strict allowlist. With a token
  set, every other cross-origin handshake is `4403`. Without one, a
  cross-origin handshake passes — this is what the cluster view relies on —
  **unless** the request `Host` is a loopback address and the `Origin` host
  is not, which no peer worker ever is. A client must treat `4403` as
  terminal and not reconnect.
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
  liveness fields and the v1.23 registry fields; sorted clustered-first then by
  name.
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
  slot, labels, env, origin, client_name, request_id}`. Archived retry attempts
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
- `GET /api/v1/debug/databases` → `{own:[...], history:{folders:[...]}}`
  (v1.23; see "Sealed history" below).
- `POST /api/v1/debug/merge` body `{filenames:[path] (≥2)}` → `{filename,
  path, worker_count, event_count, state_count, cluster_name,
  source_files:[str]}`. Paths are relative to `shared.dir` (v1.23). 400 on
  malformed JSON body; segment hardening rejects `/ \` leading-`.` `"` `;`
  and control chars; 404 for missing files; 500 when the merge itself
  fails; errors via `{"error":...}`.
- `GET /api/v1/debug/download/{path}` → file attachment; `Content-Type:
  application/x-sqlite3` (`.db`) or `application/gzip` (`.db.gz`),
  `Content-Disposition: attachment; filename="..."`, `Cache-Control:
  no-store, private`. `path` relative to `shared.dir` (v1.23). Token may
  ride as `?token=` (plain `<a>` downloads cannot set headers).
- `GET /api/v1/debug/archives` → `{archives:[{name, cluster, folder, path,
  from_ts, to_ts, size_bytes}]}`, newest-first by `to_ts`, from every
  `history/<cluster>/` folder. See v1.8 and v1.23 below.
- `GET /api/v1/debug/trace?partition=&offset=[&history=1]` (partition and
  offset required int) → array of event rows. `partition` must fit int32 →
  422 otherwise. `history=1` searches sealed history only (v1.23).
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
- `PlannedSinkRecord`: `{sink_type(kafka|postgres|mongo|http|redis|files|custom),
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

**PINNED (v1.21).** An `event` field carries one of these 30
names and nothing else — 29 of them can appear in the `events` table,
and `throughput` is broadcast on `/ws` only. The UI matches on these names,
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
| `task_complete` | both | `events` + `/ws` |
| `task_completed` | both | `events` + `/ws` |
| `task_failed` | both | `events` + `/ws` |
| `task_started` | both | `events` + `/ws` |
| `throughput` | both | `/ws` only |
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
- No DB-file **delete** endpoint (merged files accumulate in db_dir).
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
    additionally clamped server-side to `ui.timeline.max_age_minutes` when
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
(`ui.recorder.archive_enabled`) folds a finished time window's raw
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
  the naming grammar above and resolve inside the backend's `db_dir`; a
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
  `<db_dir>/.dbstats.db` cache keyed by `(path, mtime_ns, size_bytes)`
  (schema `db_stats_v1`, identical across backends — a mixed fleet
  shares the file). The file *list* is always a live directory scan, so
  externally deleted files disappear on the next request; only derived
  statistics are cached. `stats_pending: true` marks rows whose
  statistics were not computed yet (cold cache, per-request inline scan
  budget exhausted — `ui.recorder.dbstats_inline_scan_limit`); a
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
  name.
- **Security posture** (normative): the endpoints sit behind the standard
  optional `auth_token` gate. When any readable alias resolves to a
  non-PLAINTEXT Kafka security config while `auth_token` is empty (and the
  API is enabled), backends log a startup warning naming the exposed
  aliases — and keep serving; the operator owns the trade-off.

## v1.14 additions (2026-08-19)

Timed consume pause — a Live-page debug control that stops message intake
for a bounded period. Three endpoints, plus config
`ui.consume_pause.{enabled, durations_seconds}` (default: disabled,
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
leaving `healthy` to its return (or to the `runtime_health.
episode_max_seconds` cap, default 300 — a longer incident produces several
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
  serving backend's `ui.workers_offline_after_seconds` (default 30).
- **Current worker** (normative): the row with `is_current: true` always
  reports `online: true` — the backend answering the request is alive by
  construction.
- **Absence** (normative): pre-v1.18 backends omit BOTH fields entirely,
  never `null`-ed or defaulted. Clients MUST degrade to the previous
  behavior and treat every worker as online when the fields are absent.
- **Operational meaning.** Peers are discovered via the shared db_dir,
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
  (`request_timeout_seconds` + 30 s, answering **408**), which Go already
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
  registry's own clock against `fleet.registry.offline_after_seconds`;
  **`null`** when the registry knows no age (a fixed peer list). Clients MUST
  treat `null` as "unknown", not as offline.
- **`last_seen_ts: number | null`** — epoch seconds on the serving worker's
  clock: `now − age` when the age is known, else `null`.
- **New optional fields**, present when the card carries them:
  `backend` (`"python"` | `"go"`), `version` (string), `state`
  (`"starting"` | `"running"` | `"draining"`), `started_at` (RFC 3339
  micro), `instance` (16 lowercase hex, new at every process start).

Current worker row (normative): `is_current: true`, `online: true`,
`ip_address: null`, `debug_port` = the UI port, `debug_url` =
`ui.public_url` or `null`, and `url` = `ui.public_url` when set, else
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
moves it into `<shared.dir>/history/<cluster>/`, with a meta file
`<name>.db.meta.json` beside it. Merge results go to `<shared.dir>/merged/`.
The debug routes below read those folders. Paths in requests and answers
are relative to `shared.dir` and use `/` separators.

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
  Memory-only workers answer `{"own": [], "history": {"folders": []}}`.

- **`GET /api/v1/debug/download/{path}`** — `path` is
  `history/<cluster>/<name>.db`, `history/<cluster>/<archive>.db.gz` or
  `merged/<name>.db`. Every segment follows the old filename hardening (no
  `/ \`, no leading `.`, no `"` `;` or control characters); the resolved
  file must stay inside `shared.dir`. `Content-Type` is
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
  first, within the backend's `ui.trace.history_max_files` /
  `history_max_seconds` budget. Rows keep `worker_name`. A client that wants
  both calls both and merges the rows.
- **`GET /api/v1/debug/trace-by-label`** searches the serving worker's own
  live file only.

Absence (normative): pre-v1.23 backends answer `/debug/databases` with an
array. Clients MUST detect the array and show that the databases view is
not available on that worker, rather than rendering it with the new layout.

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
