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
  import { onMount, untrack } from 'svelte'
  import { api, type DatabasesResponse } from '../../lib/api'
  import { autodiscoverOn } from '../../lib/capabilities'
  import { sameClusterPeers } from '../../lib/cluster'
  import { ALL_WORKERS, isPushChange, parseDbView, writeDbView, type DbViewState } from '../../lib/dbview'
  import { fanOut, fanOutTargets, type FanOutTarget, type Unreachable } from '../../lib/fanout'
  import { search, setQuery } from '../../lib/router'
  import type { WorkerPeer } from '../../lib/types'
  import FilesView from './databases/FilesView.svelte'
  import type { OwnSection } from './databases/types'

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

  async function loadWorkers() {
    try {
      workers = await api.workers()
    } catch {
      // An older backend without a usable workers list: this worker alone.
      workers = []
    }
    currentWorker = workers.find((w) => w.is_current)?.worker_name ?? ''
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

  async function load(worker: string | null) {
    const mine = ++readSequence
    error = null
    try {
      if (worker !== null && workers.length === 0) await loadWorkers()
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
        .map((r) => ({ worker: r.worker, base: r.base, own: r.value?.own ?? [] })),
      unreachable: [
        ...missing,
        ...answer.unreachable,
        ...old.map((r) => ({ worker: r.worker, reason: 'not available on this worker' })),
      ],
    }
  }

  const ownSections = $derived<OwnSection[]>(
    data ? [{ worker: currentWorker, base: '', own: data.own }, ...peerSections] : [],
  )

  // Read on open and whenever the picked worker changes (a pasted link, Back).
  $effect(() => {
    const worker = view.worker
    untrack(() => load(worker))
  })

  onMount(loadWorkers)

  function pick(value: string) {
    setView({ worker: value === '' ? null : value })
  }
  const picked = $derived(view.worker ?? '')
</script>

<div class="bar">
  <button onclick={() => load(view.worker)}>Refresh</button>
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
  <FilesView {data} {ownSections} {unreachable} onmerged={() => load(view.worker)} />
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.9rem;
    flex-wrap: wrap;
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
