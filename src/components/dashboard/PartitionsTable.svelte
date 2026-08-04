<script lang="ts">
  // Per-partition offsets, lag, and throughput. Presentational: the parent owns
  // fetching, so one poll scheduler can drive every table on the page.
  //
  // Partition ids are plain text, not links. Partition detail pages were removed
  // because an operator reads skew from this table as a whole; one partition in
  // isolation answered no question this table does not already answer.
  import type { Partition } from '../../lib/api'
  import { fmtTime, fmtTimeMs } from '../../lib/format'
  import { COLOR } from '../../lib/events'

  let { rows, error = null }: { rows: Partition[] | null; error?: string | null } = $props()

  // Stricter than the Dashboard's total-lag tile (> 100 red, > 20 amber) on
  // purpose: one partition sitting at lag 30 is a problem the cluster total hides.
  function lagColor(lag: number): string {
    if (lag > 20) return COLOR.red
    if (lag > 5) return COLOR.amber
    return COLOR.emerald
  }
</script>

{#if error}
  <p class="error">Could not load partitions: <code>{error}</code></p>
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
          <td class="mono">{p.partition}</td>
          <td>
            <span class="dot" class:live={p.is_live}></span>
            <span class="muted">{p.is_live ? 'live' : 'history'}</span>
          </td>
          <!-- Missing timestamps render blank; "-" is printed only for a null
               offset, since 0 is a real offset and must still read as 0. -->
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
</style>
