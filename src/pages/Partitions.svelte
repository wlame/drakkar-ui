<script lang="ts">
  // Partitions list (ports partitions.html): per-partition offsets/lag/throughput,
  // plus the optional WebApp tile. The "Committed" column shows the live Kafka
  // committed offset; lag is color-coded. The WebApp tile rides on /api/v1/dashboard
  // (same object the reference passes to both templates), fetched best-effort.
  import { onMount } from 'svelte'
  import { api, type Partition, type WebappTile as WebappTileData } from '../lib/api'
  import { link } from '../lib/router'
  import { fmtTime, fmtTimeMs } from '../lib/format'
  import { COLOR } from '../lib/events'
  import WebappTile from '../components/WebappTile.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  let rows = $state<Partition[] | null>(null)
  let error = $state<string | null>(null)
  let webappTile = $state<WebappTileData | null>(null)

  async function load() {
    error = null
    try {
      rows = await api.partitions()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // Lag thresholds for the per-partition table: > 20 red, > 5 amber, else green.
  function lagColor(lag: number): string {
    if (lag > 20) return COLOR.red
    if (lag > 5) return COLOR.amber
    return COLOR.emerald
  }

  onMount(() => {
    load()
    // WebApp tile is best-effort chrome; absence (or webapp disabled) just hides it.
    api
      .dashboard()
      .then((d) => (webappTile = d.webapp_tile ?? null))
      .catch(() => {})
  })
</script>

<h1>Partitions</h1>

{#if webappTile}
  <div class="tile-wrap"><WebappTile tile={webappTile} variant="wide" /></div>
{/if}

{#if error}
  <p class="error">Could not load partitions: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !rows}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No partition data recorded yet.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Partition</th>
        <th>Status</th>
        <th>Last Consumed</th>
        <th>Last Committed</th>
        <th class="num">Committed</th>
        <th class="num">High WM</th>
        <th class="num">Lag</th>
        <th class="num">Queue</th>
        <th class="num">Pending</th>
        <th class="num">Consumed</th>
        <th class="num">Completed</th>
        <th class="num">Failed</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as p (p.partition)}
        <tr>
          <td class="mono"><a class="pid" href={`/partitions/${p.partition}`} use:link>{p.partition}</a></td>
          <td>
            <span class="dot" class:live={p.is_live}></span>
            <span class="muted">{p.is_live ? 'live' : 'history'}</span>
          </td>
          <!-- Reference leaves missing timestamps blank and prints "-" only for
               null offsets (0 is a real offset, keep it). -->
          <td class="muted nowrap" title={fmtTimeMs(p.last_consumed)}>{fmtTime(p.last_consumed)}</td>
          <td class="muted nowrap" title={fmtTimeMs(p.last_committed)}>{fmtTime(p.last_committed)}</td>
          <td class="num mono">{p.committed_offset ?? '-'}</td>
          <td class="num mono">{p.high_watermark ?? '-'}</td>
          <td class="num mono" style:color={lagColor(p.lag)}>{p.lag}</td>
          <td class="num mono">{p.queue_size}</td>
          <td class="num mono">{p.pending_offsets}</td>
          <td class="num mono">{p.consumed_count}</td>
          <td class="num mono" style:color={COLOR.emerald}>{p.completed_count}</td>
          <td class="num mono" style:color={p.failed_count > 0 ? COLOR.red : undefined}>{p.failed_count}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .tile-wrap {
    margin-bottom: 1.25rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--muted);
    margin-right: 0.35rem;
    vertical-align: middle;
  }
  .dot.live {
    background: #059669;
  }
  .pid {
    color: var(--accent);
  }
  .pid:hover {
    text-decoration: underline;
  }
</style>
