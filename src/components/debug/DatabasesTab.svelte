<script lang="ts">
  // Databases tab shell (contract v1.23). It owns the URL state (`db_*` query
  // keys, src/lib/dbview.ts), the worker picker and the reads; the Files view
  // draws them.
  //
  // Reads: on open only this worker is read. Another worker is read only
  // after the operator picks it (`db_worker=<name>`) or picks all workers
  // (`db_worker=*`), so opening the tab never calls a peer. Peers answer
  // their own part only, and at most FANOUT_CONCURRENCY calls run at once.
  // A backend older than v1.23 answers the old array: the tab then says the
  // view is not available there.
  import { untrack } from 'svelte'
  import { api, type DatabasesResponse } from '../../lib/api'
  import { autodiscoverOn, capabilities } from '../../lib/capabilities'
  import { modeStrip } from '../../lib/dbmode'
  import { sameClusterPeers } from '../../lib/cluster'
  import { ALL_WORKERS, isPushChange, parseDbView, writeDbView, type DbViewState } from '../../lib/dbview'
  import { fanOut, fanOutTargets, type FanOutTarget, type Unreachable } from '../../lib/fanout'
  import { search, setQuery } from '../../lib/router'
  import type { WorkerPeer } from '../../lib/types'
  import { buildCoverage } from '../../lib/coverage'
  import CoverageBar from './databases/CoverageBar.svelte'
  import FilesView from './databases/FilesView.svelte'
  import SliceView from './databases/SliceView.svelte'
  import type { OwnSection } from './databases/types'

  // The views the tab can draw; more are added here as they land.
  const VIEW_BUTTONS: { view: DbViewState['view']; label: string }[] = [
    { view: 'files', label: 'Files' },
    { view: 'slice', label: 'Slice' },
  ]

  // What a peer is asked for: its own part, not the shared history.
  const PEER_PARTS = ['own', 'storage', 'recorder']

  let data = $state<DatabasesResponse | null>(null)
  let peerSections = $state<OwnSection[]>([])
  let workers = $state<WorkerPeer[]>([])
  let currentWorker = $state('')
  let unreachable = $state<Unreachable[]>([])
  let unavailable = $state(false)
  let error = $state<string | null>(null)

  const view = $derived(parseDbView($search))
  const peerNames = $derived(sameClusterPeers(workers).map((w) => w.worker_name))

  /** Change the URL state: Back undoes a view or worker step, other changes replace the entry. */
  function setView(change: Partial<DbViewState>) {
    setQuery(writeDbView(window.location.search, change), { replace: !isPushChange(change) })
  }

  // One workers read at a time: the open and the first load share it.
  let workersRead: Promise<void> | null = null

  function loadWorkers(): Promise<void> {
    workersRead ??= (async () => {
      try {
        workers = await api.workers()
      } catch (e) {
        // An older backend without a usable workers list: this worker alone.
        console.warn('databases: the workers list is not available', e)
        workers = []
      }
      currentWorker = workers.find((w) => w.is_current)?.worker_name ?? ''
    })()
    return workersRead
  }

  // The peers the URL asks for: none, one named worker, or the whole cluster.
  function peerTargets(
    worker: string | null,
  ): { targets: FanOutTarget[]; missing: Unreachable[] } {
    if (worker === null || worker === currentWorker) return { targets: [], missing: [] }
    const all = fanOutTargets(workers)
    const peers = all.targets.filter((t) => t.base !== '')
    if (worker === ALL_WORKERS) return { targets: peers, missing: all.unreachable }
    const one = peers.find((t) => t.worker === worker)
    if (one) return { targets: [one], missing: [] }
    const known = all.unreachable.find((u) => u.worker === worker)
    return { targets: [], missing: [known ?? { worker, reason: 'not in this cluster' }] }
  }

  // A newer read makes an older one that is still in flight stale.
  let readSequence = 0

  async function load(worker: string | null, refreshWorkers = false) {
    if (refreshWorkers) workersRead = null
    const mine = ++readSequence
    error = null
    try {
      await loadWorkers()
      const [res, peers] = await Promise.all([api.debugDatabases(), loadPeers(worker)])
      if (mine !== readSequence) return
      unavailable = res === null
      data = res
      peerSections = peers.sections
      unreachable = peers.unreachable
    } catch (e) {
      if (mine !== readSequence) return
      error = e instanceof Error ? e.message : String(e)
    }
  }

  async function loadPeers(worker: string | null) {
    const { targets, missing } = peerTargets(worker)
    if (targets.length === 0) return { sections: [] as OwnSection[], unreachable: missing }
    const answer = await fanOut(targets, (t, signal) =>
      api.debugDatabasesAt(t.base, signal, PEER_PARTS),
    )
    // A peer that answers the pre-v1.23 array is listed as not available.
    const old = answer.results.filter((r) => r.value === null)
    return {
      sections: answer.results
        .filter((r) => r.value !== null)
        .map((r) => ({
          worker: r.worker,
          base: r.base,
          own: r.value?.own ?? [],
          recorder: r.value?.recorder,
          storage: r.value?.storage,
        })),
      unreachable: [
        ...missing,
        ...answer.unreachable,
        ...old.map((r) => ({ worker: r.worker, reason: 'not available on this worker' })),
      ],
    }
  }

  const ownSections = $derived<OwnSection[]>(
    data
      ? [
          { worker: currentWorker, base: '', own: data.own, recorder: data.recorder, storage: data.storage },
          ...peerSections,
        ]
      : [],
  )

  // The coverage bar shows the picked worker: a named peer, else this one.
  const coverage = $derived.by(() => {
    const section = ownSections.find((s) => s.worker === view.worker && s.base !== '') ?? ownSections[0]
    return buildCoverage(section?.own ?? [], data ?? { history: { folders: [] } }, section?.worker ?? '')
  })
  const selection = $derived(
    view.from !== null && view.to !== null ? { from: view.from, to: view.to } : null,
  )

  // A range dragged on the bar goes to the URL; from the Files view it also opens the Slice view.
  function selectRange(range: { from: number; to: number }) {
    setView(view.view === 'slice' ? range : { ...range, view: 'slice' })
  }

  // Read on open and whenever the picked worker changes (a pasted link, Back).
  // It depends on the worker value alone: another db_* change never reads again.
  const pickedWorker = $derived(view.worker)
  $effect(() => {
    const worker = pickedWorker
    untrack(() => load(worker))
  })

  function pick(value: string) {
    setView({ worker: value === '' ? null : value })
  }
  // What the serving worker runs (v1.30); absent for an older worker.
  const mode = $derived(data ? modeStrip(data, $capabilities) : null)

  // The own worker's name in a link is the same as no choice.
  const picked = $derived(view.worker === currentWorker ? '' : (view.worker ?? ''))
