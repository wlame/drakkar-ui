<script lang="ts">
  // Debug tools (ports debug.html): six hash-routed tabs. The Cache tab only
  // appears when the backend has a cache engine (detected by probing
  // /api/v1/debug/cache/stats). The #trace/<partition>/<offset> deep-link activates
  // the Trace tab and prefills it — this is the target of the offset links across
  // the app. When /api/v1/identity returns a non-empty config_summary, the page
  // title is replaced by the reference's full-width mono config banner; older
  // backends without the endpoint gracefully keep the plain heading.
  import { onMount } from 'svelte'
  import { api } from '../lib/api'
  import { hash, setHash } from '../lib/router'
  import MetricsTab from '../components/debug/MetricsTab.svelte'
  import PeriodicTab from '../components/debug/PeriodicTab.svelte'
  import TraceTab from '../components/debug/TraceTab.svelte'
  import ProbeTab from '../components/debug/ProbeTab.svelte'
  import CacheTab from '../components/debug/CacheTab.svelte'
  import DatabasesTab from '../components/debug/DatabasesTab.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  type Tab = 'metrics' | 'periodic' | 'trace' | 'probe' | 'cache' | 'databases'

  let cacheEnabled = $state(false)
  let configSummary = $state('')

  const TAB_LABELS: Record<Tab, string> = {
    metrics: 'Metrics',
    periodic: 'Periodic Tasks',
    trace: 'Message Trace',
    probe: 'Message Probe',
    cache: 'Cache',
    databases: 'Databases',
  }
  const availableTabs = $derived<Tab[]>([
    'metrics',
    'periodic',
    'trace',
    'probe',
    ...(cacheEnabled ? (['cache'] as Tab[]) : []),
    'databases',
  ])

  // #trace/<p>/<o> deep-link → Trace tab + prefill.
  const traceMatch = $derived.by(() => {
    const m = $hash.match(/^#trace\/(\d+)\/(\d+)$/)
    return m ? { partition: Number(m[1]), offset: Number(m[2]) } : null
  })

  const activeTab = $derived.by<Tab>(() => {
    if (traceMatch) return 'trace'
    const name = $hash.replace(/^#/, '') as Tab
    return availableTabs.includes(name) ? name : 'metrics'
  })

  onMount(async () => {
    // Independent capability probes; each failure only disables its own feature.
    api
      .identity()
      .then((id) => {
        configSummary = id.config_summary
      })
      .catch(() => {
        // 404 on older backends — keep the plain heading.
      })
    try {
      await api.cacheStats()
      cacheEnabled = true
    } catch {
      cacheEnabled = false
    }
  })
</script>

{#if configSummary}
  <div class="config-banner">{configSummary}</div>
{:else}
  <h1>Debug Tools</h1>
{/if}

<div class="tabs">
  {#each availableTabs as t}
    <button class="tab" class:active={activeTab === t} onclick={() => setHash(`#${t}`)}>{TAB_LABELS[t]}</button>
  {/each}
</div>

{#if activeTab === 'metrics'}
  <MetricsTab />
{:else if activeTab === 'periodic'}
  <PeriodicTab />
{:else if activeTab === 'trace'}
  <TraceTab prefill={traceMatch} />
{:else if activeTab === 'probe'}
  <ProbeTab />
{:else if activeTab === 'cache'}
  <CacheTab />
{:else if activeTab === 'databases'}
  <DatabasesTab />
{/if}

<style>
  /* Config-summary banner — ports the reference's `mb-6 px-4 py-3 rounded-lg
     border border-cream-200 font-mono text-xs text-ink-700 break-all select-all`
     panel shown above the tab bar. */
  .config-banner {
    margin-bottom: 1.5rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #faf9f6;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--text);
    word-break: break-all;
    user-select: all;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--line);
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .tab {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    color: var(--muted);
    padding: 0.5rem 0.8rem;
  }
  .tab:hover {
    color: var(--text);
  }
  .tab.active {
    color: var(--text);
    border-bottom-color: #0d9488;
  }
</style>
