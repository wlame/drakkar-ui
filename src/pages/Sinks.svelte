<script lang="ts">
  // Sinks (ports sinks.html): per-sink delivery counters, last-delivery time and
  // duration, and the last error. Polls every 2s like the reference; the whole
  // list is re-rendered each poll so sinks added/removed at runtime appear/vanish
  // (the reference only mutated existing rows).
  import { onMount } from 'svelte'
  import { api, type SinkStatus } from '../lib/api'
  import { fmtTime, fmtTimeFull, dur3 } from '../lib/format'
  import { COLOR } from '../lib/events'
  import Expandable from '../components/Expandable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  const POLL_MS = 2000

  let rows = $state<SinkStatus[] | null>(null)
  let error = $state<string | null>(null)

  async function load() {
    try {
      rows = await api.sinks()
      error = null
    } catch (e) {
      // Keep the last good list across transient poll failures; only surface an
      // error before the first successful load.
      if (rows === null) error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  })
</script>

<h1>Sinks</h1>

{#if error}
  <p class="error">Could not load sinks: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
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
          <td class="mono" style:color={COLOR.teal}>{s.name}</td>
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
</style>
