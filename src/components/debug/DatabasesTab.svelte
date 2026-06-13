<script lang="ts">
  // Databases tab: list recorder DB files (grouped by cluster), select ≥2 to merge,
  // and download (ports debug.html databases). Files with zero events are hidden
  // (count surfaced). Download/merge carry the bearer token where configured.
  import { onMount } from 'svelte'
  import { api, type DbInfo, type MergeResult } from '../../lib/api'
  import { fmtBytes, fmtDateTimeMs } from '../../lib/format'

  let all = $state<DbInfo[]>([])
  let error = $state<string | null>(null)
  let workerFilter = $state('')
  let selected = $state<Set<string>>(new Set())
  let sortKey = $state<'filename' | 'worker_name' | 'event_count' | 'last_event_ts' | 'size_bytes'>('last_event_ts')
  let sortDir = $state<'asc' | 'desc'>('desc')
  let merge = $state<MergeResult | null>(null)
  let mergeError = $state<string | null>(null)
  let merging = $state(false)

  async function load() {
    error = null
    try {
      all = await api.debugDatabases()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  const workers = $derived([...new Set(all.map((d) => d.worker_name))].sort())
  const emptyHidden = $derived(all.filter((d) => d.event_count === 0).length)

  const visible = $derived.by<DbInfo[]>(() => {
    let rows = all.filter((d) => d.event_count > 0)
    if (workerFilter) rows = rows.filter((d) => d.worker_name === workerFilter)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir
      return String(av).localeCompare(String(bv)) * dir
    })
  })

  interface ClusterGroup {
    cluster: string
    rows: DbInfo[]
  }
  const groups = $derived.by<ClusterGroup[]>(() => {
    const map = new Map<string, DbInfo[]>()
    for (const d of visible) {
      const c = d.cluster_name || 'Unclustered'
      if (!map.has(c)) map.set(c, [])
      map.get(c)!.push(d)
    }
    return [...map.entries()].map(([cluster, rows]) => ({ cluster, rows }))
  })

  function toggle(filename: string) {
    const next = new Set(selected)
    if (next.has(filename)) next.delete(filename)
    else next.add(filename)
    selected = next
  }
  function toggleGroup(rows: DbInfo[], on: boolean) {
    const next = new Set(selected)
    for (const r of rows) {
      if (on) next.add(r.filename)
      else next.delete(r.filename)
    }
    selected = next
  }
  function setSort(key: typeof sortKey) {
    if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
    else {
      sortKey = key
      sortDir = 'asc'
    }
  }

  async function doMerge() {
    if (selected.size < 2) return
    merging = true
    merge = null
    mergeError = null
    try {
      merge = await api.debugMerge([...selected])
      selected = new Set()
      await load()
    } catch (e) {
      mergeError = e instanceof Error ? e.message : String(e)
    } finally {
      merging = false
    }
  }

  function fmtTs(ts: number | null): string {
    return ts != null ? fmtDateTimeMs(ts * 1000) : '-'
  }
  function eventCountsTitle(d: DbInfo): string {
    return Object.entries(d.event_counts)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }

  onMount(load)
</script>

<div class="bar">
  <button class="primary" onclick={doMerge} disabled={selected.size < 2 || merging}>
    {merging ? 'Merging…' : `Merge${selected.size >= 2 ? ` (${selected.size})` : ''}`}
  </button>
  <button onclick={load}>Refresh</button>
  <select bind:value={workerFilter}>
    <option value="">All workers</option>
    {#each workers as w}<option value={w}>{w}</option>{/each}
  </select>
  <span class="muted">{visible.length} files{emptyHidden ? ` (${emptyHidden} empty hidden)` : ''}</span>
</div>

{#if merge}
  <div class="banner">
    Merged {merge.event_count.toLocaleString()} events from {merge.worker_count} workers{merge.cluster_name ? ` (${merge.cluster_name})` : ''}.
    <a href={api.debugDownloadUrl(merge.filename)}>Download {merge.filename}</a>
  </div>
{/if}
{#if mergeError}
  <p class="error">Merge failed: <code>{mergeError}</code></p>
{/if}

{#if error}
  <p class="error">Failed to load databases: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if visible.length === 0}
  <p class="muted">{all.length === 0 ? 'No database files found' : 'No databases match filters'}</p>
{:else}
  {#each groups as g}
    {@const allSel = g.rows.every((r) => selected.has(r.filename))}
    <h2>
      <input type="checkbox" checked={allSel} onchange={(e) => toggleGroup(g.rows, e.currentTarget.checked)} />
      {g.cluster} ({g.rows.length})
    </h2>
    <table>
      <thead>
        <tr>
          <th></th>
          <th class="sortable" onclick={() => setSort('filename')}>File</th>
          <th class="sortable" onclick={() => setSort('worker_name')}>Worker</th>
          <th class="num sortable" onclick={() => setSort('event_count')}>Events</th>
          <th>First</th>
          <th class="sortable" onclick={() => setSort('last_event_ts')}>Last</th>
          <th class="num sortable" onclick={() => setSort('size_bytes')}>Size</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each g.rows as d (d.filename)}
          <tr>
            <td><input type="checkbox" checked={selected.has(d.filename)} onchange={() => toggle(d.filename)} /></td>
            <td class="mono">{d.filename}</td>
            <td class="mono">{d.worker_name}</td>
            <td class="num mono" title={eventCountsTitle(d)}>{d.event_count.toLocaleString()}</td>
            <td class="muted nowrap">{fmtTs(d.first_event_ts)}</td>
            <td class="muted nowrap">{fmtTs(d.last_event_ts)}</td>
            <td class="num mono">{fmtBytes(d.size_bytes)}</td>
            <td><a href={api.debugDownloadUrl(d.filename)} title="Download">↓</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }
  .bar .primary {
    background: #0d9488;
    border-color: #0d9488;
    color: #fff;
  }
  .bar .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .bar select {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .banner {
    padding: 0.6rem 0.9rem;
    border: 1px solid rgba(52, 211, 153, 0.4);
    border-radius: 8px;
    background: var(--panel);
    margin-bottom: 1rem;
    font-size: 0.9rem;
  }
  .banner a {
    margin-left: 0.5rem;
  }
  h2 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .sortable {
    cursor: pointer;
    user-select: none;
  }
  .sortable:hover {
    color: var(--text);
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
