<script lang="ts">
  // Databases tab: list recorder DB files (grouped by cluster), select ≥2 to merge,
  // and download (ports debug.html databases). Files with zero events are hidden
  // (count surfaced). Download/merge carry the bearer token where configured.
  // Archives (below the raw list) are a separate, read-only listing of already
  // compressed/merged files — they never join `selected` or the merge request.
  import { onDestroy, onMount } from 'svelte'
  import { api, type ArchiveEntry, type DbInfo, type MergeResult } from '../../lib/api'
  import { fmtBytes, fmtDateTimeMs } from '../../lib/format'

  // How soon to re-poll while some rows are stats_pending (a cold stats
  // cache on the backend — the warmer fills them in within seconds).
  const PENDING_REPOLL_MS = 3000

  let all = $state<DbInfo[]>([])
  let error = $state<string | null>(null)
  let repollTimer: ReturnType<typeof setTimeout> | undefined
  let workerFilter = $state('')
  let selected = $state<Set<string>>(new Set())
  let sortKey = $state<'filename' | 'worker_name' | 'event_count' | 'last_event_ts' | 'size_bytes'>('last_event_ts')
  let sortDir = $state<'asc' | 'desc'>('desc')
  let merge = $state<MergeResult | null>(null)
  let mergeError = $state<string | null>(null)
  let merging = $state(false)
  let archives = $state<ArchiveEntry[]>([])

  async function load() {
    error = null
    try {
      all = await api.debugDatabases()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    // Pending rows mean the backend's stats cache is still warming —
    // re-poll until every row is filled in, then stop (no idle polling).
    clearTimeout(repollTimer)
    if (all.some((d) => d.stats_pending)) {
      repollTimer = setTimeout(() => void load(), PENDING_REPOLL_MS)
    }
    await loadArchives()
  }

  // Archives degrade silently: a 404 (old backend, api.debugArchives()
  // already maps that to null) or any other fetch failure just leaves the
  // section hidden rather than surfacing a second error banner next to the
  // raw-databases one above.
  async function loadArchives() {
    try {
      const res = await api.debugArchives()
      archives = res?.archives ?? []
    } catch {
      archives = []
    }
  }

  const workers = $derived([...new Set(all.map((d) => d.worker_name))].sort())

  // The zero-events filter hides only settled, empty RECORDER files —
  // cache DBs (no events by nature) and pending rows (stats unknown yet)
  // must stay visible.
  function isHiddenEmpty(d: DbInfo): boolean {
    return d.event_count === 0 && !d.stats_pending && d.kind !== 'cache'
  }
  const emptyHidden = $derived(all.filter(isHiddenEmpty).length)

  const visible = $derived.by<DbInfo[]>(() => {
    let rows = all.filter((d) => !isHiddenEmpty(d))
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
      if (r.kind === 'cache') continue // cache DBs are never mergeable
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
  onDestroy(() => clearTimeout(repollTimer))
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
    {@const allSel = g.rows.filter((r) => r.kind !== 'cache').every((r) => selected.has(r.filename))}
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
          <tr class:in-use={!!d.live_for}>
            <td>
              <!-- Cache DBs never join a merge: the merge tool combines
                   recorder event logs, and a cache file has no events. -->
              {#if d.kind !== 'cache'}
                <input type="checkbox" checked={selected.has(d.filename)} onchange={() => toggle(d.filename)} />
              {/if}
            </td>
            <td class="mono">
              {d.filename}
              {#if d.live_for}
                <span class="chip live" title="Currently written by {d.live_for} — contents still growing"
                  >in use · {d.live_for}</span>
              {/if}
              {#if d.kind === 'cache'}
                <span class="chip kind" title="Handler cache database (cache_entries), not an event log">cache</span>
              {:else if d.kind === 'merged'}
                <span class="chip kind" title="drakkar-merge output combining several workers">merged</span>
              {/if}
            </td>
            <td class="mono">{d.worker_name}</td>
            {#if d.stats_pending}
              <td class="num muted" title="Statistics are being computed in the background — this fills in shortly"
                >scanning…</td>
            {:else if d.kind === 'cache'}
              <td class="num mono" title="Rows in cache_entries">{(d.cache_entry_count ?? 0).toLocaleString()} entries</td>
            {:else}
              <td class="num mono" title={eventCountsTitle(d)}>{d.event_count.toLocaleString()}</td>
            {/if}
            <td class="muted nowrap">{d.stats_pending ? '…' : fmtTs(d.first_event_ts)}</td>
            <td class="muted nowrap">{d.stats_pending ? '…' : fmtTs(d.last_event_ts)}</td>
            <td class="num mono">{fmtBytes(d.size_bytes)}</td>
            <td>
              {#if d.kind !== 'cache'}
                <a href={api.debugDownloadUrl(d.filename)} title="Download">↓</a>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
{/if}

{#if archives.length > 0}
  <h2>Archives ({archives.length})</h2>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Cluster</th>
        <th>Window</th>
        <th class="num">Size</th>
        <th></th>
      </tr>
    </thead>
    <tbody>
      {#each archives as a (a.name)}
        <tr>
          <td class="mono">{a.name}</td>
          <td class="mono">{a.cluster}</td>
          <td class="muted nowrap">{fmtTs(a.from_ts)} → {fmtTs(a.to_ts)}</td>
          <td class="num mono">{fmtBytes(a.size_bytes)}</td>
          <td><a href={api.debugArchiveDownloadUrl(a.name)} title="Download">↓</a></td>
        </tr>
      {/each}
    </tbody>
  </table>
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
  /* In-use rows: the file a worker is writing RIGHT NOW. Accent border +
     faint tint — visible without shouting over the selection checkboxes. */
  tr.in-use td {
    background: rgba(13, 148, 136, 0.07);
  }
  tr.in-use td:first-child {
    border-left: 3px solid #0d9488;
  }
  .chip {
    display: inline-block;
    font-size: 0.7rem;
    border-radius: 999px;
    padding: 0.05rem 0.5rem;
    margin-left: 0.4rem;
    vertical-align: middle;
    white-space: nowrap;
  }
  .chip.live {
    background: rgba(13, 148, 136, 0.15);
    color: #0d9488;
    border: 1px solid rgba(13, 148, 136, 0.4);
  }
  .chip.kind {
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--line);
  }
</style>
