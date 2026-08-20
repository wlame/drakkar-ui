<script lang="ts">
  // Runtime tab: how healthy the worker's runtime is (event-loop lag on
  // Python backends), what blocked or starved it (stalls + lag episodes
  // with verdicts), which resource the host is fighting for (host
  // pressure), and what the runtime carries (unit census, on demand).
  //
  // Stall evidence deliberately merges THREE sources: persisted
  // runtime_stall / runtime_lag_episode rows, the snapshot's in-memory
  // recent_stalls / recent_episodes, and the snapshot's current_episode.
  // The persisted path dies exactly during the incidents this tab exists
  // for (degraded recorder, wedged loop); monitor memory does not.
  import { api } from '../../lib/api'
  import type { EventRow, RuntimeHealthSnapshot, RuntimeUnitCensus } from '../../lib/types'
  import { fmtTime } from '../../lib/format'
  import {
    STATE_COLORS,
    VERDICT_LABELS,
    aggregateStallSites,
    fmtLagMs,
    mergeStallSources,
    sparklinePoints,
    windowPeakMs,
  } from '../../lib/runtime'
  import { hostPressureFromEvent, throttlePct, type HostPressure } from '../../lib/hostpressure'
  import CodeBlock from '../CodeBlock.svelte'

  let {
    refreshSeq = 0,
    hostPressure = null,
  }: { refreshSeq?: number; hostPressure?: HostPressure | null } = $props()

  const SPARK_W = 640
  const SPARK_H = 60
  // 100 rather than a screenful: the aggregation below is only as good as
  // the history it sees, and stall rows are small.
  const STALL_LIMIT = 100

  let snapshot = $state<RuntimeHealthSnapshot | null>(null)
  let availability = $state<'loading' | 'available' | 'absent' | 'error'>('loading')
  let stallEvents = $state<EventRow[]>([])
  let episodeEvents = $state<EventRow[]>([])
  let fetchedPressure = $state<HostPressure | null>(null)
  let openItemId = $state<string | null>(null)
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
      const rows = await api.events({
        event_types: 'runtime_stall,runtime_lag_episode',
        limit: STALL_LIMIT,
      })
      stallEvents = rows.filter((row) => row.event === 'runtime_stall')
      episodeEvents = rows.filter((row) => row.event === 'runtime_lag_episode')
    } catch {
      // Stall history is additive detail — a failed events query must not
      // blank the snapshot above; the snapshot's own summaries still render.
    }
    if (!hostPressure) {
      // No WS sample yet (tab opened before the first 10s tick): seed the
      // Host section from the newest persisted sample.
      try {
        const samples = await api.events({ event_types: 'resource_sample', limit: 1 })
        if (samples.length > 0) fetchedPressure = hostPressureFromEvent(samples[0])
      } catch {
        // Same rule: additive detail only.
      }
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

  const pressure = $derived(hostPressure ?? fetchedPressure)
  const throttle = $derived(
    pressure ? throttlePct(pressure.throttledMs, pressure.intervalS) : null,
  )
  const stallSites = $derived(aggregateStallSites(stallEvents))
  const stallItems = $derived(mergeStallSources(stallEvents, episodeEvents, snapshot))
  const currentEpisode = $derived(snapshot?.current_episode ?? null)
  const stateColor = $derived(snapshot ? STATE_COLORS[snapshot.state] : 'var(--line)')
  const points = $derived(snapshot ? sparklinePoints(snapshot.window, SPARK_W, SPARK_H) : '')
  const peakMs = $derived(snapshot ? windowPeakMs(snapshot.window) : 0)
</script>

{#if availability === 'loading'}
  <p class="muted">Loading runtime health…</p>
{:else if availability === 'absent'}
  <p class="muted">
    No runtime monitor on this worker — <code>runtime_health.enabled</code> is off.
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

  {#if pressure}
    <h4>Host</h4>
    <p class="muted small">
      Which resource is the host fighting for — sampled every state-sync tick, host-wide where
      the source is (load, pressure), per cgroup or mount where it can be.
    </p>
    <div class="cards">
      {#if pressure.load1 !== null}
        <div class="card">
          <span class="label">Load 1m / 5m</span>
          <span class="mono">{pressure.load1}{pressure.load5 !== null ? ` / ${pressure.load5}` : ''}</span>
        </div>
      {/if}
      {#if pressure.psiCpuSome !== null}
        <div class="card">
          <span class="label">PSI cpu</span>
          <span class="mono">{pressure.psiCpuSome.toFixed(1)}%</span>
        </div>
      {/if}
      {#if pressure.psiIoSome !== null}
        <div class="card">
          <span class="label">PSI io some / full</span>
          <span class="mono"
            >{pressure.psiIoSome.toFixed(1)}%{pressure.psiIoFull !== null
              ? ` / ${pressure.psiIoFull.toFixed(1)}%`
              : ''}</span
          >
        </div>
      {/if}
      {#if pressure.psiMemSome !== null}
        <div class="card">
          <span class="label">PSI mem</span>
          <span class="mono">{pressure.psiMemSome.toFixed(1)}%</span>
        </div>
      {/if}
      {#if throttle !== null}
        <div class="card">
          <span class="label">CPU throttled</span>
          <span class="mono">{throttle}%</span>
        </div>
      {/if}
      {#if pressure.schedLatencyP99Ms !== null}
        <div class="card">
          <span class="label">Sched p99</span>
          <span class="mono">{fmtLagMs(pressure.schedLatencyP99Ms)}</span>
        </div>
      {/if}
      {#if pressure.goroutines !== null}
        <div class="card">
          <span class="label">Goroutines</span>
          <span class="mono">{pressure.goroutines}</span>
        </div>
      {/if}
    </div>
    {#if pressure.nfsMounts.length > 0}
      <table class="sites">
        <thead>
          <tr><th>NFS mount</th><th>Avg RTT / op</th><th>Retransmits</th><th>Ops</th></tr>
        </thead>
        <tbody>
          {#each pressure.nfsMounts as mount (mount.mount)}
            <tr>
              <td class="mono">{mount.mount}</td>
              <td class="mono" class:alert={mount.rtt_ms >= 100}>{fmtLagMs(mount.rtt_ms)}</td>
              <td class="mono" class:alert={mount.retrans > 0}>{mount.retrans}</td>
              <td class="mono">{mount.ops}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="muted small">
        Per interval, from the kernel's NFS client counters. RTT is the server round-trip per
        operation — it multiplies under storage contention while byte throughput can look normal;
        retransmits mean the server is not answering.
      </p>
    {/if}
  {/if}

  <h4>Stalls & episodes</h4>
  {#if currentEpisode}
    <div class="episode-live">
      <span class="chip" data-verdict={currentEpisode.verdict}
        >{VERDICT_LABELS[currentEpisode.verdict].label}</span
      >
      <span>
        <strong>Episode in progress</strong> — {fmtLagMs(currentEpisode.wall_ms)} so far, peak lag
        {fmtLagMs(currentEpisode.peak_lag_ms)}, {currentEpisode.sample_count} stack samples{currentEpisode.cpu_ms !==
        null
          ? `, ${fmtLagMs(currentEpisode.cpu_ms)} runtime CPU`
          : ''}.
      </span>
      <span class="muted small">{VERDICT_LABELS[currentEpisode.verdict].hint}</span>
    </div>
  {/if}
  {#if stallItems.length === 0 && !currentEpisode}
    <p class="muted">No stalls or lag episodes recorded — nothing has degraded the runtime.</p>
  {:else}
    {#if stallSites.length > 0}
      <!-- Aggregate first, list second: across many stalls the site that KEEPS
           appearing is the fix target, and no one finds it by expanding rows
           one at a time. -->
      <p class="muted small">
        Top blocking sites across the last {stallEvents.length} recorded stalls. Total time is an
        upper bound — sites captured in the same stall share its duration.
      </p>
      <table class="sites">
        <thead>
          <tr><th>Blocking site</th><th>Samples</th><th>Stalls</th><th>Total stall time</th><th>Last seen</th></tr>
        </thead>
        <tbody>
          {#each stallSites.slice(0, 10) as site (site.location)}
            <tr>
              <td class="mono">{site.location}</td>
              <td class="mono">{site.samples}</td>
              <td class="mono">{site.stalls}</td>
              <td class="mono">{fmtLagMs(site.totalMs)}</td>
              <td class="mono">{fmtTime(site.lastTs)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
    <table>
      <thead>
        <tr><th>When</th><th>Kind</th><th>Duration</th><th>Verdict</th><th>Stacks</th><th>Units</th></tr>
      </thead>
      <tbody>
        {#each stallItems as item (item.id)}
          <tr
            class="stall-row"
            class:open={openItemId === item.id}
            onclick={() => (openItemId = openItemId === item.id ? null : item.id)}
          >
            <td class="mono">{fmtTime(item.t)}</td>
            <td>
              {item.kind}{item.kind === 'episode' && item.stallCount
                ? ` (${item.stallCount} stalls)`
                : ''}{item.fromSnapshotOnly ? ' *' : ''}
            </td>
            <td class="mono">{fmtLagMs(item.durationMs)}</td>
            <td>
              {#if item.verdict}
                <span class="chip" data-verdict={item.verdict} title={VERDICT_LABELS[item.verdict].hint}
                  >{VERDICT_LABELS[item.verdict].label}</span
                >
              {:else}
                <span class="muted">—</span>
              {/if}
            </td>
            <td>
              {item.stackCount}{item.droppedStacks ? ` (+${item.droppedStacks} dropped)` : ''}
            </td>
            <td class="mono">{item.unitCount ?? '—'}</td>
          </tr>
          {#if openItemId === item.id}
            <tr class="stall-detail">
              <td colspan="6">
                {#if item.verdict}
                  <p class="small">{VERDICT_LABELS[item.verdict].hint}</p>
                {/if}
                <!-- Deliberately unkeyed: two captured stacks can share a
                     location (same blocking site, different call paths), and
                     keying on it crashed the expand with each_key_duplicate.
                     The list is replaced wholesale on reload, so identity
                     tracking buys nothing here. -->
                {#each item.stacks as stack}
                  <p class="mono small">
                    {stack.location} — sampled {stack.count}×
                  </p>
                  <CodeBlock text={stack.stack} language="plaintext" />
                {:else}
                  <p class="muted">
                    {item.fromSnapshotOnly
                      ? 'Known from monitor memory only — the persisted event (with stacks) has not landed, which usually means the recorder was degraded at the time.'
                      : 'No stacks captured.'}
                  </p>
                {/each}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if stallItems.some((item) => item.fromSnapshotOnly)}
      <p class="muted small">
        * from monitor memory — the persisted event has not landed (degraded recorder).
      </p>
    {/if}
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
  .chip {
    display: inline-block;
    color: #111;
    font-weight: 600;
    border-radius: 999px;
    padding: 0.05rem 0.6rem;
    font-size: 0.8rem;
    background: var(--line);
  }
  .chip[data-verdict='blocked'] {
    background: #f87171;
  }
  .chip[data-verdict='cpu_bound'] {
    background: #fbbf24;
  }
  .chip[data-verdict='starved'] {
    background: #c084fc;
  }
  .chip[data-verdict='inconclusive'] {
    background: #94a3b8;
  }
  .episode-live {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.6rem 0.9rem;
    margin-bottom: 0.75rem;
    background: var(--panel-2);
    border: 1px solid #f87171;
    border-radius: 8px;
  }
  .alert {
    color: #f87171;
    font-weight: 600;
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
  .sites {
    margin-bottom: 1rem;
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
