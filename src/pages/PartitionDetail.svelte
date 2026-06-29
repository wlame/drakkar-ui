<script lang="ts">
  // Partition detail: a paginated, newest-first view of one partition's recorded
  // events (ports partition_detail.html). Events come from /api/v1/events filtered
  // to this partition, 50 per page (DB offset = page * 50). "Newer/Older" map
  // inversely to the page number because the feed is ordered id DESC.
  import { api, type EventRow } from '../lib/api'
  import { search, link } from '../lib/router'
  import { fmtTime, fmtTimeMs, dur2, fmtBytes } from '../lib/format'
  import { eventColor } from '../lib/events'
  import KafkaIcon from '../components/KafkaIcon.svelte'
  import Expandable from '../components/Expandable.svelte'

  let { params = {} }: { params?: Record<string, string> } = $props()

  const PAGE_SIZE = 50

  const id = $derived(Number.parseInt(params.id ?? '', 10))
  const page = $derived(
    Math.max(0, Number.parseInt(new URLSearchParams($search).get('page') ?? '0', 10) || 0),
  )

  let rows = $state<EventRow[] | null>(null)
  let error = $state<string | null>(null)
  let reqId = 0

  async function load() {
    if (Number.isNaN(id)) {
      error = 'Invalid partition id'
      rows = []
      return
    }
    const myReq = ++reqId
    error = null
    rows = null
    try {
      const r = await api.events({ partitions: String(id), limit: PAGE_SIZE, offset: page * PAGE_SIZE })
      if (myReq === reqId) rows = r
    } catch (e) {
      if (myReq === reqId) error = e instanceof Error ? e.message : String(e)
    }
  }

  // Refetch whenever the partition id or the page changes.
  $effect(() => {
    void id
    void page
    load()
  })

  const hasNext = $derived(rows != null && rows.length === PAGE_SIZE)

  function details(e: EventRow): string {
    return e.args ?? e.metadata ?? ''
  }
</script>

<div class="head">
  <h1>Partition {Number.isNaN(id) ? '?' : id}</h1>
  <a class="back" href="/partitions" use:link>← all partitions</a>
</div>

{#if error}
  <p class="error">Could not load events: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !rows}
  <p class="muted">Loading…</p>
{:else if rows.length === 0}
  <p class="muted">No events recorded for this partition{page > 0 ? ' on this page' : ''}.</p>
{:else}
  <table>
    <thead>
      <tr>
        <th>Time</th>
        <th>Event</th>
        <th class="num">Offset</th>
        <th>Task ID</th>
        <th class="num">Duration</th>
        <th class="num">Exit</th>
        <th class="num">Stdout</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as e (e.id)}
        <tr>
          <td class="muted nowrap" title={fmtTimeMs(e.ts)}>{fmtTime(e.ts)}</td>
          <td><span class="evt" style:color={eventColor(e.event)}>{e.event}</span></td>
          <td class="num mono">
            {#if e.offset != null}
              <a href={`/debug#trace/${id}/${e.offset}`} use:link>{e.offset}</a>
              <KafkaIcon partition={id} offset={e.offset} />
            {/if}
          </td>
          <td class="mono">
            {#if e.task_id}
              <a href={`/task/${encodeURIComponent(e.task_id)}`} use:link>{e.task_id}</a>
            {/if}
          </td>
          <td class="num mono">{e.duration != null ? dur2(e.duration) : ''}</td>
          <td class="num mono" class:err={e.exit_code != null && e.exit_code !== 0}>
            {e.exit_code ?? ''}
          </td>
          <td class="num mono">{e.stdout_size ? fmtBytes(e.stdout_size) : ''}</td>
          <td>
            {#if details(e)}<Expandable text={details(e)} />{/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="pager">
    {#if page > 0}
      <a href={`/partitions/${id}?page=${page - 1}`} use:link>← Newer</a>
    {/if}
    <span class="spacer"></span>
    {#if hasNext}
      <a href={`/partitions/${id}?page=${page + 1}`} use:link>Older →</a>
    {/if}
  </div>
{/if}

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .head h1 {
    margin: 0;
  }
  .back {
    font-size: 0.85rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .evt {
    font-weight: 600;
  }
  td.err {
    color: var(--error);
  }
  .pager {
    display: flex;
    align-items: center;
    margin-top: 1rem;
    font-size: 0.9rem;
  }
  .pager .spacer {
    flex: 1;
  }
</style>
