<script lang="ts">
  // Header worker switcher: a dropdown of all workers in the cluster, polled from
  // /api/v1/workers every 10s (matching base.html). Workers are grouped by cluster
  // with the current worker badged; selecting a peer navigates to that worker's
  // debug UI at the same top-level page. Cross-worker links are full navigations
  // (different host), so they are plain anchors, not client-side routes.
  import { onMount } from 'svelte'
  import { api, type WorkerPeer } from '../lib/api'
  import { currentPath } from '../lib/router'

  let workers = $state<WorkerPeer[]>([])
  let open = $state(false)
  let root: HTMLDivElement

  const POLL_MS = 10_000
  const GENERAL_PAGES = ['/', '/partitions', '/sinks', '/live', '/debug', '/history']

  const currentName = $derived(workers.find((w) => w.is_current)?.worker_name ?? 'scanning…')

  // suffix appends the current top-level page to a peer URL so switching keeps you
  // on the same view; deep/detail routes fall back to the peer's dashboard.
  const suffix = $derived(GENERAL_PAGES.includes($currentPath) ? $currentPath : '/')

  // Group consecutive workers by cluster, preserving the API's clustered-first order.
  interface ClusterGroup {
    cluster: string
    workers: WorkerPeer[]
  }
  const groups = $derived.by<ClusterGroup[]>(() => {
    const out: ClusterGroup[] = []
    for (const w of workers) {
      const cluster = w.cluster || ''
      const last = out[out.length - 1]
      if (last && last.cluster === cluster) last.workers.push(w)
      else out.push({ cluster, workers: [w] })
    }
    return out
  })

  function peerHref(w: WorkerPeer): string {
    const base = w.url || `http://${w.ip_address}:${w.debug_port}/`
    return base.replace(/\/+$/, '') + suffix
  }

  async function load() {
    try {
      workers = await api.workers()
    } catch {
      // Non-essential chrome — keep the last good list on failure.
    }
  }

  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false
  }

  onMount(() => {
    load()
    const id = setInterval(load, POLL_MS)
    document.addEventListener('click', onDocClick)
    return () => {
      clearInterval(id)
      document.removeEventListener('click', onDocClick)
    }
  })
</script>

<div class="switcher" bind:this={root}>
  <button class="trigger" onclick={() => (open = !open)} title="Switch worker">
    <span class="mono">{currentName}</span>
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z" /></svg>
  </button>
  {#if open}
    <div class="menu">
      {#if !workers.length}
        <div class="empty">no workers found</div>
      {:else}
        {#each groups as g}
          {#if g.cluster}
            <div class="cluster-head">{g.cluster}</div>
          {/if}
          {#each g.workers as w}
            {#if w.is_current}
              <div class="item current">
                <span class="mono">{w.worker_name || '?'}</span>
                <span class="tag">current</span>
              </div>
            {:else}
              <a class="item" href={peerHref(w)}>
                <span class="mono">{w.worker_name || '?'}</span>
                {#if !w.debug_url}
                  <span class="addr">{w.ip_address}:{w.debug_port}</span>
                {/if}
              </a>
            {/if}
          {/each}
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .switcher {
    position: relative;
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line);
    padding: 0.3rem 0.6rem;
  }
  .trigger:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .trigger svg {
    opacity: 0.6;
  }
  .menu {
    position: absolute;
    right: 0;
    margin-top: 0.35rem;
    min-width: 15rem;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
    z-index: 50;
    padding: 0.25rem 0;
    overflow: hidden;
  }
  .cluster-head {
    padding: 0.4rem 0.75rem 0.2rem;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.45rem 0.75rem;
    color: var(--text);
    text-decoration: none;
    font-size: 0.85rem;
  }
  a.item:hover {
    background: var(--panel);
  }
  .item.current {
    background: var(--panel);
  }
  .tag,
  .addr {
    font-size: 0.7rem;
    color: var(--muted);
  }
  .empty {
    padding: 0.5rem 0.75rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
</style>
