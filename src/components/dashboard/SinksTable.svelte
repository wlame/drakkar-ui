<script lang="ts">
  // Per-sink delivery counters, last delivery, and last error. Presentational:
  // the parent owns fetching and the poll cadence.
  import type { SinkStatus } from '../../lib/api'
  import { fmtTime, fmtTimeFull, dur3 } from '../../lib/format'
  import { COLOR } from '../../lib/events'
  import { NO_SORT, sortRows, type SortAccessor } from '../../lib/sort'
  import SortableTh from '../SortableTh.svelte'
  import Expandable from '../Expandable.svelte'

  let { rows, error = null }: { rows: SinkStatus[] | null; error?: string | null } = $props()

  let sort = $state(NO_SORT)
  const COLUMNS: { key: string; label: string; numeric: boolean }[] = [
    { key: 'sink_type', label: 'Type', numeric: false },
    { key: 'name', label: 'Name', numeric: false },
    { key: 'delivered_count', label: 'Deliveries', numeric: true },
    { key: 'delivered_payloads', label: 'Payloads', numeric: true },
    { key: 'error_count', label: 'Errors', numeric: true },
    { key: 'retry_count', label: 'Retries', numeric: true },
    { key: 'last_delivery_ts', label: 'Last Delivery', numeric: false },
    { key: 'last_delivery_duration', label: 'Duration', numeric: true },
    { key: 'last_error', label: 'Last Error', numeric: false },
  ]
  const ACCESSORS: Record<string, SortAccessor<SinkStatus>> = {
    sink_type: (s) => s.sink_type,
    name: (s) => s.name,
    delivered_count: (s) => s.delivered_count,
    delivered_payloads: (s) => s.delivered_payloads,
    error_count: (s) => s.error_count,
    retry_count: (s) => s.retry_count,
    last_delivery_ts: (s) => s.last_delivery_ts,
    last_delivery_duration: (s) => s.last_delivery_duration,
    last_error: (s) => s.last_error,
  }
</script>

{#if error}
  <p class="error">Could not load sinks: <code>{error}</code></p>
{:else if !rows}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No sinks configured.</p>
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
      {#each sortRows(rows, sort, ACCESSORS) as s (`${s.sink_type}/${s.name}`)}
        <tr>
          <td class="mono">{s.sink_type}</td>
          <td class="mono name" style:color={COLOR.teal}>{s.name}</td>
          <td class="num mono" style:color={COLOR.emerald}>{s.delivered_count}</td>
          <td class="num mono">{s.delivered_payloads}</td>
          <td class="num mono" style:color={s.error_count > 0 ? COLOR.red : undefined}>{s.error_count}</td>
          <td class="num mono" style:color={s.retry_count > 0 ? COLOR.amber : undefined}>{s.retry_count}</td>
          <td class="muted nowrap" title={fmtTimeFull(s.last_delivery_ts)}>{fmtTime(s.last_delivery_ts) || '-'}</td>
          <td class="num mono">{s.last_delivery_duration != null ? dur3(s.last_delivery_duration) : '-'}</td>
          <td>
            {#if s.last_error}<Expandable text={s.last_error} color={COLOR.red} />{:else}<span class="muted">-</span>{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .nowrap {
    white-space: nowrap;
  }
  .name {
    font-weight: 600;
  }
</style>
