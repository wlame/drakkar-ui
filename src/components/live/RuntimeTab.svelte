<script lang="ts">
  // Runtime tab: how healthy the worker's runtime is (event-loop lag on
  // Python backends), what blocked it (stall stacks), and what it carries
  // (unit census, fetched on demand). Data comes from the runtime/health
  // snapshot + runtime_stall recorder events; the parent bumps refreshSeq
  // when a runtime_* WS frame arrives so an open tab stays current.
  import { api } from '../../lib/api'
  import type { EventRow, RuntimeHealthSnapshot, RuntimeUnitCensus } from '../../lib/types'
  import { fmtTime } from '../../lib/format'
  import {
    STATE_COLORS,
    fmtLagMs,
    sparklinePoints,
    stallFromMetadata,
    windowPeakMs,
  } from '../../lib/runtime'
  import CodeBlock from '../CodeBlock.svelte'

  let { refreshSeq = 0 }: { refreshSeq?: number } = $props()

  const SPARK_W = 640
  const SPARK_H = 60
  const STALL_LIMIT = 20

  let snapshot = $state<RuntimeHealthSnapshot | null>(null)
  let availability = $state<'loading' | 'available' | 'absent' | 'error'>('loading')
  let stallEvents = $state<EventRow[]>([])
  let openStallId = $state<number | null>(null)
  let census = $state<RuntimeUnitCensus | null>(null)
  let censusState = $state<'idle' | 'loading' | 'stalled' | 'error'>('idle')

  async function reload() {
    try {
      const snap = await api.runtimeHealth()
      if (snap === null) {
        availability = 'absent'
        snapshot = null
        return
      }
      snapshot = snap
      availability = 'available'
    } catch {
      availability = 'error'
      return
    }
    try {
      stallEvents = await api.events({ event_types: 'runtime_stall', limit: STALL_LIMIT })
    } catch {
      // Stall history is additive detail — a failed events query must not
      // blank the snapshot above.
    }
  }

  // Reload on mount and whenever the parent sees a runtime_* WS frame.
  $effect(() => {
    void refreshSeq
    reload()
  })

  async function sampleCensus() {
    censusState = 'loading'
    try {
      census = await api.debugRuntimeUnits()
      censusState = 'idle'
    } catch (err) {
      censusState = err instanceof Error && err.message.includes('503') ? 'stalled' : 'error'
    }
  }

  const stateColor = $derived(snapshot ? STATE_COLORS[snapshot.state] : 'var(--line)')
  const points = $derived(snapshot ? sparklinePoints(snapshot.window, SPARK_W, SPARK_H) : '')
  const peakMs = $derived(snapshot ? windowPeakMs(snapshot.window) : 0)
</script>

