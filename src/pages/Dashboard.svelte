<script lang="ts">
  // Dashboard: worker-at-a-glance (ports dashboard.html). Two stat rows, the
  // assigned-partition tiles, and the optional WebApp tile. The reference also
  // renders Prometheus/custom-link sections, but those come from HTML-only template
  // context (not the /api/v1/dashboard JSON), so they're intentionally omitted
  // until the contract surfaces them.
  import { onMount } from 'svelte'
  import { api, type Dashboard } from '../lib/api'
  import { link } from '../lib/router'
  import { fmtUptime } from '../lib/format'
  import { COLOR } from '../lib/events'
  import WebappTile from '../components/WebappTile.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  let data = $state<Dashboard | null>(null)
  let error = $state<string | null>(null)

  async function load() {
    error = null
    try {
      data = await api.dashboard()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // Consumer-lag thresholds match the reference: > 100 red, > 20 amber, else green.
  function lagColor(lag: number): string {
    if (lag > 100) return COLOR.red
    if (lag > 20) return COLOR.amber
    return COLOR.emerald
  }

  onMount(load)
</script>

<h1>Dashboard</h1>

{#if error}
  <p class="error">Could not reach the backend: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  <!-- Primary stats -->
  <div class="tiles">
    <div class="tile"><span class="k">Uptime</span><span class="v">{fmtUptime(data.uptime)}</span></div>
    <div class="tile"><span class="k">Partitions</span><span class="v">{data.partition_count}</span></div>
    <div class="tile"><span class="k">Executor Pool</span><span class="v">{data.pool_active}/{data.pool_max}</span></div>
    <div class="tile"><span class="k">Total Events</span><span class="v">{data.stats.total_events ?? 0}</span></div>
    <div class="tile"><span class="k">Consumer Lag</span><span class="v" style:color={lagColor(data.total_lag)}>{data.total_lag}</span></div>
  </div>

  <!-- Secondary stats -->
  <div class="tiles secondary">
    <div class="tile"><span class="k">Consumed</span><span class="v" style:color={COLOR.blue}>{data.stats.consumed ?? 0}</span></div>
    <div class="tile"><span class="k">Completed</span><span class="v" style:color={COLOR.emerald}>{data.stats.completed ?? 0}</span></div>
    <div class="tile"><span class="k">Failed</span><span class="v" style:color={COLOR.red}>{data.stats.failed ?? 0}</span></div>
    <div class="tile"><span class="k">Produced</span><span class="v" style:color={COLOR.purple}>{data.stats.produced ?? 0}</span></div>
  </div>

  <h2>Assigned Partitions</h2>
  <div class="partitions">
    {#if data.partitions.length === 0}
      <p class="muted">No partitions assigned</p>
    {:else}
      {#each data.partitions as pid}
        <a class="ptile" href={`/partitions/${pid}`} use:link>P{pid}</a>
      {/each}
    {/if}

    {#if data.webapp_tile}
      <WebappTile tile={data.webapp_tile} />
    {/if}
  </div>
{/if}

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
    border-radius: 10px;
    background: var(--panel);
  }
  .tile .k {
    font-size: 0.72rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .tile .v {
    font-size: 1.5rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .secondary .tile .v {
    font-size: 1.2rem;
  }
  .partitions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .ptile {
    min-width: 3.5rem;
    text-align: center;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: #2dd4bf;
    font-family: var(--mono);
    font-weight: 600;
    text-decoration: none;
  }
  .ptile:hover {
    border-color: var(--accent);
    background: var(--panel-2);
  }
</style>
