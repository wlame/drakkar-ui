<script lang="ts">
  // Message Probe tab: replay a message through the live handler pipeline with zero
  // side effects, then render the DebugReport (ports debug.html probe). The probe
  // always returns HTTP 200; a wall-clock timeout is signalled by `truncated`.
  import {
    api,
    type DebugReport,
    type ProbeRequest,
    type ProbeTaskEntry,
    type CollectResult,
    type PlannedSinkRecord,
  } from '../../lib/api'
  import { runtimeConfig } from '../../lib/config'
  import { durSec, safeJsonParse } from '../../lib/format'
  import KafkaIcon from '../KafkaIcon.svelte'

  // form state
  let value = $state('')
  let key = $state('')
  let partition = $state(0)
  let offset = $state(0)
  let topic = $state($runtimeConfig.kafkaSourceTopic)
  let useCache = $state(false)

  let busy = $state(false)
  let formError = $state<string | null>(null)
  let report = $state<DebugReport | null>(null)
  let collapsed = $state(false)
  let openTask = $state<ProbeTaskEntry | null>(null)
  let expandedSink = $state<Set<string>>(new Set())

  const SINK_TYPES = ['kafka', 'postgres', 'mongo', 'http', 'redis', 'files'] as const

  function taskColor(t: ProbeTaskEntry): string {
    if (t.retry_of) return '#f97316'
    if (t.status === 'failed') return '#dc2626'
    if (t.status === 'replaced') return '#6b7280'
    return '#059669'
  }
  function exitLabel(code: number | null): string {
    if (code == null) return '-'
    if (code === 0) return 'ok'
    if (code === 124) return 'timeout'
    if (code < 0) return `signal(${-code})`
    return `error(${code})`
  }
  function sinkCounts(c: CollectResult | null): string {
    if (!c) return ''
    return SINK_TYPES.filter((k) => (c[k] as unknown[])?.length).map((k) => `${k}: ${(c[k] as unknown[]).length}`).join(' · ')
  }
  function pretty(v: unknown): string {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  async function run() {
    formError = null
    if (!value) {
      formError = 'value is required'
      return
    }
    if (partition < 0 || offset < 0 || !Number.isInteger(partition) || !Number.isInteger(offset)) {
      formError = 'partition and offset must be non-negative integers'
      return
    }
    const req: ProbeRequest = { value, key: key || null, partition, offset, topic: topic || '', use_cache: useCache }
    busy = true
    try {
      report = await api.debugProbe(req)
      collapsed = true
    } catch (e) {
      formError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function downloadJson() {
    if (!report) return
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'probe-report.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function toggleSink(k: string) {
    const next = new Set(expandedSink)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    expandedSink = next
  }

  const sinkGroups = $derived.by(() => {
    const map = new Map<string, PlannedSinkRecord[]>()
    for (const p of report?.planned_sink_payloads ?? []) {
      if (!map.has(p.sink_type)) map.set(p.sink_type, [])
      map.get(p.sink_type)!.push(p)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  })
</script>

{#if collapsed && report}
  <div class="chip">
    <span class="mono">P{report.input.partition}:{report.input.offset} {report.input.topic || $runtimeConfig.kafkaSourceTopic} {report.input.key ?? ''}{report.input.use_cache ? ' (cache)' : ''}</span>
    <button onclick={() => (collapsed = false)}>Edit</button>
  </div>
{:else}
  <form class="form" onsubmit={(e) => { e.preventDefault(); run() }}>
    <label class="full">Value<textarea rows="6" bind:value placeholder="message payload"></textarea></label>
    <label>Key<input bind:value={key} /></label>
    <label>Topic<input bind:value={topic} /></label>
    <label>Partition<input type="number" min="0" bind:value={partition} /></label>
    <label>Offset<input type="number" min="0" bind:value={offset} /></label>
    <label class="ck"><input type="checkbox" bind:checked={useCache} /> Use cache (read-only)</label>
    <div class="run"><button class="primary" type="submit" disabled={busy}>{busy ? 'Running…' : 'Run'}</button></div>
  </form>
{/if}

{#if formError}<p class="error">{formError}</p>{/if}

{#if report}
  {#if report.truncated}<div class="warn">Partial report — the probe hit its time budget.</div>{/if}

  <div class="toolbar">
    <button onclick={downloadJson}>Download JSON</button>
    <button onclick={run} disabled={busy}>Re-run</button>
    <button onclick={() => (collapsed = false)}>Edit &amp; re-run</button>
  </div>

  <!-- Input -->
  <section class="card">
    <h3>Input</h3>
    {#if report.deserialize_error}
      <p class="error">deserialize failed: {report.deserialize_error.message}</p>
    {:else}
      <div class="kv">
        <span>partition:offset</span><span class="mono">{report.input.partition}:{report.input.offset}<KafkaIcon partition={report.input.partition} offset={report.input.offset} topic={report.input.topic} /></span>
        <span>topic</span><span class="mono">{report.input.topic || $runtimeConfig.kafkaSourceTopic}</span>
        <span>key</span><span class="mono">{report.input.key ?? '-'}</span>
        <span>message label</span><span class="mono">{report.message_label ?? '-'}</span>
      </div>
      {#if report.parsed_payload != null}
        <h4>Parsed payload</h4>
        <pre class="block">{pretty(report.parsed_payload)}</pre>
      {/if}
    {/if}
  </section>

  <!-- Arrange -->
  <section class="card">
    <h3>Arrange</h3>
    {#if report.arrange.error}
      <p class="error">arrange raised: {report.arrange.error}</p>
    {:else}
      <p class="muted">{report.tasks.length} tasks generated · {durSec(report.arrange.duration_seconds)}</p>
      {#if report.tasks.length === 0}<p class="muted">arrange returned no tasks — message would be skipped</p>{/if}
    {/if}
  </section>

  <!-- Tasks -->
  {#if report.tasks.length}
    <section class="card">
      <h3>Tasks ({report.tasks.length})</h3>
      <table>
        <thead>
          <tr><th>#</th><th>task_id</th><th>status</th><th class="num">exit</th><th>precomp</th><th class="num">duration</th><th class="num">stdout</th><th class="num">stderr</th></tr>
        </thead>
        <tbody>
          {#each report.tasks as t, i (t.task_id)}
            <tr class="clickable" onclick={() => (openTask = t)}>
              <td class="muted">{i + 1}</td>
              <td class="mono">{t.task_id}</td>
              <td><span style:color={taskColor(t)}>{t.retry_of ? 'retried' : t.status}</span></td>
              <td class="num mono">{exitLabel(t.exit_code)}</td>
              <td>{t.precomputed ? '✓' : ''}</td>
              <td class="num mono">{durSec(t.duration_seconds)}</td>
              <td class="num mono">{t.stdout.length || ''}</td>
              <td class="num mono" style:color={t.stderr.length ? '#f87171' : undefined}>{t.stderr.length || ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}

  <!-- Hook results -->
  {#each [{ label: 'on_message_complete', r: report.on_message_complete }, { label: 'on_window_complete', r: report.on_window_complete }] as hook}
    <section class="card">
      <h3>{hook.label}</h3>
      {#if !hook.r}
        <p class="muted">did not run</p>
      {:else}
        <p class="muted">{durSec(hook.r.duration_seconds)}{#if sinkCounts(hook.r.collect_result)} · {sinkCounts(hook.r.collect_result)}{/if}</p>
        {#if hook.r.error}<p class="error">{hook.r.error}</p>{/if}
        {#if hook.r.collect_result}<pre class="block">{pretty(hook.r.collect_result)}</pre>{/if}
      {/if}
    </section>
  {/each}

  <!-- Planned sink outputs -->
  <section class="card">
    <h3>Planned sink outputs ({report.planned_sink_payloads.length})</h3>
    {#if report.planned_sink_payloads.length === 0}
      <p class="muted">no sink outputs</p>
    {:else}
      {#each sinkGroups as [stype, recs]}
        <h4>{stype} ({recs.length})</h4>
        <table>
          <thead><tr><th>destination</th><th>origin stage</th><th>payload</th></tr></thead>
          <tbody>
            {#each recs as p, i (`${stype}:${i}`)}
              <tr class="clickable" onclick={() => toggleSink(`${stype}:${i}`)}>
                <td class="mono">{p.destination}{#if stype === 'kafka'}<KafkaIcon partition={report.input.partition} offset={report.input.offset} topic={String(p.extras.topic ?? p.destination)} />{/if}</td>
                <td class="muted">{p.origin_stage}</td>
                <td class="muted preview">{pretty(p.payload).slice(0, 80)}</td>
              </tr>
              {#if expandedSink.has(`${stype}:${i}`)}
                <tr><td colspan="3"><pre class="block">{pretty({ payload: p.payload, extras: p.extras })}</pre></td></tr>
              {/if}
            {/each}
          </tbody>
        </table>
      {/each}
    {/if}
  </section>

  <!-- Cache calls -->
  <section class="card">
    <h3>Cache calls</h3>
    <p class="muted">{report.cache_summary.calls} calls · {report.cache_summary.hits} hits · {report.cache_summary.misses} misses · {report.cache_summary.writes_suppressed} writes suppressed</p>
    {#if report.cache_calls.length}
      <table>
        <thead><tr><th class="num">ms</th><th>stage</th><th>op</th><th>key</th><th>scope</th><th>outcome</th><th>value</th></tr></thead>
        <tbody>
          {#each report.cache_calls as c, i (i)}
            <tr>
              <td class="num mono">{c.ms_since_start.toFixed(0)}</td>
              <td class="muted">{c.origin_stage}</td>
              <td class="mono">{c.op}</td>
              <td class="mono">{c.key}</td>
              <td class="mono">{c.scope ?? '-'}</td>
              <td><span style:color={c.outcome === 'hit' ? '#34d399' : c.outcome === 'suppressed' ? '#60a5fa' : '#8b93ad'}>{c.outcome}</span></td>
              <td class="muted preview">{c.value_preview ?? ''}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <!-- Errors -->
  {#if report.errors.length}
    <section class="card">
      <h3 style:color="#f87171">Errors ({report.errors.length})</h3>
      {#each report.errors as err, i (i)}
        <details>
          <summary><span style:color="#f87171">{err.stage}</span> — {err.exception_class}: {err.message}</summary>
          <pre class="block">{err.traceback}</pre>
        </details>
      {/each}
    </section>
  {/if}
{/if}

<!-- Task detail sidebar -->
{#if openTask}
  {@const t = openTask}
  <div class="sidebar">
    <div class="sb-head">
      <span class="mono">{t.task_id}</span>
      <button class="x" onclick={() => (openTask = null)} aria-label="Close">×</button>
    </div>
    <div class="kv">
      <span>status</span><span style:color={taskColor(t)}>{t.retry_of ? 'retried' : t.status}</span>
      <span>exit</span><span class="mono">{exitLabel(t.exit_code)}</span>
      <span>duration</span><span class="mono">{durSec(t.duration_seconds)}</span>
      {#if t.retry_of}<span>retry of</span><span class="mono">{t.retry_of}</span>{/if}
      {#if t.replacement_for}<span>replaces</span><span class="mono">{t.replacement_for}</span>{/if}
      {#if Object.keys(t.labels).length}<span>labels</span><span class="mono">{Object.entries(t.labels).map(([k, v]) => `${k}=${v}`).join(', ')}</span>{/if}
      {#if t.source_offsets.length}<span>offsets</span><span class="mono">{t.source_offsets.join(', ')}</span>{/if}
    </div>
    {#if t.stdin}<h4>stdin</h4><pre class="block">{t.stdin}</pre>{/if}
    {#if t.stdout}<h4>stdout</h4><pre class="block">{t.stdout}</pre>{/if}
    {#if t.stderr}<h4>stderr</h4><pre class="block err">{t.stderr}</pre>{/if}
    {#if t.subprocess_exception}<h4>subprocess exception</h4><pre class="block err">{t.subprocess_exception}</pre>{/if}
    {#if t.on_task_complete_error}<h4>on_task_complete error</h4><pre class="block err">{t.on_task_complete_error}</pre>{/if}
    {#if t.on_task_complete_result}<h4>on_task_complete result</h4><pre class="block">{pretty(t.on_task_complete_result)}</pre>{/if}
  </div>
{/if}

<style>
  .form {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
    margin-bottom: 1rem;
  }
  .form .full {
    grid-column: 1 / -1;
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .form label.ck {
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
  }
  .form input,
  .form textarea {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.35rem 0.5rem;
  }
  .form textarea {
    font-family: var(--mono);
    resize: vertical;
  }
  .form .run {
    grid-column: 1 / -1;
  }
  .primary {
    background: #0d9488;
    border-color: #0d9488;
    color: #fff;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    margin-bottom: 1rem;
  }
  .chip .mono {
    flex: 1;
  }
  .warn {
    padding: 0.5rem 0.8rem;
    border-radius: 8px;
    background: rgba(251, 191, 36, 0.15);
    border: 1px solid rgba(251, 191, 36, 0.4);
    color: #fbbf24;
    margin-bottom: 1rem;
  }
  .toolbar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    position: sticky;
    top: 0;
    background: var(--bg);
    padding: 0.25rem 0;
    z-index: 5;
  }
  .card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    padding: 1rem;
    margin-bottom: 1rem;
  }
  h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
  }
  h4 {
    margin: 0.8rem 0 0.3rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    font-size: 0.85rem;
  }
  .kv > span:nth-child(odd) {
    color: var(--muted);
  }
  .preview {
    max-width: 24rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 0.78rem;
  }
  .clickable {
    cursor: pointer;
  }
  .clickable:hover td {
    background: var(--panel-2);
  }
  .block {
    background: var(--bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.6rem;
    max-height: 18rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0.3rem 0;
  }
  .block.err {
    color: var(--error);
  }
  details summary {
    cursor: pointer;
    font-size: 0.85rem;
    margin: 0.3rem 0;
  }
  .sidebar {
    position: fixed;
    top: 3.25rem;
    right: 0;
    width: 30rem;
    max-width: 95vw;
    height: calc(100vh - 3.25rem);
    background: var(--panel-2);
    border-left: 1px solid var(--line);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.45);
    padding: 1rem;
    overflow: auto;
    z-index: 45;
  }
  .sb-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .sb-head .x {
    padding: 0.1rem 0.5rem;
  }
</style>