{#if availability === 'loading'}
  <p class="muted">Loading runtime health…</p>
{:else if availability === 'absent'}
  <p class="muted">
    No runtime monitor on this worker — <code>runtime_health.enabled</code> is off, or this
    backend does not implement the monitor (Go workers currently serve only the unit census).
  </p>
{:else if availability === 'error'}
  <p class="muted">Failed to load runtime health.</p>
{:else if snapshot}
  <div class="cards">
    <div class="card">
      <span class="label">State</span>
      <span class="badge" style:background={stateColor}>{snapshot.state}</span>
    </div>
    <div class="card">
      <span class="label">Current lag</span>
      <span class="mono">{fmtLagMs(snapshot.current_lag_ms)}</span>
    </div>
    <div class="card">
      <span class="label">Window peak</span>
      <span class="mono">{fmtLagMs(peakMs)}</span>
    </div>
    <div class="card">
      <span class="label">Heartbeat age</span>
      <span class="mono">{fmtLagMs(snapshot.heartbeat_age_ms)}</span>
    </div>
  </div>

  <div class="spark-wrap">
    {#if points}
      <svg
        viewBox="0 0 {SPARK_W} {SPARK_H}"
        preserveAspectRatio="none"
        role="img"
        aria-label="Lag sparkline, peak {fmtLagMs(peakMs)}"
      >
        <polyline {points} fill="none" stroke={stateColor} stroke-width="1.5" />
      </svg>
      <p class="muted small">
        max lag per second, last {snapshot.window.length}s of activity — peak {fmtLagMs(peakMs)}
      </p>
    {:else}
      <p class="muted">No lag history yet.</p>
    {/if}
  </div>

  <h4>Stalls</h4>
  {#if stallEvents.length === 0}
    <p class="muted">No stalls recorded — nothing has blocked the runtime.</p>
  {:else}
    <table>
      <thead>
        <tr><th>When</th><th>Duration</th><th>Blocking sites</th><th>Units</th></tr>
      </thead>
      <tbody>
        {#each stallEvents as row (row.id)}
          {@const stall = stallFromMetadata(row.metadata)}
          <tr
            class="stall-row"
            class:open={openStallId === row.id}
            onclick={() => (openStallId = openStallId === row.id ? null : row.id)}
          >
            <td class="mono">{fmtTime(row.ts)}</td>
            <td class="mono">{fmtLagMs(stall.duration_ms)}</td>
            <td>
              {stall.stacks.length}{stall.dropped_stacks ? ` (+${stall.dropped_stacks} dropped)` : ''}
            </td>
            <td class="mono">{stall.unit_count >= 0 ? stall.unit_count : '—'}</td>
          </tr>
          {#if openStallId === row.id}
            <tr class="stall-detail">
              <td colspan="4">
                <!-- Deliberately unkeyed: two captured stacks can share a
                     location (same blocking site, different call paths), and
                     keying on it crashed the expand with each_key_duplicate.
                     The list is replaced wholesale on reload, so identity
                     tracking buys nothing here. -->
                {#each stall.stacks as stack}
                  <p class="mono small">
                    {stack.location} — sampled {stack.count}×
                  </p>
                  <CodeBlock text={stack.stack} language="plaintext" />
                {:else}
                  <p class="muted">No stacks captured for this stall.</p>
                {/each}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
  {/if}

  <h4>
    Unit census
    <button onclick={sampleCensus} disabled={censusState === 'loading'}>
      {censusState === 'loading' ? 'Sampling…' : 'Sample now'}
    </button>
  </h4>
  {#if censusState === 'stalled'}
    <p class="muted">
      Census timed out — the runtime is not serving work right now, which is itself the
      diagnosis. The stall list above should explain why.
    </p>
  {:else if censusState === 'error'}
    <p class="muted">Census request failed.</p>
  {:else if census}
    <p class="muted small">{census.total} {census.unit_label} in {census.units.length} groups</p>
    <table>
      <thead>
        <tr><th>Count</th><th>Name</th><th>Suspended at</th><th>Example</th></tr>
      </thead>
      <tbody>
        {#each census.units as unit (unit.name + unit.location)}
          <tr>
            <td class="mono">{unit.count}</td>
            <td class="mono">{unit.name}</td>
            <td class="mono">{unit.location || '—'}</td>
            <td class="mono muted">{unit.example}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else}
    <p class="muted">
      Groups live {snapshot.unit_label} by where they are suspended. Sampling walks every unit
      once — cheap, but on demand only.
    </p>
  {/if}
{/if}

<style>
  .cards {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.9rem;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
    min-width: 7.5rem;
  }
  .label {
    font-size: 0.75rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .badge {
    align-self: flex-start;
    color: #111;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.05rem 0.6rem;
    font-size: 0.85rem;
  }
  .spark-wrap {
    margin-bottom: 1rem;
  }
  .spark-wrap svg {
    width: 100%;
    height: 60px;
    display: block;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 8px;
  }
  h4 {
    margin: 1rem 0 0.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  h4 button {
    font: inherit;
    font-size: 0.8rem;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.15rem 0.6rem;
    cursor: pointer;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  th,
  td {
    text-align: left;
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid var(--line);
  }
  th {
    color: var(--muted);
    font-weight: 500;
  }
  .stall-row {
    cursor: pointer;
  }
  .stall-row.open td {
    border-bottom: none;
  }
  .mono {
    font-family: var(--mono, monospace);
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.8rem;
  }
</style>
