<script lang="ts">
  // Task detail: the full lifecycle of one task (ports task_detail.html).
  // GET /api/v1/task/{id} returns a composed object whose events[] carries the
  // raw rows; the page derives the view client-side from those rows — the same
  // derivation the reference renders server-side: first started/completed/failed
  // rows, parsed metadata (source offsets, env), args→CLI, labels, http
  // request/response bodies, and a chronological timeline. The task id may carry
  // a `:r<ts>` retry suffix, which is stripped before querying but kept in the
  // header.
  import { api, type EventRow } from '../lib/api'
  import { link } from '../lib/router'
  import { fmtTime, fmtTimeMs, fmtTimeFull, dur3, fmtBytes, safeJsonParse } from '../lib/format'
  import { eventColor, statusColor, type TaskStatus } from '../lib/events'
  import KafkaIcon from '../components/KafkaIcon.svelte'

  let { params = {} }: { params?: Record<string, string> } = $props()

  const taskId = $derived(params.id ?? '')
  const baseId = $derived(taskId.split(':r')[0])

  let events = $state<EventRow[] | null>(null)
  let error = $state<string | null>(null)
  let reqId = 0

  async function load() {
    if (!baseId) {
      error = 'Missing task id'
      events = []
      return
    }
    const myReq = ++reqId
    error = null
    events = null
    try {
      const r = await api.task(baseId)
      if (myReq === reqId) events = r.events ?? []
    } catch (e) {
      if (myReq === reqId) error = e instanceof Error ? e.message : String(e)
    }
  }

  $effect(() => {
    void baseId
    load()
  })

  interface HttpBody {
    recorded: boolean
    bodyBytes?: number
    value?: unknown
  }

  interface Vm {
    status: TaskStatus
    duration: number | null
    exitCode: number | null
    exitIsError: boolean
    pid: number | null
    partition: number | null
    origin: string
    clientName: string | null
    requestId: string | null
    started: EventRow | undefined
    finished: EventRow | undefined
    completed: EventRow | undefined
    failed: EventRow | undefined
    sourceOffsets: number[]
    env: Record<string, string>
    labels: Record<string, string>
    cli: string | null
    requestBody: HttpBody | null
    responseBody: unknown
  }

  // Reproduce the reference handler's derivation over the (id ASC) event rows.
  const vm = $derived.by<Vm | null>(() => {
    if (!events) return null
    const started = events.find((e) => e.event === 'task_started')
    const completed = events.find((e) => e.event === 'task_completed')
    const failed = events.find((e) => e.event === 'task_failed')
    const finished = completed ?? failed

    const status: TaskStatus = completed
      ? 'completed'
      : failed
        ? 'failed'
        : started
          ? 'running'
          : 'unknown'

    const duration =
      finished?.duration != null
        ? finished.duration
        : finished && started
          ? finished.ts - started.ts
          : null

    const meta = safeJsonParse<Record<string, unknown>>(started?.metadata, {})
    const sourceOffsets = Array.isArray(meta.source_offsets) ? (meta.source_offsets as number[]) : []
    const env =
      meta.env && typeof meta.env === 'object' ? (meta.env as Record<string, string>) : {}
    const labels = safeJsonParse<Record<string, string>>(started?.labels, {})

    // origin/client/request: last truthy across all events (origin defaults kafka).
    let origin = 'kafka'
    let clientName: string | null = null
    let requestId: string | null = null
    for (const e of events) {
      if (e.origin) origin = e.origin
      if (e.client_name) clientName = e.client_name
      if (e.request_id) requestId = e.request_id
    }

    const pid = finished?.pid ?? started?.pid ?? null
    const exitCode = completed ? completed.exit_code : (failed?.exit_code ?? null)
    const exitIsError = (completed != null && completed.exit_code !== 0) || failed != null

    // CLI: binary_path is a backend config value not carried by the contract, so
    // the line shows the JSON-encoded argv (matching the reference's arg formatting).
    let cli: string | null = null
    const rawArgs = started?.args
    if (rawArgs) {
      const parsed = safeJsonParse<unknown>(rawArgs, rawArgs)
      const parts = Array.isArray(parsed) ? parsed : [parsed]
      cli = parts.map((p) => JSON.stringify(p)).join(' ')
    }

    // HTTP request/response bodies (only meaningful for origin === 'http').
    let requestBody: HttpBody | null = null
    let responseBody: unknown = undefined
    if (origin === 'http') {
      const received = events.find((e) => e.event === 'webapp_request_received')
      if (received) {
        const m = safeJsonParse<Record<string, unknown>>(received.metadata, {})
        if (m.body == null && m.body_bytes != null) {
          requestBody = { recorded: false, bodyBytes: Number(m.body_bytes) }
        } else if (m.body != null) {
          requestBody = { recorded: true, value: m.body }
        } else {
          requestBody = { recorded: false }
        }
      }
      const done = events.find((e) => e.event === 'webapp_request_completed')
      if (done) {
        const m = safeJsonParse<Record<string, unknown>>(done.metadata, {})
        responseBody = m.response
      }
    }

    return {
      status,
      duration,
      exitCode,
      exitIsError,
      pid,
      partition: started?.partition ?? null,
      origin,
      clientName,
      requestId,
      started,
      finished,
      completed,
      failed,
      sourceOffsets,
      env,
      labels,
      cli,
      requestBody,
      responseBody,
    }
  })

  function pretty(v: unknown): string {
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
</script>

<div class="head">
  <h1>Task Detail</h1>
  <code class="id">{taskId}</code>
  {#if vm}
    {#if vm.origin === 'http'}
      <span class="badge http">HTTP</span>
      {#if vm.clientName}<span class="muted">← client {vm.clientName}</span>{/if}
    {:else if vm.partition != null}
      <a class="back" href={`/partitions/${vm.partition}`} use:link>← partition {vm.partition}</a>
    {/if}
  {/if}
</div>

{#if error}
  <p class="error">Could not load task: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !vm}
  <p class="muted">Loading…</p>
{:else}
  <!-- Summary -->
  <div class="card summary" class:http={vm.origin === 'http'}>
    <div class="field">
      <span class="k">Status</span>
      <span class="v" style:color={statusColor(vm.status)}>{vm.status}</span>
    </div>
    {#if vm.origin === 'http'}
      <div class="field"><span class="k">Client</span><span class="v">{vm.clientName ?? '-'}</span></div>
      <div class="field"><span class="k">Request ID</span><span class="v mono break">{vm.requestId ?? '-'}</span></div>
    {:else}
      <div class="field">
        <span class="k">Partition</span>
        <span class="v">
          {#if vm.partition != null}<a href={`/partitions/${vm.partition}`} use:link>{vm.partition}</a>{:else}-{/if}
        </span>
      </div>
    {/if}
    <div class="field"><span class="k">Duration</span><span class="v mono">{vm.duration != null ? dur3(vm.duration) : '-'}</span></div>
    <div class="field">
      <span class="k">Exit Code</span>
      <span class="v mono" class:err={vm.exitIsError}>{vm.exitCode ?? '-'}</span>
    </div>
    <div class="field"><span class="k">PID</span><span class="v mono">{vm.pid ?? '-'}</span></div>
    {#if vm.started}
      <div class="field">
        <span class="k">Started</span>
        <span class="v mono" title={fmtTimeMs(vm.started.ts)}>{fmtTime(vm.started.ts)}</span>
        <span class="sub muted">{fmtTimeFull(vm.started.ts)}</span>
      </div>
      {#if vm.finished}
        <div class="field">
          <span class="k">Finished</span>
          <span class="v mono" title={fmtTimeMs(vm.finished.ts)}>{fmtTime(vm.finished.ts)}</span>
        </div>
      {/if}
      {#if vm.completed?.stdout_size}
        <div class="field"><span class="k">Stdout Size</span><span class="v mono">{fmtBytes(vm.completed.stdout_size)}</span></div>
      {/if}
    {/if}
  </div>

  {#if Object.keys(vm.labels).length}
    <h2>Labels</h2>
    <div class="chips">
      {#each Object.entries(vm.labels) as [k, v]}<span class="chip teal">{k}={v}</span>{/each}
    </div>
  {/if}

  {#if Object.keys(vm.env).length}
    <h2>Environment Variables</h2>
    <div class="chips">
      {#each Object.entries(vm.env) as [k, v]}<span class="chip amber">{k}={v}</span>{/each}
    </div>
  {/if}

  {#if vm.sourceOffsets.length && vm.partition != null}
    <h2>Source Message Offsets</h2>
    <div class="chips">
      {#each vm.sourceOffsets as off}
        <span class="chip">
          <a href={`/debug#trace/${vm.partition}/${off}`} use:link>{vm.partition}:{off}</a>
          <KafkaIcon partition={vm.partition} offset={off} />
        </span>
      {/each}
    </div>
  {/if}

  {#if vm.cli}
    <h2>CLI</h2>
    <pre class="block select-all">{vm.cli}</pre>
  {/if}

  {#if vm.origin === 'http' && vm.requestBody}
    <h2>HTTP Request Body</h2>
    {#if !vm.requestBody.recorded}
      <p class="muted">request body not recorded{vm.requestBody.bodyBytes != null ? ` (${vm.requestBody.bodyBytes} bytes seen on the wire)` : ''}</p>
    {:else}
      <pre class="block">{pretty(vm.requestBody.value)}</pre>
    {/if}
  {/if}

  {#if vm.origin === 'http' && vm.responseBody !== undefined}
    <h2>HTTP Response Body</h2>
    <pre class="block">{pretty(vm.responseBody)}</pre>
  {/if}

  {#if vm.completed?.stdout}
    <h2>Stdout</h2>
    <pre class="block">{vm.completed.stdout}</pre>
  {/if}

  {#if vm.completed?.stderr}
    <h2>Stderr</h2>
    <pre class="block err">{vm.completed.stderr}</pre>
  {/if}

  {#if vm.failed?.stderr}
    <h2>Stderr</h2>
    <pre class="block err">{vm.failed.stderr}</pre>
  {/if}

  <h2>Event Timeline</h2>
  {#if events && events.length}
    <div class="timeline">
      {#each events as e (e.id)}
        <div class="tl-row" style:border-left-color={eventColor(e.event)}>
          <span class="evt" style:color={eventColor(e.event)}>{e.event}</span>
          {#if e.exit_code != null}<span class="muted">exit={e.exit_code}</span>{/if}
          {#if e.duration != null}<span class="muted mono">{dur3(e.duration)}</span>{/if}
          <span class="spacer"></span>
          <span class="muted mono" title={fmtTimeMs(e.ts)}>{fmtTime(e.ts)}</span>
        </div>
      {/each}
    </div>
  {:else}
    <p class="muted">No events found for this task.</p>
  {/if}
{/if}

<style>
  .head {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .head h1 {
    margin: 0;
  }
  .id {
    background: var(--panel-2);
    border-radius: 6px;
    padding: 0.15rem 0.5rem;
  }
  .badge.http {
    background: rgba(192, 132, 252, 0.18);
    color: var(--link);
    border-radius: 999px;
    padding: 0.1rem 0.55rem;
    font-size: 0.72rem;
    font-weight: 600;
  }
  .back {
    font-size: 0.85rem;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    padding: 1rem;
  }
  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 1rem;
  }
  .summary.http {
    border-color: rgba(192, 132, 252, 0.4);
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .field .k {
    font-size: 0.75rem;
    color: var(--muted);
  }
  .field .v {
    font-size: 1.05rem;
    font-weight: 600;
  }
  .field .sub {
    font-size: 0.72rem;
    font-weight: 400;
  }
  .v.err,
  .block.err {
    color: var(--error);
  }
  .break {
    word-break: break-all;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    font-size: 0.78rem;
    font-family: var(--mono);
    border-radius: 6px;
    padding: 0.2rem 0.5rem;
    background: var(--panel-2);
    border: 1px solid var(--line);
  }
  .chip.teal {
    color: #0d9488;
  }
  .chip.amber {
    color: #d97706;
  }
  .chip a {
    color: inherit;
  }
  .block {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.75rem;
    max-height: 22rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  .select-all {
    user-select: all;
  }
  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .tl-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.75rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-left: 3px solid var(--line);
    border-radius: 6px;
    font-size: 0.85rem;
  }
  .tl-row .evt {
    font-weight: 600;
  }
  .tl-row .spacer {
    flex: 1;
  }
</style>
