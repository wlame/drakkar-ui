<script lang="ts">
  // One cluster peer's timeline: its own WebSocket to the peer's /ws plus a
  // Timeline fed from it, headed by the worker name and a WS badge.
  //
  // WS only, deliberately: the peer's REST API is another origin and the
  // backends send no CORS headers, so a cross-origin /recent-tasks backfill
  // (or resync) would be blocked by the browser. Two practical consequences:
  //
  //   * A peer strip starts empty and fills from the moment cluster view
  //     opened — no history backfill.
  //   * There is no DB reconciliation, so events are applied even while the
  //     page is frozen: dropping frames (what the Live page's freeze does)
  //     would leave permanent holes in the strip. The freeze still stops the
  //     clock — `paused` reaches the Timeline — it just doesn't stop data.
  import { onMount } from 'svelte'
  import { peerBaseUrl, type SharedTimelineControls } from '../../lib/cluster'
  import { netFromEvent, type NetRates, type TaskView } from '../../lib/live'
  import { applyTaskEvent, laneCountFromTasks, pruneFinishedBefore } from '../../lib/taskStore'
  import { DEFAULT_MAX_AGE_MINUTES } from '../../lib/timeline'
  import type { TimelineConfig, WorkerPeer } from '../../lib/types'
  import { pausableInterval } from '../../lib/visibility'
  import { createLiveSocket, WS_STATUS_LABELS, type LiveSocket, type WsStatus } from '../../lib/ws'
  import Timeline from './Timeline.svelte'
  import TimelineStats from './TimelineStats.svelte'

  let {
    peer,
    shared,
    paused = false,
    minDurationMs = 0,
    timeline = undefined,
    fallbackLaneCount = 8,
  }: {
    peer: WorkerPeer
    shared: SharedTimelineControls
    paused?: boolean
    minDurationMs?: number
    // The CURRENT worker's ui.timeline config, reused for every peer: their
    // /identity is unreachable cross-origin, and workers of one cluster run
    // one config in practice.
    timeline?: TimelineConfig
    // The CURRENT worker's lane count, on the same reasoning — this peer's
    // strip grows past it only when its own tasks prove a higher slot.
    fallbackLaneCount?: number
  } = $props()

  const PEER_EVENT_TYPES = ['task_started', 'task_completed', 'task_failed', 'net_io']
  const PRUNE_INTERVAL_MS = 5000

  let status = $state<WsStatus>('connecting')
  let allTasks = $state<Record<string, TaskView>>({})
  // This peer's host network throughput — each peer runs on its own host, so
  // in cluster view the per-strip readout shows which machine's NIC is busy.
  let net = $state<NetRates | null>(null)
  let socket: LiveSocket | null = null

  // Same reasoning as the Live page: a frozen rate reads as current, so the
  // readout goes away when the frames do.
  $effect(() => {
    if (status !== 'connected') net = null
  })

  const tasksList = $derived(Object.values(allTasks))
  const laneCount = $derived(laneCountFromTasks(tasksList, fallbackLaneCount))
  const maxAgeMinutes = $derived(timeline?.max_age_minutes ?? DEFAULT_MAX_AGE_MINUTES)
  const base = $derived(peerBaseUrl(peer))

  // With no resync rebuilding the map, finished tasks that scrolled out of
  // the window must be swept, or the map grows for as long as the view is up.
  function pruneStale() {
    pruneFinishedBefore(allTasks, Date.now() / 1000 - maxAgeMinutes * 60)
  }

  onMount(() => {
    socket = createLiveSocket({
      baseUrl: base,
      eventTypes: PEER_EVENT_TYPES,
      onEvent: (e) => {
        if (e.event === 'net_io') {
          const rates = netFromEvent(e)
          if (rates) net = rates
          return
        }
        applyTaskEvent(allTasks, e)
      },
      onStatus: (s) => (status = s),
      // No onGap/onOpen resync: unreachable cross-origin (see header note).
      // A drop or reconnect just leaves a visible gap in the strip.
    })
    const stopPrune = pausableInterval(pruneStale, PRUNE_INTERVAL_MS)
    return () => {
      stopPrune()
      socket?.close()
    }
  })
</script>

<div class="peer-head">
  <h3 class="peer-name">{peer.worker_name || '?'}</h3>
  <span class="badge status-{status}">WS: {WS_STATUS_LABELS[status]}</span>
  {#if net}
    {#if net.nfs_read_mib_s != null && net.nfs_write_mib_s != null}
      <span
        class="net"
        title="This worker's NFS server transfer (mountstats) — visible even where the interface counters cannot see kernel-NFS traffic"
      >NFS R {net.nfs_read_mib_s.toFixed(1)} · W {net.nfs_write_mib_s.toFixed(1)}</span>
    {/if}
    <span
      class="net"
      title="This worker's network-namespace throughput, all interfaces (kernel-NFS traffic not included in a container — see the NFS readout)"
    >RX {net.rx_mib_s.toFixed(1)} · TX {net.tx_mib_s.toFixed(1)} MiB/s</span>
  {/if}
</div>
<Timeline
  tasks={tasksList}
  {laneCount}
  {paused}
  {minDurationMs}
  {timeline}
  workerId={peer.worker_name}
  {shared}
  showHeader={false}
  showToolbar={false}
  taskUrlBase={base}
/>
<TimelineStats tasks={tasksList} {shared} attached />

<style>
  .peer-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
  }
  .peer-name {
    font-size: 1rem;
    font-weight: 600;
    font-family: var(--mono);
    color: #1a1a1a;
    margin: 0;
  }
  .net {
    font-size: 0.8125rem;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
  /* Same badge idiom as the page header's WS pill. */
  .badge {
    font-size: 0.75rem;
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: #fecaca;
    color: #991b1b;
    border: 1px solid #fca5a5;
  }
  .status-connected {
    background: #d1fae5;
    color: #065f46;
    border-color: #6ee7b7;
  }
</style>
