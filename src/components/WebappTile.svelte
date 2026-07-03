<script lang="ts">
  // The optional WebApp summary tile. Two layouts mirror the reference: a compact
  // vertical card on the Dashboard (default) and a wide 5-column grid on the
  // Partitions page (variant="wide", ports partitions.html).
  import type { WebappTile } from '../lib/api'
  import { COLOR } from '../lib/events'

  let { tile, variant = 'compact' }: { tile: WebappTile; variant?: 'compact' | 'wide' } = $props()
</script>

{#if variant === 'wide'}
  <div class="webapp wide">
    <div class="row head">
      <span class="title">WebApp</span>
      <span class="muted mono">{tile.host}:{tile.port}{tile.path}</span>
    </div>
    <div class="grid">
      <div class="cell"><span class="k">In-flight</span><span class="v mono">{tile.inflight_count}</span></div>
      <div class="cell"><span class="k">Success (60s)</span><span class="v mono" style:color={COLOR.emerald}>{tile.success_60s}</span></div>
      <div class="cell"><span class="k">Errors (60s)</span><span class="v mono" style:color={COLOR.red}>{tile.error_60s}</span></div>
      <div class="cell"><span class="k">Rejected (60s)</span><span class="v mono" style:color={COLOR.amber}>{tile.rejected_60s}</span></div>
      <div class="cell">
        <span class="k">Clients</span>
        <ul class="clients-inline mono">
          {#each tile.clients as c}<li>{c.name} <span class="muted">({c.rpm_limit} rpm)</span></li>{/each}
        </ul>
      </div>
    </div>
  </div>
{:else}
  <!-- Dashboard variant: the reference shows no host line here; labels are
       xs gray with only the numbers colored/mono. -->
  <div class="webapp">
    <div class="row head">
      <span class="title">WebApp</span>
    </div>
    <div class="row">In-flight: <span class="mono ink">{tile.inflight_count}</span></div>
    <div class="row">
      Last 60s:
      <span class="mono" style:color={COLOR.emerald}>{tile.success_60s}</span> ok /
      <span class="mono" style:color={COLOR.red}>{tile.error_60s}</span> err /
      <span class="mono" style:color={COLOR.amber}>{tile.rejected_60s}</span> rejected
    </div>
    {#if tile.clients.length}
      <div class="row">Clients:</div>
      <ul class="clients mono">
        {#each tile.clients as c}<li>{c.name} <span class="muted">({c.rpm_limit} rpm)</span></li>{/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .webapp {
    min-width: 14rem;
    padding: 0.75rem 1rem;
    border: 1px solid rgba(147, 51, 234, 0.35);
    border-radius: 10px;
    background: var(--panel);
    font-size: 0.85rem;
  }
  .webapp.wide {
    width: 100%;
    padding: 1rem;
  }
  .row {
    margin: 0.15rem 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .ink {
    color: var(--text);
  }
  .row.head {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: baseline;
    margin-bottom: 0.4rem;
  }
  .title {
    color: var(--purple);
    font-weight: 700;
    font-family: var(--mono);
    font-size: 1.125rem;
  }
  .head .mono {
    font-size: 0.72rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 1rem;
    margin-top: 0.5rem;
  }
  .cell {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .cell .k {
    font-size: 0.72rem;
    color: var(--muted);
  }
  .cell .v {
    font-size: 1.125rem;
  }
  .clients-inline {
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 0.85rem;
  }
  .clients {
    margin: 0.2rem 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.75rem;
    color: var(--text);
  }
  @media (max-width: 720px) {
    .grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
