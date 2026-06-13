<script lang="ts">
  // Message Trace tab: trace a message across all cluster workers by
  // partition:offset or by label key=value (ports debug.html trace). Supports the
  // #trace/<partition>/<offset> deep-link prefill via the `prefill` prop.
  import { onMount } from 'svelte'
  import { api, type TraceEvent } from '../../lib/api'
  import { link, setHash } from '../../lib/router'
  import { fmtTimeMs, dur3, safeJsonParse } from '../../lib/format'
  import { eventColor, durationColor } from '../../lib/events'
  import { baseTaskId } from '../../lib/live'
  import KafkaIcon from '../KafkaIcon.svelte'

  let { prefill = null }: { prefill?: { partition: number; offset: number } | null } = $props()

  let inputVal = $state('')
  let statusMsg = $state('')
  let results = $state<TraceEvent[] | null>(null)
  let labelKeys = $state<string[]>([])
  let labelVals = $state<Record<string, string>>({})
  let lastRun = $state('')

  function parseInput(s: string): [number, number] | null {
    const m = s.trim().match(/^(\d+)[:\s/](\d+)$/)
    if (!m) return null
    return [Number(m[1]), Number(m[2])]
  }

  async function runTrace(p: number, o: number) {
    inputVal = `${p}:${o}`
    statusMsg = 'tracing…'
    setHash(`#trace/${p}/${o}`, { replace: true })
    try {
      const ev = await api.debugTrace(p, o)
      results = ev
      statusMsg = ev.length ? `${ev.length} events` : `No events found for ${p}:${o} in any cluster worker`
    } catch (e) {
      statusMsg = e instanceof Error ? e.message : String(e)
      results = []
    }
  }

  function onTraceClick() {
    const parsed = parseInput(inputVal)
    if (!parsed) {
      statusMsg = 'format: partition:offset'
      return
    }
    runTrace(parsed[0], parsed[1])
  }

  async function runLabelTrace(key: string, value: string) {
    if (!value) return
    statusMsg = `tracing ${key}=${value}…`
    try {
      const ev = await api.debugTraceByLabel(key, value)
      results = ev
      statusMsg = ev.length ? `${ev.length} events` : `No events found for ${key}=${value}`
    } catch (e) {
      statusMsg = e instanceof Error ? e.message : String(e)
      results = []
    }
  }

  // Assemble the Details cell from the same fields the reference surfaces.
  function details(e: TraceEvent): string {
    const parts: string[] = []
    if (e.args) parts.push(e.args)
    if (e.exit_code != null) parts.push(`exit=${e.exit_code}`)
    if (e.pid != null) parts.push(`pid=${e.pid}`)
    if (e.stdout_size) parts.push(`stdout ${e.stdout_size}B`)
    const meta = safeJsonParse<Record<string, unknown>>(e.metadata, {})
    if (meta.env && typeof meta.env === 'object') {
      const env = Object.entries(meta.env as Record<string, string>)
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
      if (env) parts.push(env)
    }
    const labels = safeJsonParse<Record<string, string>>(e.labels, {})
    const lstr = Object.entries(labels)
      .map(([k, v]) => `${k}=${v}`)
      .join(',')
    if (lstr) parts.push(lstr)
    return parts.join(' · ')
  }

  // Honour an incoming deep-link prefill exactly once per (p,o).
  $effect(() => {
    if (!prefill) return
    const key = `${prefill.partition}:${prefill.offset}`
    if (key === lastRun) return
    lastRun = key
    runTrace(prefill.partition, prefill.offset)
  })

  onMount(async () => {
    try {
      labelKeys = await api.debugLabelKeys()
    } catch {
      labelKeys = []
    }
  })
</script>

<div class="bar">
  <input
    placeholder="e.g. 5:42"
    bind:value={inputVal}
    onkeydown={(e) => e.key === 'Enter' && onTraceClick()}
  />
  <button onclick={onTraceClick}>Trace</button>
  <span class="muted">{statusMsg}</span>
</div>

{#if labelKeys.length}
  <div class="labels">
    {#each labelKeys as k}
      <div class="label-row">
        <span class="label-name mono">{k}</span>
        <input
          placeholder="value"
          bind:value={labelVals[k]}
          onkeydown={(e) => e.key === 'Enter' && runLabelTrace(k, labelVals[k] ?? '')}
        />
        <button onclick={() => runLabelTrace(k, labelVals[k] ?? '')}>Trace</button>
      </div>
    {/each}
  </div>
{/if}

{#if results}
  {#if results.length === 0}
    <p class="muted">No events.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Time</th><th>Worker</th><th>Event</th><th>Task ID</th><th class="num">Duration</th><th>Details</th></tr>
      </thead>
      <tbody>
        {#each results as e (e.id)}
          <tr>
            <td class="muted nowrap" title={fmtTimeMs(e.ts)}>{fmtTimeMs(e.ts)}</td>
            <td class="mono">{e.worker_name}</td>
            <td><span style:color={eventColor(e.event)}>{e.event}</span></td>
            <td class="mono">
              {#if e.task_id}<a href={`/task/${encodeURIComponent(baseTaskId(e.task_id))}`} use:link>{e.task_id}</a>{/if}
            </td>
            <td class="num mono" style:color={e.duration != null ? durationColor(e.duration) : undefined}>{e.duration != null ? dur3(e.duration) : ''}</td>
            <td class="details">
              {details(e)}
              {#if e.offset != null && e.partition != null}<KafkaIcon partition={e.partition} offset={e.offset} />{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
  }
  .bar input {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.35rem 0.55rem;
    min-width: 10rem;
  }
  .labels {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-bottom: 1rem;
    max-width: 32rem;
  }
  .label-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .label-name {
    min-width: 8rem;
    color: var(--muted);
    font-size: 0.82rem;
  }
  .label-row input {
    flex: 1;
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.25rem 0.5rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .details {
    font-size: 0.8rem;
    color: var(--muted);
    max-width: 30rem;
  }
</style>
