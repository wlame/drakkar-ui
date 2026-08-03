<script lang="ts">
  // Worker-at-a-glance. This page owns every request it needs and drives them
  // from one tick, so the three endpoints never land in the same tick — each
  // request costs the worker a main-loop dispatch, and a repeating burst of
  // three is a cost the worker feels forever once the intervals align.
  import { onMount } from 'svelte'
  import { api, type Dashboard, type Partition, type SinkStatus } from '../lib/api'
  import { fmtUptime } from '../lib/format'
  import { COLOR } from '../lib/events'
  import { pausableInterval } from '../lib/visibility'
  import { dueJobs, type PollJob } from '../lib/schedule'
  import WebappTile from '../components/WebappTile.svelte'
  import PartitionsTable from '../components/dashboard/PartitionsTable.svelte'
  import SinksTable from '../components/dashboard/SinksTable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  const POLL_TICK_MS = 500

  // Offsets are chosen so no two jobs ever share a tick: sinks always lands on
  // an even tick, dashboard on ticks ≡ 1 (mod 10), partitions on ≡ 3 (mod 10).
  // A job added later must keep that property — for example everyTicks 10 with
  // offsetTicks 5.
  const JOBS: PollJob[] = [
    { name: 'sinks', everyTicks: 4, offsetTicks: 0 },
    { name: 'dashboard', everyTicks: 10, offsetTicks: 1 },
    { name: 'partitions', everyTicks: 10, offsetTicks: 3 },
  ]

  let data = $state<Dashboard | null>(null)
  let dataError = $state<string | null>(null)
  let partitions = $state<Partition[] | null>(null)
  let partitionsError = $state<string | null>(null)
  let sinks = $state<SinkStatus[] | null>(null)
  let sinksError = $state<string | null>(null)

  // Each loader keeps the last good value on a transient failure and reports an
  // error only before its first success. One dead endpoint therefore costs its
  // own section, not the whole page.
  async function loadDashboard() {
    try {
      data = await api.dashboard()
      dataError = null
    } catch (e) {
      if (data === null) dataError = e instanceof Error ? e.message : String(e)
    }
  }

  async function loadPartitions() {
    try {
      partitions = await api.partitions()
      partitionsError = null
    } catch (e) {
      if (partitions === null) partitionsError = e instanceof Error ? e.message : String(e)
    }
  }

  async function loadSinks() {
    try {
      sinks = await api.sinks()
      sinksError = null
    } catch (e) {
      if (sinks === null) sinksError = e instanceof Error ? e.message : String(e)
    }
  }

  const LOADERS: Record<string, () => Promise<void>> = {
    dashboard: loadDashboard,
    partitions: loadPartitions,
    sinks: loadSinks,
  }

  function reloadAll() {
    for (const load of Object.values(LOADERS)) void load()
  }

  // Consumer-lag thresholds for the whole-worker tile: > 100 red, > 20 amber.
  function lagColor(lag: number): string {
    if (lag > 100) return COLOR.red
    if (lag > 20) return COLOR.amber
    return COLOR.emerald
  }

  onMount(() => {
    // Fill the page at once, then let the scheduler take over the cadence.
    reloadAll()
    let tick = 0
    return pausableInterval(() => {
      tick += 1
      for (const name of dueJobs(JOBS, tick)) void LOADERS[name]()
    }, POLL_TICK_MS)
  })
</script>

<h1>Dashboard</h1>

