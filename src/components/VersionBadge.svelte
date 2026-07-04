<script lang="ts">
  // Header version badge: the drakkar-ui build version as a click target that
  // opens a small panel with the full version picture — this bundle, the
  // backend flavor/version, and which UI the backend says it is serving
  // (identity v1.2). Identity is fetched lazily on first open so page loads
  // pay nothing; older backends without the endpoint (or without the v1.2
  // fields) degrade to showing only the bundle version.
  import { onMount } from 'svelte'
  import { api } from '../lib/api'
  import type { Identity } from '../lib/types'

  let open = $state(false)
  let identity = $state<Identity | null>(null)
  let failed = $state(false)
  let root: HTMLDivElement

  async function toggle() {
    open = !open
    if (open && identity === null && !failed) {
      try {
        identity = await api.identity()
      } catch {
        failed = true // pre-v1.1 backend — panel shows the UI version only
      }
    }
  }

  // "release" bundles report their tag; anything else is the backend's
  // built-in fallback pages (which cannot render this SPA — but the badge
  // copy stays accurate if that ever changes).
  const servedUI = $derived(
    identity?.ui_version ?? (identity?.ui_source ? `built-in pages` : null)
  )

  function onDocClick(e: MouseEvent) {
    if (open && root && !root.contains(e.target as Node)) open = false
  }

  onMount(() => {
    document.addEventListener('click', onDocClick)
    return () => document.removeEventListener('click', onDocClick)
  })
</script>

<div class="badge" bind:this={root}>
  <button class="version" onclick={toggle} title="Version details">
    {__APP_VERSION__}
  </button>
  {#if open}
    <div class="panel">
      <div class="row">
        <span class="k">drakkar-ui</span>
        <span class="v mono">{__APP_VERSION__}</span>
      </div>
      {#if identity?.backend}
        <div class="row">
          <span class="k">backend</span>
          <span class="v mono">{identity.backend}{identity.backend_version ? ` ${identity.backend_version}` : ''}</span>
        </div>
        {#if servedUI}
          <div class="row">
            <span class="k">served UI</span>
            <span class="v mono">{servedUI}</span>
          </div>
        {/if}
      {:else if identity}
        <div class="muted">backend predates version reporting</div>
      {:else if failed}
        <div class="muted">backend identity unavailable</div>
      {:else}
        <div class="muted">loading…</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .badge {
    position: relative;
  }
  .version {
    color: #6b7280;
    font-size: 0.75rem;
    white-space: nowrap;
    background: transparent;
    border: none;
    padding: 0;
  }
  .version:hover {
    color: #fff;
  }
  .panel {
    position: absolute;
    right: 0;
    margin-top: 0.35rem;
    min-width: 15rem;
    background: #3d3d3d;
    border-radius: 6px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    z-index: 50;
    padding: 0.4rem 0;
  }
  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.3rem 0.75rem;
    font-size: 0.8rem;
  }
  .k {
    color: #9ca3af;
  }
  .v {
    color: #e5e7eb;
  }
  .mono {
    font-family: var(--mono);
  }
  .muted {
    padding: 0.35rem 0.75rem;
    color: #9ca3af;
    font-size: 0.8rem;
  }
</style>
