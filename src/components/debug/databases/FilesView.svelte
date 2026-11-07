<script lang="ts">
  // The Files view of the Databases tab: the own recorder files of every
  // worker that was read (contract v1.23) and the shared history, read from
  // this worker. Sealed files and merge results can be merged (>=2) and
  // downloaded by path; archives only downloaded. The shell (DatabasesTab)
  // reads the data; this view draws it and runs the merge.
  //
  // v1.30 panels draw only when their key is in the answer: the own folder
  // (`storage.files`, with the cache snapshot), the other worker folders of
  // this host (`storage.siblings`), the cleanup line of the history
  // (`recorder.sqlite`) and the compressed downloads (offered to a worker
  // that sends `recorder`).
  import {
    api,
    type DatabasesResponse,
    type HistoryFile,
    type HistoryFolder,
    type MergeResult,
  } from '../../../lib/api'
  import type { DbViewState } from '../../../lib/dbview'
  import type { Unreachable } from '../../../lib/fanout'
  import type { OwnSection } from './types'
  import { autodiscoverOn } from '../../../lib/capabilities'
  import { historyCleanupNote } from '../../../lib/dbmode'
  import { fmtBytes, fmtDateTimeMs } from '../../../lib/format'

  interface Props {
    data: DatabasesResponse
    ownSections: OwnSection[]
    unreachable: Unreachable[]
    /** The URL state of the tab; the history worker filter lives there. */
    view: DbViewState
    /** Write a change of the URL state (the filter is a replace, not a push). */
    onchange: (change: Partial<DbViewState>) => void
    /** Called after a merge or a delete, so the shell reads the data again. */
    onchanged: () => void | Promise<void>
  }
  let { data, ownSections, unreachable, view, onchange, onchanged }: Props = $props()

  let selected = $state<Set<string>>(new Set())
  let folded = $state<Set<string>>(new Set())
  // In the URL (db_history_worker), so a shared link shows the same list.
  const workerFilter = $derived(view.historyWorker ?? '')
  let merge = $state<MergeResult | null>(null)
  let mergeError = $state<string | null>(null)
  let merging = $state(false)

  const folders = $derived(data.history?.folders ?? [])
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

  // A worker that sends the v1.30 `recorder` block also serves compressed downloads.
  function servesCompressed(section: OwnSection): boolean {
    return section.recorder !== undefined
  }
  const historyCompressed = $derived(data.recorder !== undefined)
  const cleanupNote = $derived(historyCleanupNote(data.recorder))
  const siblings = $derived(data.storage?.siblings ?? null)

  const STORAGE_KIND_TITLES: Record<string, string> = {
    cache: "The worker's cache file, with its -wal and -shm files",
    watchdog: 'The crash marker; it names the last task when the worker died',
    owner_lock: 'Held while the worker runs; a second process with the same name cannot start',
  }
  function lockState(inUse: boolean | null): string {
    if (inUse === null) return 'unknown'
    return inUse ? 'in use' : 'free'
  }
  function onlineState(online: boolean | null): string {
    if (online === null) return 'unknown'
    return online ? 'online' : 'offline'
  }

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
      await onchanged()
    } catch (e) {
      mergeError = e instanceof Error ? e.message : String(e)
    } finally {
      merging = false
    }
  }

  // The delete of a merge result (v1.30): offered only when the worker says
  // ui.delete_enabled is on; an older worker sends no key and gets no button.
  const deleteEnabled = $derived(data.history?.delete_enabled === true)
  let deleteError = $state<string | null>(null)
  let deleting = $state<string | null>(null)

  /** The question of the confirm dialog: it names the file and says what stays. */
  function deleteQuestion(f: HistoryFile): string {
    return `Delete the merge result ${f.name}? The sealed files and archives it was made from stay.`
  }

  async function doDelete(f: HistoryFile) {
    if (!window.confirm(deleteQuestion(f))) return
    deleting = f.path
    deleteError = null
    try {
      await api.debugDeleteFile(f.path)
      const next = new Set(selected)
      next.delete(f.path)
      selected = next
      await onchanged()
    } catch (e) {
      deleteError = e instanceof Error ? e.message : String(e)
    } finally {
      deleting = null
    }
  }

  function fmtEpoch(ts: number | null): string {
    return ts != null ? fmtDateTimeMs(ts * 1000) : '-'
  }
  function fmtIso(ts: string | null | undefined): string {
    return ts ? fmtDateTimeMs(Date.parse(ts)) : '-'
  }

</script>

