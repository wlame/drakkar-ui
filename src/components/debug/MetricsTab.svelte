<script lang="ts">
  // Metrics tab: live Prometheus snapshot for this worker, split into user vs
  // framework families with client-side show/hide filters (ports debug.html metrics).
  import { onMount } from 'svelte'
  import { api, type MetricFamily } from '../../lib/api'

  let metrics = $state<MetricFamily[] | null>(null)
  let error = $state<string | null>(null)
  let showUser = $state(true)
  let showFramework = $state(true)

  const TYPE_COLORS: Record<string, string> = {
    counter: '#2563eb',
    gauge: '#059669',
    histogram: '#d97706',
    info: '#9333ea',
    summary: '#a855f7',
  }
  const SOURCE_COLORS: Record<string, string> = { framework: '#6b7280', user: '#0d9488' }

  // Compact numeric formatting matching the reference's fmtVal.
  function fmtVal(v: number): string {
    if (v === 0) return '0'
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`
    if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`
    if (Number.isInteger(v)) return String(v)
    if (Math.abs(v) < 0.01) return v.toExponential(2)
    return v.toFixed(3)
  }

  function labelStr(labels: Record<string, string>): string {
    return Object.entries(labels)
      .map(([k, val]) => `${k}=${val}`)
      .join(',')
  }

  const sections = $derived(
    (['user', 'framework'] as const)
      .filter((s) => (s === 'user' ? showUser : showFramework))
      .map((s) => ({ source: s, families: (metrics ?? []).filter((m) => m.source === s) }))
      .filter((sec) => sec.families.length > 0),
  )

  async function load() {
    error = null
    try {
      metrics = await api.debugMetrics()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(load)
</script>

<div class="bar">
  <label><input type="checkbox" bind:checked={showUser} /> User</label>
  <label><input type="checkbox" bind:checked={showFramework} /> Framework</label>
  <button onclick={load}>Refresh</button>
</div>

{#if error}
  <p class="error">Failed to load metrics: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !metrics}
  <p class="muted">Loading…</p>
{:else if sections.length === 0}
  <p class="muted">{metrics.length === 0 ? 'No metrics registered' : 'All metrics hidden by filters'}</p>
{:else}
  {#each sections as sec}
    <h2 class="section" style:color={SOURCE_COLORS[sec.source]}>{sec.source} metrics ({sec.families.length})</h2>
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Description</th><th>Values</th></tr>
      </thead>
      <tbody>
        {#each sec.families as m (m.name)}
          <tr>
            <td class="mono">{m.name}</td>
            <td><span style:color={TYPE_COLORS[m.type] ?? 'var(--muted)'}>{m.type}</span></td>
            <td class="muted help" title={m.help}>{m.help}</td>
            <td class="mono vals">
              {#if m.samples.length === 0}
                -
              {:else if m.samples.length === 1 && Object.keys(m.samples[0].labels).length === 0}
                {fmtVal(m.samples[0].value)}
              {:else}
                {#each m.samples as s}
                  {@const suffix = s.name.replace(m.name, '').replace(/^_/, '')}
                  <div>{#if suffix}{suffix} {/if}{#if Object.keys(s.labels).length}<span class="muted">{`{${labelStr(s.labels)}}`}</span> {/if}{fmtVal(s.value)}</div>
                {/each}
              {/if}
            </td>
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
    gap: 1rem;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }
  .bar label {
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
  }
  .help {
    max-width: 28rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vals div {
    font-size: 0.8rem;
  }
  .section {
    font-size: 0.72rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 1.5rem 0 0.5rem;
  }
</style>
