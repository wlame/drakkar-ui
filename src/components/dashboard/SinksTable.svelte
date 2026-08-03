<script lang="ts">
  // Per-sink delivery counters, last delivery, and last error. Presentational:
  // the parent owns fetching and the poll cadence.
  import type { SinkStatus } from '../../lib/api'
  import { fmtTime, fmtTimeFull, dur3 } from '../../lib/format'
  import { COLOR } from '../../lib/events'
  import Expandable from '../Expandable.svelte'

  let { rows, error = null }: { rows: SinkStatus[] | null; error?: string | null } = $props()
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
        <th>Type</th>
        <th>Name</th>
        <th class="num">Deliveries</th>
        <th class="num">Payloads</th>
        <th class="num">Errors</th>
        <th class="num">Retries</th>
        <th>Last Delivery</th>
        <th class="num">Duration</th>
        <th>Last Error</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as s (`${s.sink_type}/${s.name}`)}
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