<div class="bar">
  <button class="primary" onclick={doMerge} disabled={mergeSelection.length < 2 || merging}>
    {merging ? 'Merging…' : `Merge${mergeSelection.length >= 2 ? ` (${mergeSelection.length})` : ''}`}
  </button>
  <select
    value={workerFilter}
    onchange={(e) => onchange({ historyWorker: e.currentTarget.value || null })}
    aria-label="worker filter"
  >
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
{#if deleteError}
  <p class="error">Delete failed: <code>{deleteError}</code></p>
{/if}


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
                {#if d.kind === 'live' || d.kind === 'memory'}
                  {@const source = d.kind === 'live' ? 'file' : 'memory'}
                  <a
                    href={api.debugDownloadLiveUrl(section.base, source)}
                    title={d.kind === 'live' ? 'Download a snapshot of the live file' : 'Download a snapshot of the memory store'}
                    >↓</a
                  >
                  {#if servesCompressed(section)}
                    <a class="gz" href={api.debugDownloadLiveUrl(section.base, source, true)} title="Download the snapshot gzip-compressed">↓gz</a>
                  {/if}
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    {#if section.storage}
      {@const storage = section.storage}
      {#if storage.own_folder}
        <h3>Own folder <code>{storage.own_folder}</code></h3>
        <table class="storage">
          <thead>
            <tr>
              <th>File</th>
              <th class="num">Entries</th>
              <th>Changed</th>
              <th class="num">Size</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each storage.files as f (f.name)}
              <tr>
                <td class="mono">
                  {f.name}
                  <span class="chip kind" title={STORAGE_KIND_TITLES[f.kind] ?? ''}>{f.kind}</span>
                </td>
                <td class="num mono">{f.entries != null ? f.entries.toLocaleString() : '-'}</td>
                <td class="muted nowrap">{fmtIso(f.modified_at)}</td>
                <td class="num mono">{fmtBytes(f.size_bytes)}</td>
                <td>
                  {#if f.kind === 'cache'}
                    <a href={api.debugDownloadLiveUrl(section.base, 'cache')} title="Download a snapshot of the cache file">↓</a>
                    <a class="gz" href={api.debugDownloadLiveUrl(section.base, 'cache', true)} title="Download the snapshot gzip-compressed">↓gz</a>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if storage.temp_files.count > 0}
          <p class="muted">
            Download temp files: {storage.temp_files.count} ({fmtBytes(storage.temp_files.size_bytes)}). They belong to
            downloads in progress, or to a process that stopped; the worker deletes those at its next start.
          </p>
        {/if}
      {:else}
        <p class="muted">No own folder: storage.dir is empty, so this worker keeps no files of its own.</p>
      {/if}
    {/if}
  {/each}
  {#if siblings}
    <h2>Other folders on this host ({siblings.length})</h2>
    <p class="muted">
      The orphan pass of any worker of this cluster seals and removes a folder whose lock is free, whose files are idle
      for 5 minutes, and whose worker is not online.
      {#if !$autodiscoverOn}With autodiscover off nothing proves a worker is not online, so the pass only logs such a
        folder and the folder stays.{/if}
    </p>
    {#if siblings.length > 0}
      <table class="siblings">
        <thead>
          <tr>
            <th>Worker</th>
            <th class="num">Files</th>
            <th class="num">Size</th>
            <th>Newest change</th>
            <th>Lock</th>
            <th>Registry</th>
          </tr>
        </thead>
        <tbody>
          {#each siblings as sibling (sibling.worker)}
            <tr>
              <td class="mono">{sibling.worker}</td>
              <td class="num mono">{sibling.files}</td>
              <td class="num mono">{fmtBytes(sibling.size_bytes)}</td>
              <td class="muted nowrap">{fmtIso(sibling.newest_modified_at)}</td>
              <td>{lockState(sibling.in_use)}</td>
              <td>{onlineState(sibling.online)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
  {#if unreachable.length}
    <p class="muted unreachable">
      Not answered: {unreachable.map((u) => `${u.worker} (${u.reason})`).join(', ')}
    </p>
  {/if}

  <h2>History</h2>
  {#if cleanupNote}
    <p class="muted cleanup">{cleanupNote}</p>
  {/if}
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
              <td>
                <a href={api.debugDownloadUrl(f.path)} title="Download">↓</a>
                {#if historyCompressed && f.kind !== 'archive'}
                  <a class="gz" href={api.debugDownloadUrl(f.path, true)} title="Download gzip-compressed">↓gz</a>
                {/if}
                {#if deleteEnabled && f.kind === 'merged'}
                  <button
                    class="delete"
                    title="Delete this merge result"
                    disabled={deleting === f.path}
                    onclick={() => doDelete(f)}>{deleting === f.path ? 'Deleting…' : 'Delete'}</button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/each}

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
  button.delete {
    margin-left: 0.4rem;
    font-size: 0.8rem;
    color: #b91c1c;
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
  a.gz {
    margin-left: 0.4rem;
    font-size: 0.8rem;
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