</script>

{#if mode}
  <p class="mode" data-testid="mode-strip">{mode}</p>
{/if}

<div class="bar views" role="group" aria-label="database views">
  {#each VIEW_BUTTONS as b (b.view)}
    <button
      class:on={view.view === b.view || (b.view === 'files' && !VIEW_BUTTONS.some((v) => v.view === view.view))}
      aria-pressed={view.view === b.view}
      onclick={() => setView({ view: b.view })}>{b.label}</button
    >
  {/each}
</div>

<div class="bar">
  <button onclick={() => load(view.worker, true)}>Refresh</button>
  {#if $autodiscoverOn}
    <select value={picked} onchange={(e) => pick(e.currentTarget.value)} aria-label="worker picker">
      <option value="">This worker{currentWorker ? ` (${currentWorker})` : ''}</option>
      <option value={ALL_WORKERS}>All workers of the cluster</option>
      {#each peerNames as w}<option value={w}>{w}</option>{/each}
    </select>
  {/if}
</div>

{#if error}
  <p class="error">Failed to load databases: <code>{error}</code></p>
  <button onclick={() => load(view.worker)}>Retry</button>
{:else if unavailable}
  <p class="muted">The databases view is not available on this worker: it runs an older release.</p>
{:else if data}
  <CoverageBar {coverage} {selection} onselect={selectRange} />
  {#if view.view === 'slice'}
    <SliceView {data} {ownSections} {workers} {currentWorker} {view} {coverage} onchange={setView} />
  {:else}
    <FilesView {data} {ownSections} {unreachable} onmerged={() => load(view.worker)} />
  {/if}
{/if}

<style>
  .mode {
    margin: 0 0 0.7rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
  }
  .views button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .bar select {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
</style>
