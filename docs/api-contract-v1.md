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
- `GET /ws?events=<csv>` (WebSocket) — accept → token check → origin check.

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
**v1.3 additions**. Framework
datetimes embedded in `metadata` JSON use the canonical cross-backend
format `YYYY-MM-DDTHH:MM:SS.ffffffZ` (fixed six-digit microseconds); the
`dt` column keeps its display format `YYYY-MM-DD HH:MM:SS.mmm`.

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
    serving (e.g. `"v0.1.1"`), `null` when the built-in pages serve (or
    when an embedded pre-release stub carries no tag).
  - `ui_source:str` — `"release"` (fetched/cached bundle) | `"embedded"`
    (the release baked into the backend binary/package, served when the
    cache is empty and GitHub is unreachable) | `"builtin"`
    (server-rendered fallback pages; only when `ui.release.enabled=false`
    or resolution errored). The UI must tolerate unknown future values.
- `GET /api/v1/openapi.json` → the OpenAPI 3.1 document describing this
  surface, converted from the canonical `docs/openapi-v1.yaml` in this repo
  (vendored byte-identically into both backends). Protected by the same
  optional bearer token as every other API route.
- `GET /docs` → human-facing Swagger UI over that document. Self-hosted
  assets only (no CDN — deployments are often firewalled); token-protected
  exactly like the other UI pages. Not part of the JSON API, listed here so
  backends stay drop-in identical.
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
