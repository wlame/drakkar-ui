<script lang="ts">
  // Event History: a filterable, newest-first feed of recorded events (ports
  // history.html). Filters — partition toggles, event-type checkboxes, origin —
  // each trigger a fresh fetch (the reference clears + refetches on every change).
  //
  // Three reference bugs are fixed here: (1) the event-type filter is sent whenever
  // the selection differs from the full set (the reference used a stale "< 8 of 10"
  // threshold, so it silently no-opped); (2) the origin filter is actually
  // forwarded to the query (the reference wired the radios but never sent origin);
  // (3) explicit empty + error states (the reference had neither and no try/catch).
  import { onMount } from 'svelte'
  import { api, type EventRow } from '../lib/api'
  import { link } from '../lib/router'
  import { runtimeConfig } from '../lib/config'
  import { fmtTime, fmtTimeMs, dur2 } from '../lib/format'
  import { eventColor, EVENT_TYPES } from '../lib/events'
  import KafkaIcon from '../components/KafkaIcon.svelte'
  import Expandable from '../components/Expandable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  const ORIGINS = ['all', 'kafka', 'http'] as const
  type Origin = (typeof ORIGINS)[number]

  let dashboardPartitions = $state<number[]>([])
  let selected = $state<Set<number>>(new Set())
  let typeChecked = $state<Record<string, boolean>>(
    Object.fromEntries(EVENT_TYPES.map((t) => [t, true])),
  )
  let origin = $state<Origin>('all')

  let rows = $state<EventRow[] | null>(null)
  let error = $state<string | null>(null)
  let reqId = 0

  // The partition toggle set = configured partitions ∪ any seen in the feed.
  const allPartitions = $derived.by<number[]>(() => {
    const set = new Set<number>(dashboardPartitions)
    for (const e of rows ?? []) if (e.partition != null && e.partition >= 0) set.add(e.partition)
    return [...set].sort((a, b) => a - b)
  })

  async function load() {
    const myReq = ++reqId
    error = null
    rows = null
    const checked = EVENT_TYPES.filter((t) => typeChecked[t])
    try {
      const r = await api.events({
        limit: $runtimeConfig.maxUiRows,
        after_id: 0,
        // Only constrain when the selection isn't the full set (fixes the stale threshold).
        event_types: checked.length === EVENT_TYPES.length ? undefined : checked.join(','),
        partitions: selected.size ? [...selected].sort((a, b) => a - b).join(',') : undefined,
        origin: origin === 'all' ? undefined : origin,
      })
      if (myReq === reqId) rows = r
    } catch (e) {
      if (myReq === reqId) error = e instanceof Error ? e.message : String(e)
    }
  }

  function togglePartition(p: number) {
    const next = new Set(selected)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    selected = next
    load()
  }

  function reset() {
    selected = new Set()
    typeChecked = Object.fromEntries(EVENT_TYPES.map((t) => [t, true]))
    // Reset leaves the origin radio as-is, matching the reference's resetAll().
    load()
  }

  onMount(async () => {
    try {
      const d = await api.dashboard()
      dashboardPartitions = d.partitions ?? []
    } catch {
      // Partition seed is best-effort; the feed still works without it.
    }
    load()
  })
</script>

<h1>Event History</h1>

<!-- Partition filter -->
<div class="filter">
  <span class="label">Partitions (click to toggle)</span>
  <div class="toggles">
    {#if allPartitions.length === 0}
      <span class="muted">—</span>
    {:else}
      {#each allPartitions as p}
        <button class="toggle" class:on={selected.has(p)} onclick={() => togglePartition(p)}>{p}</button>
      {/each}
    {/if}
  </div>
</div>

<!-- Event-type filter -->
<div class="filter">
  <span class="label">Event types</span>
  <div class="checks">
    {#each EVENT_TYPES as t}
      <label style:color={eventColor(t)}>
        <input type="checkbox" bind:checked={typeChecked[t]} onchange={load} />
        {t}
      </label>
    {/each}
  </div>
</div>

<!-- Origin filter -->
<div class="filter">
  <span class="label">Origin</span>
  <div class="checks">
    {#each ORIGINS as o}
      <label>
        <input type="radio" name="origin" value={o} bind:group={origin} onchange={load} />
        {o}
      </label>
    {/each}
  </div>
</div>

<div class="actions">
  <button class="primary" onclick={load}>Apply</button>
  <button onclick={reset}>Reset</button>
  <span class="muted count">{rows ? `${rows.length} rows` : ''}</span>
</div>

{#if error}
  <p class="error">Could not load events: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !rows}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No events match the current filters.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Event</th>
        <th class="num">Partition</th>
        <th class="num">Offset</th>
        <th>Task ID</th>
        <th class="num">Duration</th>
        <th class="num">Exit</th>
        <th>Args / Metadata</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as e (e.id)}
        <tr>
          <td class="muted nowrap" title={fmtTimeMs(e.ts)}>{fmtTime(e.ts)}</td>
          <td><span class="evt" style:color={eventColor(e.event)}>{e.event}</span></td>
          <td class="num mono">
            {#if e.partition != null && e.partition >= 0}
              <a href={`/partitions/${e.partition}`} use:link>{e.partition}</a>
            {:else if e.partition != null}{e.partition}{/if}
          </td>
          <td class="num mono">
            {#if e.offset != null && e.partition != null && e.partition >= 0}
              <a href={`/debug#trace/${e.partition}/${e.offset}`} use:link>{e.offset}</a>
              <KafkaIcon partition={e.partition} offset={e.offset} />
            {:else if e.offset != null}{e.offset}{/if}
          </td>
          <td class="mono">
            {#if e.task_id}<a href={`/task/${encodeURIComponent(e.task_id)}`} use:link>{e.task_id}</a>{/if}
          </td>
          <td class="num mono">{e.duration != null ? dur2(e.duration) : ''}</td>
          <td class="num mono" class:err={e.exit_code != null && e.exit_code !== 0}>{e.exit_code ?? ''}</td>
          <td>{#if e.args || e.metadata}<Expandable text={e.args ?? e.metadata ?? ''} />{/if}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .filter {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin: 0.6rem 0;
    flex-wrap: wrap;
  }
  .filter .label {
    font-size: 0.75rem;
    color: var(--muted);
    min-width: 9rem;
  }
  .toggles,
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem 0.9rem;
    align-items: center;
  }
  .toggle {
    padding: 0.2rem 0.55rem;
    font-family: var(--mono);
    font-size: 0.8rem;
    background: var(--panel);
  }
  .toggle.on {
    background: #0d9488;
    border-color: #0d9488;
    color: #fff;
  }
  .checks label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin: 0.9rem 0 1.1rem;
  }
  .actions .primary {
    background: #0d9488;
    border-color: #0d9488;
    color: #fff;
  }
  .actions .count {
    margin-left: auto;
    font-size: 0.85rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .evt {
    font-weight: 600;
  }
  td.err {
    color: var(--error);
  }
</style>