<!-- Tiny external-link arrow shown next to a stat-tile label when the backend
     provides a Prometheus URL for it. -->
{#snippet promIcon(url: string, title: string)}
  <a class="promicon" href={url} target="_blank" rel="noopener" {title}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
  </a>
{/snippet}

{#if dataError}
  <p class="error">Could not reach the backend: <code>{dataError}</code></p>
  <button onclick={loadDashboard}>Retry</button>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  <!-- Primary stats -->
  <div class="tiles">
    <div class="tile"><span class="k">Uptime</span><span class="v">{fmtUptime(data.uptime)}</span></div>
    <div class="tile"><span class="k">Partitions</span><span class="v">{data.partition_count}</span></div>
    <div class="tile"><span class="k">Executor Pool</span><span class="v">{data.pool_active} / {data.pool_max}</span></div>
    <div class="tile"><span class="k">Total Events</span><span class="v">{data.stats.total_events ?? 0}</span></div>
    <div class="tile"><span class="k">Consumer Lag{#if data.links?.card_links.lag}{@render promIcon(data.links.card_links.lag, 'View in Prometheus')}{/if}</span><span class="v" style:color={lagColor(data.total_lag)}>{data.total_lag}</span></div>
  </div>

  <!-- Secondary stats -->
  <div class="tiles secondary">
    <div class="tile"><span class="k">Consumed{#if data.links?.card_links.consumed}{@render promIcon(data.links.card_links.consumed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.blue}>{data.stats.consumed ?? 0}</span></div>
    <div class="tile"><span class="k">Completed{#if data.links?.card_links.completed}{@render promIcon(data.links.card_links.completed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.emerald}>{data.stats.completed ?? 0}</span></div>
    <div class="tile"><span class="k">Failed{#if data.links?.card_links.failed}{@render promIcon(data.links.card_links.failed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.red}>{data.stats.failed ?? 0}</span></div>
    <div class="tile"><span class="k">Produced{#if data.links?.card_links.produced}{@render promIcon(data.links.card_links.produced, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.purple}>{data.stats.produced ?? 0}</span></div>
  </div>

  <!-- WebApp sits above the partition tiles: it is a second ingress into the
       same pipeline, not one of the partitions. -->
  {#if data.webapp_tile}
    <div class="tile-wrap"><WebappTile tile={data.webapp_tile} variant="wide" /></div>
  {/if}

  <h2>Assigned Partitions</h2>
  <div class="partitions">
    {#if data.partitions.length === 0}
      <p class="muted">No partitions assigned</p>
    {:else}
      {#each data.partitions as pid}
        <span class="ptile">P{pid}</span>
      {/each}
    {/if}
  </div>

  <!-- Prometheus link sections. The cluster-wide card only renders when the
       per-worker grid does; custom links render independently. -->
  {#if data.links}
    {#if data.links.worker_links.length > 0}
      <h2>Prometheus Metrics</h2>
      <div class="promgrid">
        {#each data.links.worker_links as group}
          <div class="promcard">
            <div class="cat">{group.category}</div>
            <ul>
              {#each group.links as [name, url]}
                <li><a class="promlink" href={url} target="_blank" rel="noopener">{name}</a></li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>

      {#if data.links.cluster_links.length > 0}
        <h2>Cluster-wide Metrics</h2>
        <div class="linkcard">
          <ul>
            {#each data.links.cluster_links as [name, url]}
              <li><a class="promlink" href={url} target="_blank" rel="noopener">{name}</a></li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}

    {#if data.links.custom_links.length > 0}
      <h2>Links</h2>
      <div class="linkcard">
        <ul>
          {#each data.links.custom_links as link}
            <li><a class="promlink" href={link.url} target="_blank" rel="noopener">{link.name}</a></li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
{/if}

<!-- The two tables sit outside the `data` guard: a failing /dashboard request
     must not hide partition and sink health, which come from other endpoints. -->
<h2>Partitions</h2>
<PartitionsTable rows={partitions} error={partitionsError} />

<h2>Sinks</h2>
<SinksTable rows={sinks} error={sinksError} />

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .tiles.secondary {
    margin-bottom: 1.5rem;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
  }
  .tile .k {
    font-size: 0.8rem;
    color: var(--muted);
  }
  /* Reference stat values are text-2xl font-mono (normal weight); the
     secondary row steps down to text-xl. */
  .tile .v {
    font-size: 1.5rem;
    font-weight: 400;
    font-family: var(--mono);
  }
  .secondary .tile .v {
    font-size: 1.25rem;
  }
  .partitions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .tile-wrap {
    margin: 1.25rem 0;
  }
  .ptile {
    display: inline-block;
    min-width: 3.5rem;
    text-align: center;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    font-family: var(--mono);
    font-weight: 600;
  }

  /* Stat-tile Prometheus deep link — reference: `inline -mt-0.5 ml-1 opacity-40
     hover:opacity-100`, inheriting the gray label color via currentColor. */
  .promicon {
    display: inline-block;
    margin-left: 0.25rem;
    vertical-align: -2px;
    color: inherit;
    opacity: 0.4;
  }
  .promicon:hover {
    opacity: 1;
  }

  /* Prometheus link grid — reference: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4
     gap-4 mb-6`, white cards with the cream border. */
  .promgrid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  @media (min-width: 768px) {
    .promgrid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (min-width: 1024px) {
    .promgrid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
  .promcard,
  .linkcard {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 1rem;
  }
  .linkcard {
    margin-bottom: 1.5rem;
  }
  /* Category header — reference: text-sm font-semibold text-gray-500 mb-2. */
  .promcard .cat {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .promcard ul,
  .linkcard ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* space-y-1 between stacked links. */
  .promcard li + li {
    margin-top: 0.25rem;
  }
  /* Custom-links card lays its entries out inline — reference:
     `flex flex-wrap gap-x-6 gap-y-1`. */
  .linkcard ul {
    display: flex;
    flex-wrap: wrap;
    column-gap: 1.5rem;
    row-gap: 0.25rem;
  }
  /* Link style — reference: text-sm text-blue-600 hover:text-blue-800
     hover:underline (blue-800 = #1e40af). */
  .promlink {
    font-size: 0.875rem;
    color: var(--link);
  }
  .promlink:hover {
    color: #1e40af;
    text-decoration: underline;
  }
</style>
