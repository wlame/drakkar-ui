<script lang="ts">
  // Arrange tab: recent arrange() calls with per-batch task-status rollups, plus a
  // detail sidebar showing the batch's messages and tasks. Task statuses come from
  // the arrange-task-states map the Live page keeps fresh via
  // POST /api/v1/live/arrange-tasks.
  import { link } from '../../lib/router'
  import { fmtTimeMs, dur3 } from '../../lib/format'
  import { durationColor } from '../../lib/events'
  import { baseTaskId, type ArrangeView } from '../../lib/live'
  import type { ArrangeTaskState } from '../../lib/api'
  import KafkaIcon from '../KafkaIcon.svelte'

  let {
    arranges = [],
    states = {},
  }: { arranges?: ArrangeView[]; states?: Record<string, ArrangeTaskState> } = $props()

  const STUCK_SEC = 30

  let partitionFilter = $state<number | 'all'>('all')
  let searchTerm = $state('')
  let issuesOnly = $state(false)
  let openIdx = $state<number | null>(null)

  interface Counts {
    done: number
    running: number
    failed: number
    unknown: number
    total: number
  }
  function counts(a: ArrangeView): Counts {
    let done = 0
    let running = 0
    let failed = 0
    let unknown = 0
    for (const id of a.task_ids) {
      const s = states[id]?.status ?? 'unknown'
      if (s === 'completed') done++
      else if (s === 'running') running++
      else if (s === 'failed') failed++
      else unknown++
    }
    return { done, running, failed, unknown, total: a.task_ids.length }
  }

  function isIssue(a: ArrangeView): boolean {
    const c = counts(a)
    if (c.failed > 0) return true
    const nowSec = Date.now() / 1000
    for (const id of a.task_ids) {
      const s = states[id]
      if (s?.status === 'running' && s.start_ts != null && nowSec - s.start_ts > STUCK_SEC) return true
    }
    return false
  }

  const partitionOptions = $derived(
    [...new Set(arranges.map((a) => a.partition))].sort((x, y) => x - y),
  )

  const filtered = $derived(
    arranges.filter((a) => {
      if (partitionFilter !== 'all' && a.partition !== partitionFilter) return false
      if (issuesOnly && !isIssue(a)) return false
      if (searchTerm) {
        const t = searchTerm.toLowerCase()
        const hay = `${a.message_labels.join(' ')} ${a.offsets.join(' ')} ${a.task_ids.join(' ')}`.toLowerCase()
        if (!hay.includes(t)) return false
      }
      return true
    }),
  )

  const selected = $derived(openIdx != null ? (filtered[openIdx] ?? null) : null)

  function labelSummary(a: ArrangeView): string {
    const first = a.message_labels.slice(0, 3).join(', ')
    return a.message_labels.length > 3 ? `${first} … (${a.message_labels.length})` : first
  }

  function statusColorOf(id: string): string {
    const s = states[id]?.status
    if (s === 'completed') return '#34d399'
    if (s === 'failed') return '#f87171'
    if (s === 'running') return '#fbbf24'
    return '#8b93ad'
  }
</script>

<div class="bar">
  <select bind:value={partitionFilter}>
    <option value="all">All partitions</option>
    {#each partitionOptions as p}<option value={p}>P{p}</option>{/each}
  </select>
  <input placeholder="search labels / offsets / task id" bind:value={searchTerm} />
  <label><input type="checkbox" bind:checked={issuesOnly} /> Issues only</label>
  <span class="muted count">{filtered.length} of {arranges.length}</span>
</div>

{#if filtered.length === 0}
  <p class="muted">{arranges.length === 0 ? 'No arrange() calls yet.' : 'No batches match the current filter.'}</p>
{:else}
  <table>
    <thead>
      <tr><th class="num">Partition</th><th class="num">Msgs</th><th>Tasks</th><th class="num">Arrange</th><th>Time</th><th>Labels</th></tr>
    </thead>
    <tbody>
      {#each filtered as a, i (`${a.ts}:${a.partition}`)}
        {@const c = counts(a)}
        <tr class="clickable" class:sel={openIdx === i} onclick={() => (openIdx = i)}>
          <td class="num mono"><a href={`/partitions/${a.partition}`} use:link onclick={(e) => e.stopPropagation()}>{a.partition}</a></td>
          <td class="num mono">{a.message_count}</td>
          <td class="mono">
            {#if c.done}<span style:color="#34d399">{c.done}</span>{/if}
            {#if c.running}<span style:color="#fbbf24"> {c.running}</span>{/if}
            {#if c.failed}<span style:color="#f87171"> {c.failed}</span>{/if}
            {#if c.unknown}<span class="muted"> {c.unknown}</span>{/if}
            <span class="muted"> / {c.total}</span>
          </td>
          <td class="num mono" style:color={durationColor(a.duration)}>{dur3(a.duration)}</td>
          <td class="muted nowrap">{fmtTimeMs(a.ts)}</td>
          <td class="muted">{labelSummary(a)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

{#if selected}
  <div class="sidebar">
    <div class="sb-head">
      <span>Partition {selected.partition} · {fmtTimeMs(selected.ts)}</span>
      <button class="x" onclick={() => (openIdx = null)} aria-label="Close">×</button>
    </div>
    <div class="sb-summary">
      <span>{selected.message_count} msgs</span>
      <span>{selected.task_count} tasks</span>
      <span style:color={durationColor(selected.duration)}>{dur3(selected.duration)}</span>
    </div>

    {#if selected.offsets.length}
      <h3>Messages</h3>
      <div class="chips">
        {#each selected.offsets as off}
          <span class="chip">
            <a href={`/debug#trace/${selected.partition}/${off}`} use:link>{selected.partition}:{off}</a>
            <KafkaIcon partition={selected.partition} offset={off} />
          </span>
        {/each}
      </div>
    {/if}

    {#if selected.task_ids.length}
      <h3>Tasks</h3>
      <ul class="tasks">
        {#each selected.task_ids as id}
          {@const s = states[id]}
          <li>
            <span class="dot" style:background={statusColorOf(id)}></span>
            <a class="mono" href={`/task/${encodeURIComponent(baseTaskId(id))}`} use:link>{id}</a>
            <span class="muted">{s?.status ?? 'unknown'}</span>
            {#if s?.duration != null}<span class="muted mono">{dur3(s.duration)}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .bar input:not([type]) {
    flex: 1;
    min-width: 12rem;
  }
  .bar input,
  .bar select {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .bar label {
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
    font-size: 0.85rem;
  }
  .bar .count {
    margin-left: auto;
    font-size: 0.85rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  tr.clickable {
    cursor: pointer;
  }
  tr.clickable:hover td,
  tr.sel td {
    background: var(--panel-2);
  }
  .sidebar {
    position: fixed;
    top: 3.25rem;
    right: 0;
    width: 24rem;
    max-width: 92vw;
    height: calc(100vh - 3.25rem);
    background: var(--panel-2);
    border-left: 1px solid var(--line);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4);
    padding: 1rem;
    overflow: auto;
    z-index: 40;
  }
  .sb-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  .sb-head .x {
    padding: 0.1rem 0.5rem;
  }
  .sb-summary {
    display: flex;
    gap: 1rem;
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }
  h3 {
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 1rem 0 0.4rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    font-family: var(--mono);
    font-size: 0.78rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.15rem 0.45rem;
    background: var(--panel);
  }
  .tasks {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .tasks li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.82rem;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    flex: none;
  }
</style>
