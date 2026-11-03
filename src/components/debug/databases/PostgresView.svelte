<script lang="ts">
  // The Postgres view of the Databases tab (contract v1.30): the recorder's
  // Postgres table, this worker's writer, and the hour partitions with the
  // ones the next upkeep drops. The table and the writer come from the
  // `recorder.postgres` block the shell already read; the partitions are one
  // read of GET /api/v1/debug/databases/postgres, on open and on Refresh
  // only. Nothing here changes the table.
  import { onMount } from 'svelte'
  import { api, type DatabasesResponse, type PostgresPartitions } from '../../../lib/api'
  import { localClock } from '../../../lib/dbmode'
  import {
    droppedReasons,
    partitionViews,
    retentionNote,
    sizeNote,
    upkeepNote,
    writerNote,
  } from '../../../lib/dbpostgres'
  import { fmtBytes } from '../../../lib/format'

  interface Props {
    data: DatabasesResponse
  }
  let { data }: Props = $props()

  const status = $derived(data.recorder?.postgres ?? null)

  let partitions = $state<PostgresPartitions | null>(null)
  let unavailable = $state(false)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    loading = true
    error = null
    try {
      partitions = await api.debugPostgres()
      unavailable = partitions === null
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  onMount(load)

  const rows = $derived(partitions ? partitionViews(partitions, localClock) : [])
  const DROP_TITLES: Record<string, string> = {
    retention: 'The next upkeep drops it: its hour is past the stored retention',
    size: 'The next upkeep drops it: the table is above max_size',
  }
</script>

{#if status}
  <h2>Table</h2>
  <table class="facts">
    <tbody>
      <tr><th>Table</th><td class="mono" data-testid="pg-table">{status.schema}.{status.table}</td></tr>
      <tr><th>Connection</th><td class="mono">{status.connection}</td></tr>
      <tr><th>initial_retention</th><td>{status.initial_retention_hours}h</td></tr>
      <tr><th>max_size</th><td>{status.max_size_bytes ? fmtBytes(status.max_size_bytes) : 'no cap'}</td></tr>
      <tr><th>Completed output</th><td>{status.store_completed_output ? 'stored' : 'not stored'}</td></tr>
    </tbody>
  </table>

  <h2>Writer of this worker</h2>
  <p data-testid="pg-writer">{writerNote(status.writer)}</p>
  {#if droppedReasons(status.writer).length}
    <p class="muted">Dropped by reason: {droppedReasons(status.writer).join(', ')}</p>
  {/if}
  <p class="muted" data-testid="pg-upkeep">{upkeepNote(status.writer, localClock)}</p>
{/if}

<h2>
  Partitions
  <button class="refresh" onclick={load} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</button>
</h2>
{#if error}
  <p class="error">Failed to read the partitions: <code>{error}</code></p>
{:else if unavailable}
  <p class="muted">The partitions are not available on this worker.</p>
{:else if partitions}
  <p class="muted" data-testid="pg-retention">
    {retentionNote(partitions.stored_retention_hours, status?.initial_retention_hours ?? null)}
  </p>
  <p class="muted" data-testid="pg-size">{sizeNote(partitions.total_bytes, status?.max_size_bytes ?? null)}</p>
  {#if rows.length === 0}
    <p class="muted">The table has no partition yet.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Partition</th><th>Hour</th><th class="num">Size</th><th>Next upkeep</th></tr>
      </thead>
      <tbody>
        {#each rows as row (row.name)}
          <tr class:dropping={row.drop !== null}>
            <td class="mono">{row.name}</td>
            <td class="nowrap">{row.hours}</td>
            <td class="num mono">{fmtBytes(row.sizeBytes)}</td>
            <td>
              {#if row.drop}
                <span class="chip drop" title={DROP_TITLES[row.drop]}>drops ({row.drop})</span>
              {:else}
                <span class="muted">keeps</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  h2 {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .refresh {
    font-size: 0.8rem;
  }
  .facts th {
    text-align: left;
    font-weight: normal;
    color: var(--muted);
    padding-right: 1rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .num {
    text-align: right;
  }
  .chip.drop {
    border: 1px solid #b45309;
    color: #b45309;
    border-radius: 4px;
    padding: 0 0.3rem;
    font-size: 0.8rem;
  }
  tr.dropping td {
    background: rgba(180, 83, 9, 0.06);
  }
</style>
