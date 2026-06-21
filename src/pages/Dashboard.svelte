<script lang="ts">
  // Dashboard: worker-at-a-glance (ports dashboard.html). Two stat rows, the
  // assigned-partition tiles, the optional WebApp tile, and — when the payload
  // carries the optional `links` key (key presence = feature flag) — the
  // Prometheus stat-tile deep links plus the Prometheus/Cluster/custom-link
  // sections. Backends without Prometheus/custom links omit `links` entirely
  // and none of those sections render.
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

<!-- Tiny external-link arrow shown next to a stat-tile label when the backend
     provides a Prometheus URL for it (ports the reference's `prom_icon` macro:
     14px stroke svg, 40% opacity, full opacity on hover, inherits the gray
     label color via currentColor). -->
{#snippet promIcon(url: string, title: string)}
  <a class="promicon" href={url} target="_blank" rel="noopener" {title}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
  </a>
{/snippet}

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

  <!-- Prometheus link sections. Mirrors the reference nesting: the cluster-wide
       card only renders when the per-worker grid does; custom links render
       independently. -->
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

      <!-- Cluster links are flat [name, url] pairs rendered as one wrap-list
           card (dashboard.html:93-102), unlike the categorized worker grid. -->
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
  .ptile {
    min-width: 3.5rem;
    text-align: center;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--accent);
    font-family: var(--mono);
    font-weight: 600;
    text-decoration: none;
  }
  .ptile:hover {
    border-color: var(--accent);
    background: var(--panel-2);
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
