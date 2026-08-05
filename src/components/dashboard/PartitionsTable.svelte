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
  import { NO_SORT, sortRows, type SortAccessor } from '../../lib/sort'
  import SortableTh from '../SortableTh.svelte'

  let { rows, error = null }: { rows: Partition[] | null; error?: string | null } = $props()

  let sort = $state(NO_SORT)
  const COLUMNS: { key: string; label: string; numeric: boolean }[] = [
    { key: 'partition', label: 'Partition', numeric: false },
    { key: 'status', label: 'Status', numeric: false },
    { key: 'last_consumed', label: 'Last Consumed', numeric: false },
    { key: 'last_committed', label: 'Last Committed', numeric: false },
    { key: 'committed_offset', label: 'Committed', numeric: true },
    { key: 'high_watermark', label: 'High WM', numeric: true },
    { key: 'lag', label: 'Lag', numeric: true },
    { key: 'queue_size', label: 'Queue', numeric: true },
    { key: 'pending_offsets', label: 'Pending', numeric: true },
    { key: 'consumed_count', label: 'Consumed', numeric: true },
    { key: 'completed_count', label: 'Completed', numeric: true },
    { key: 'failed_count', label: 'Failed', numeric: true },
  ]
  const ACCESSORS: Record<string, SortAccessor<Partition>> = {
    partition: (p) => p.partition,
    status: (p) => (p.is_live ? 'live' : 'history'),
    last_consumed: (p) => p.last_consumed,
    last_committed: (p) => p.last_committed,
    committed_offset: (p) => p.committed_offset,
    high_watermark: (p) => p.high_watermark,
    lag: (p) => p.lag,
    queue_size: (p) => p.queue_size,
    pending_offsets: (p) => p.pending_offsets,
    consumed_count: (p) => p.consumed_count,
    completed_count: (p) => p.completed_count,
    failed_count: (p) => p.failed_count,
  }

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
        {#each COLUMNS as col (col.key)}
          <SortableTh bind:sort key={col.key} label={col.label} numeric={col.numeric} />
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sortRows(rows, sort, ACCESSORS) as p (p.partition)}
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
