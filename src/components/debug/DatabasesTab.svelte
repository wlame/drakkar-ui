<script lang="ts">
  // Databases tab (contract v1.23). Two parts:
  // - the own recorder files in storage.dir of every worker of this
  //   worker's cluster (fan-out, one section per worker): the live file and
  //   files closed but not sealed yet (statistics measured by that worker).
  //   The live file downloads as a consistent snapshot from its worker;
  //   workers that did not answer are listed;
  // - the shared history, read from this worker: one foldable block per
  //   history/<cluster> folder, plus merged. Sealed files get their
  //   statistics from their meta file.
  // Sealed files and merge results can be merged (≥2) and downloaded by
  // path; archives only downloaded. A backend older than v1.23 answers the
  // old array: the tab then says the view is not available there.
  import { onMount } from 'svelte'
  import {
    api,
    type DatabasesResponse,
    type HistoryFile,
    type HistoryFolder,
    type MergeResult,
    type OwnDb,
  } from '../../lib/api'
  import { fanOut, fanOutTargets, type FanOutTarget, type Unreachable } from '../../lib/fanout'
  import { fmtBytes, fmtDateTimeMs } from '../../lib/format'

  // One section of own files per worker that answered; base '' is this worker.
  interface OwnSection {
    worker: string
    base: string
    own: OwnDb[]
  }

  let data = $state<DatabasesResponse | null>(null)
  let peerSections = $state<OwnSection[]>([])
  let currentWorker = $state('')
  let unreachable = $state<Unreachable[]>([])
  let unavailable = $state(false)
  let error = $state<string | null>(null)
  let selected = $state<Set<string>>(new Set())
  let folded = $state<Set<string>>(new Set())
  let workerFilter = $state('')
  let merge = $state<MergeResult | null>(null)
  let mergeError = $state<string | null>(null)
  let merging = $state(false)

  async function load() {
    error = null
    try {
      const [res] = await Promise.all([api.debugDatabases(), loadPeers()])
      unavailable = res === null
      data = res
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  // The own files of this worker's cluster peers, each read from the peer.
  // A peer that answers the pre-v1.23 array is listed as not available.
  async function loadPeers() {
    let targets: FanOutTarget[] = [{ worker: '', base: '' }]
    let missing: Unreachable[] = []
    try {
      ;({ targets, unreachable: missing } = fanOutTargets(await api.workers()))
    } catch {
      // An older backend without a usable workers list: this worker alone.
    }
    currentWorker = targets[0].worker
    const answer = await fanOut(
      targets.filter((t) => t.base !== ''),
      (t, signal) => api.debugDatabasesAt(t.base, signal),
    )
    const old = answer.results.filter((r) => r.value === null)
    peerSections = answer.results
      .filter((r) => r.value !== null)
      .map((r) => ({ worker: r.worker, base: r.base, own: r.value?.own ?? [] }))
    unreachable = [
      ...missing,
      ...answer.unreachable,
      ...old.map((r) => ({ worker: r.worker, reason: 'not available on this worker' })),
    ]
  }

  const ownSections = $derived<OwnSection[]>(
    data ? [{ worker: currentWorker, base: '', own: data.own }, ...peerSections] : [],
  )
  const folders = $derived(data?.history.folders ?? [])

  function fileWorker(f: HistoryFile): string {
    return f.meta?.worker ?? ''
  }
  const workers = $derived(
    [...new Set(folders.flatMap((folder) => folder.files.map(fileWorker)).filter(Boolean))].sort(),
  )

  // With a worker chosen, only that worker's sealed files stay: archives and
  // merge results belong to no single worker.
  function visibleFiles(folder: HistoryFolder): HistoryFile[] {
    if (!workerFilter) return folder.files
    return folder.files.filter((f) => fileWorker(f) === workerFilter)
  }

  function isMergeable(f: HistoryFile): boolean {
    return f.kind === 'sealed' || f.kind === 'merged'
  }

  // The selected files the worker filter shows: a selection hidden by the
  // filter is never merged.
  const mergeSelection = $derived.by(() => {
    const shown = new Set(
      folders.flatMap((folder) => visibleFiles(folder).filter(isMergeable).map((f) => f.path)),
    )
    return [...selected].filter((path) => shown.has(path))
  })

  function sectionTitle(section: OwnSection): string {
    return section.worker ? `Own files of ${section.worker}` : "This worker's files"
  }

  function eventCount(f: HistoryFile): number | null {
    const types = f.meta?.event_types
    return types ? Object.values(types).reduce((sum, n) => sum + n, 0) : null
  }
  const KIND_TITLES: Record<string, string> = {
    memory: 'Recent events in memory; not a file',
    live: 'Being written now',
  }
  function kindTitle(kind: string): string {
    return KIND_TITLES[kind] ?? 'Closed; waiting to be sealed into the history folder'
  }
  function eventTypesTitle(types: Record<string, number> | undefined): string {
    return Object.entries(types ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }

  function folderLabel(folder: HistoryFolder): string {
    return folder.kind === 'merged' ? 'merged' : (folder.cluster ?? folder.folder)
  }

  function toggle(path: string) {
    const next = new Set(selected)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    selected = next
  }
  function toggleFold(folder: string) {
    const next = new Set(folded)
    if (next.has(folder)) next.delete(folder)
    else next.add(folder)
    folded = next
  }

  async function doMerge() {
    if (mergeSelection.length < 2) return
    merging = true
    merge = null
    mergeError = null
    try {
      merge = await api.debugMerge(mergeSelection)
      selected = new Set()
      await load()
    } catch (e) {
      mergeError = e instanceof Error ? e.message : String(e)
    } finally {
      merging = false
    }
  }

  function fmtEpoch(ts: number | null): string {
    return ts != null ? fmtDateTimeMs(ts * 1000) : '-'
  }
  function fmtIso(ts: string | null | undefined): string {
    return ts ? fmtDateTimeMs(Date.parse(ts)) : '-'
  }

  onMount(load)
</script>

<div class="bar">
  <button class="primary" onclick={doMerge} disabled={mergeSelection.length < 2 || merging}>
    {merging ? 'Merging…' : `Merge${mergeSelection.length >= 2 ? ` (${mergeSelection.length})` : ''}`}
  </button>
  <button onclick={load}>Refresh</button>
  <select value={workerFilter} onchange={(e) => (workerFilter = e.currentTarget.value)} aria-label="worker filter">
    <option value="">All workers</option>
    {#each workers as w}<option value={w}>{w}</option>{/each}
  </select>
</div>

{#if merge}
  <div class="banner">
    Merged {merge.event_count.toLocaleString()} events from {merge.worker_count} workers{merge.cluster_name
      ? ` (${merge.cluster_name})`
      : ''}.
    <a href={api.debugDownloadUrl(merge.path ?? `merged/${merge.filename}`)}>Download {merge.filename}</a>
  </div>
{/if}
{#if mergeError}
  <p class="error">Merge failed: <code>{mergeError}</code></p>
{/if}

{#if error}
  <p class="error">Failed to load databases: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if unavailable}
  <p class="muted">The databases view is not available on this worker: it runs an older release.</p>
{:else if data}
  <!-- Keyed by position: two workers can share one address (a load balancer). -->
  {#each ownSections as section, index (`${index}:${section.worker}`)}
    <h2>{sectionTitle(section)} ({section.own.length})</h2>
    {#if section.own.length === 0}
      <p class="muted">No own files (this worker keeps its event history in memory only).</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>File</th>
            <th class="num">Events</th>
            <th>First</th>
            <th>Last</th>
            <th class="num">Size</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each section.own as d (d.filename)}
            <tr class:in-use={d.kind === 'live'}>
              <td class="mono">
                {d.filename}
                <span
                  class="chip kind"
                  title={kindTitle(d.kind)}
                  >{d.kind}</span
                >
              </td>
              <td class="num mono" title={eventTypesTitle(d.event_counts)}>{d.event_count.toLocaleString()}</td>
              <td class="muted nowrap">{fmtEpoch(d.first_event_ts)}</td>
              <td class="muted nowrap">{fmtEpoch(d.last_event_ts)}</td>
              <td class="num mono">{fmtBytes(d.size_bytes)}</td>
              <td>
                {#if d.kind === 'live'}
                  <a href={api.debugDownloadLiveUrl(section.base, 'file')} title="Download a snapshot of the live file">↓</a>
                {:else if d.kind === 'memory'}
                  <a href={api.debugDownloadLiveUrl(section.base, 'memory')} title="Download a snapshot of the memory store">↓</a>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/each}
  {#if unreachable.length}
    <p class="muted unreachable">
      Not answered: {unreachable.map((u) => `${u.worker} (${u.reason})`).join(', ')}
    </p>
  {/if}

  <h2>History</h2>
  {#if folders.length === 0}
    <p class="muted">No sealed history yet.</p>
  {/if}
  {#each folders as folder (folder.folder)}
    {@const files = visibleFiles(folder)}
    <button class="fold" onclick={() => toggleFold(folder.folder)} title={folder.folder}>
      {folded.has(folder.folder) ? '▸' : '▾'}
      {folderLabel(folder)} ({files.length})
    </button>
    {#if !folded.has(folder.folder) && files.length > 0}
      <table>
        <thead>
          <tr>
            <th></th>
            <th>File</th>
            <th>Worker</th>
            <th class="num">Events</th>
            <th>First</th>
            <th>Last</th>
            <th class="num">Size</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each files as f (f.path)}
            {@const count = eventCount(f)}
            <tr>
              <td>
                {#if isMergeable(f)}
                  <input type="checkbox" checked={selected.has(f.path)} onchange={() => toggle(f.path)} />
                {/if}
              </td>
              <td class="mono">
                {f.name}
                {#if f.kind !== 'sealed'}<span class="chip kind">{f.kind}</span>{/if}
              </td>
              <td class="mono">{fileWorker(f) || '-'}</td>
              <td class="num mono events" title={eventTypesTitle(f.meta?.event_types)}
                >{count != null ? count.toLocaleString() : '-'}</td
              >
              <td class="muted nowrap">{fmtIso(f.meta?.first_event_ts)}</td>
              <td class="muted nowrap">{fmtIso(f.meta?.last_event_ts)}</td>
              <td class="num mono">{fmtBytes(f.size_bytes)}</td>
              <td><a href={api.debugDownloadUrl(f.path)} title="Download">↓</a></td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
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
  .fold {
    display: block;
    margin: 0.9rem 0 0.4rem;
    font-weight: 600;
    background: none;
    border: none;
    padding: 0;
    color: var(--text);
    cursor: pointer;
  }
  .nowrap {
    white-space: nowrap;
  }
  /* The live file: being written right now. Accent border + faint tint. */
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
  .chip.kind {
    background: var(--panel-2);
    color: var(--muted);
    border: 1px solid var(--line);
  }
</style>
