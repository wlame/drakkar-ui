<script lang="ts">
  // The optional WebApp summary tile, shared by the Dashboard and Partitions pages
  // (the reference passes the same webapp_tile object to both templates).
  import type { WebappTile } from '../lib/api'
  import { COLOR } from '../lib/events'

  let { tile }: { tile: WebappTile } = $props()
</script>

<div class="webapp">
  <div class="row head">
    <span class="title">WebApp</span>
    <span class="muted mono">{tile.host}:{tile.port}{tile.path}</span>
  </div>
  <div class="row">In-flight: <span class="mono">{tile.inflight_count}</span></div>
  <div class="row">
    Last 60s:
    <span style:color={COLOR.emerald}>{tile.success_60s} ok</span> /
    <span style:color={COLOR.red}>{tile.error_60s} err</span> /
    <span style:color={COLOR.amber}>{tile.rejected_60s} rejected</span>
  </div>
  {#if tile.clients.length}
    <div class="row muted">Clients:</div>
    <ul class="clients">
      {#each tile.clients as c}<li>{c.name} ({c.rpm_limit} rpm)</li>{/each}
    </ul>
  {/if}
</div>

<style>
  .webapp {
    min-width: 14rem;
    padding: 0.75rem 1rem;
    border: 1px solid rgba(192, 132, 252, 0.4);
    border-radius: 10px;
    background: var(--panel);
    font-size: 0.85rem;
  }
  .row {
    margin: 0.15rem 0;
  }
  .row.head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: baseline;
    margin-bottom: 0.4rem;
  }
  .title {
    color: var(--link);
    font-weight: 700;
  }
  .head .mono {
    font-size: 0.72rem;
  }
  .clients {
    margin: 0.2rem 0 0;
    padding-left: 1.1rem;
    color: var(--muted);
  }
</style>
