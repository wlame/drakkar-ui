<script lang="ts">
  // Live pipeline (ports live.html). The WebSocket /ws stream drives the live view:
  // task_started/completed/failed update the executor timeline + pool, arranged
  // updates the Arrange tab. Every 5s a DB resync via /api/v1/recent-tasks reconciles
  // anything missed (the WS drops frames for slow consumers and hides sub-threshold
  // fast tasks). The on_*_complete result feeds poll every 5s like the reference.
  import { onMount } from 'svelte'
  import { api } from '../lib/api'
  import type { ArrangeTaskState, TaskResult, MessageResult, WindowResult, WsEvent, WorkerPeer } from '../lib/api'
  import { hash, setHash } from '../lib/router'
  import { hydrateFromOverview, runtimeConfig, identity } from '../lib/config'
  import { createLiveSocket, WS_STATUS_LABELS, type WsStatus, type LiveSocket } from '../lib/ws'
  import { pausableInterval, visibilityGate } from '../lib/visibility'
  import { DEFAULT_MAX_AGE_MINUTES } from '../lib/timeline'
  import { peerBaseUrl, sameClusterPeers, type SharedTimelineControls } from '../lib/cluster'
  import { applyTaskEvent, mergeRecentTasks } from '../lib/taskStore'
  import {
    saveRoleOverride,
    clearRoleOverride,
    clearAllRoleOverrides,
    type TimelineRole,
  } from '../lib/timelineRoles'
  import {
    normalizeRecentTasks,
    arrangeFromEvent,
    annotationFromEvent,
    type NormalizedRecentTasks,
    type TaskView,
    type ArrangeView,
    type AnnotationView,
  } from '../lib/live'
  import Timeline from '../components/live/Timeline.svelte'
  import PeerTimeline from '../components/live/PeerTimeline.svelte'
  import ArrangeTab from '../components/live/ArrangeTab.svelte'
  import ResultsTab from '../components/live/ResultsTab.svelte'
  import RuntimeTab from '../components/live/RuntimeTab.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  // The only event types this page renders. Declared to the server so it never
  // encodes or queues the rest for us — on a fan-out workload the completion
  // hooks emit one event per task, and those feeds are poll-backed here
  // (see reloadFeeds), so receiving them live would be pure waste.
  const LIVE_EVENT_TYPES = [
    'task_started',
    'task_completed',
    'task_failed',
    'arranged',
    'annotation',
  ]

  // --- bootstrap config (best-effort; defaults keep the page working) ---
  let hookFlags = $state({ task_complete: false, message_complete: false, window_complete: false })
  let partitionCount = $state(0)
  let maxHistory = $state(5000)
  let laneCount = $state(8)

  // --- live state ---
  let status = $state<WsStatus>('connecting')
  let frozen = $state(false)
  // The server capped the timeline scan — say so rather than presenting a
  // partial window as if it were the whole thing.
  let truncated = $state(false)
  // The last resync brought back nothing usable — a degraded recorder read or
  // a failed request. Everything on screen is then the last good state, which
  // is worth saying out loud: a frozen live page looks like an idle worker.
  let dataUnavailable = $state(false)
  let pool = $state({ active: 0, max: 0, waiting: 0 })
  // Bumped on runtime_health / runtime_stall WS frames; the Runtime tab
  // refetches its snapshot when this changes.
  let runtimeSeq = $state(0)
  let allTasks = $state<Record<string, TaskView>>({})
  let arranges = $state<ArrangeView[]>([])
  let annotations = $state<AnnotationView[]>([])
  let arrangeStates = $state<Record<string, ArrangeTaskState>>({})
  let taskResults = $state<TaskResult[]>([])
  let messageResults = $state<MessageResult[]>([])
  let windowResults = $state<WindowResult[]>([])

  let socket: LiveSocket | null = null

  // ui.timeline (bar colors, label roles, history depth) travels on the
  // identity payload. Absent on backends that predate it — the timeline then
  // keeps its legacy 10-minute window and fixed status colors.
  const timelineConfig = $derived($identity?.timeline)
  const maxAgeMinutes = $derived(timelineConfig?.max_age_minutes ?? DEFAULT_MAX_AGE_MINUTES)

  // The first resync runs before /identity lands, so it asks for the default
  // depth. Refetch as soon as the configured depth turns out to differ, rather
  // than leaving a short window on screen until the next 5s tick.
  let requestedMaxAgeMinutes = DEFAULT_MAX_AGE_MINUTES
  $effect(() => {
    const minutes = maxAgeMinutes
    if (minutes === requestedMaxAgeMinutes) return
    requestedMaxAgeMinutes = minutes
    void resync()
  })

  const tasksList = $derived(Object.values(allTasks))

  // --- cluster view (Executors tab) -------------------------------------------
  //
  // Stacks a timeline for every worker of this cluster under one shared
  // toolbar. Deliberately NOT persisted: a refresh or navigation always comes
  // back in single-worker view.
  let clusterView = $state(false)
  let clusterPeers = $state<WorkerPeer[]>([])
  let clusterLoadFailed = $state(false)

  // Every worker id shown in cluster view — role overrides are stored per
  // worker, and the shared gear applies to all of them at once.
  const clusterWorkerIds = $derived([
    ...($identity?.worker_id ? [$identity.worker_id] : []),
    ...clusterPeers.map((w) => w.worker_name),
  ])

  // The one toolbar's state, shared by every stacked timeline (the first
  // Timeline renders the toolbar; the rest follow this object).
  const sharedControls = $state<SharedTimelineControls>({
    zoom: 2,
    highlightInput: '',
    filterInput: '',
    followSeq: 0,
    overridesSeq: 0,
    applyRole(role: TimelineRole, value: string | null) {
      for (const id of clusterWorkerIds) saveRoleOverride(id, role, value)
      sharedControls.overridesSeq += 1
    },
    resetRole(role: TimelineRole) {
      for (const id of clusterWorkerIds) clearRoleOverride(id, role)
      sharedControls.overridesSeq += 1
    },
    resetAllRoles() {
      for (const id of clusterWorkerIds) clearAllRoleOverrides(id)
      sharedControls.overridesSeq += 1
    },
  })

  function toggleClusterView() {
    clusterView = !clusterView
    if (clusterView) void loadClusterPeers()
  }

  async function loadClusterPeers() {
    clusterLoadFailed = false
    try {
      // A peer that advertised no reachable address cannot be connected to —
      // skip it rather than letting its WS client retry an unbuildable URL.
      clusterPeers = sameClusterPeers(await api.workers()).filter((w) => peerBaseUrl(w) !== '')
    } catch {
      clusterPeers = []
      clusterLoadFailed = true
    }
  }

  // --- tabs (hash-routed) ---
  type Tab = 'arrange' | 'execute' | 'task-results' | 'message-results' | 'window-results' | 'runtime'
  const availableTabs = $derived<Tab[]>([
    'arrange',
    'execute',
    ...(hookFlags.task_complete ? (['task-results'] as Tab[]) : []),
    ...(hookFlags.message_complete ? (['message-results'] as Tab[]) : []),
    ...(hookFlags.window_complete ? (['window-results'] as Tab[]) : []),
    // Always offered: the tab itself explains when this worker has no
    // monitor (runtime_health.enabled=false, or a Go backend).
    'runtime',
  ])
  const TAB_LABELS: Record<Tab, string> = {
    arrange: 'Arrange',
    execute: 'Executors',
    'task-results': 'Task Results',
    'message-results': 'Message Results',
    'window-results': 'Window Results',
    runtime: 'Runtime',
  }
  const activeTab = $derived.by<Tab>(() => {
    const name = $hash.replace(/^#/, '') as Tab
    return availableTabs.includes(name) ? name : 'execute'
  })
  // One-line explainer under the heading, switching with the active tab
  // (verbatim from the reference's tabHints map).
  const TAB_HINTS: Record<Tab, string> = {
    arrange:
      'Arrange is called after message polling for each partition. It receives a batch of messages and creates executor Tasks with CLI params to run.',
    execute:
      'Executors run CPU-bound Tasks as subprocesses with prepared CLI args, capturing stdout/stderr. Limited by the pool semaphore.',
    'task-results':
      "on_task_complete() runs after each task's subprocess exits. One row per call — shows exec runtime, hook runtime, and the number of sink payloads dispatched.",
    'message-results':
      "on_message_complete() runs after every task derived from one source message reaches a terminal state. Rows aggregate the message's fan-out outcomes.",
    'window-results':
      'on_window_complete() runs after every task in one arrange() window finishes. Rows summarize the whole window.',
    runtime:
      "Runtime health: how promptly the worker's runtime schedules work, what blocked it (stall stacks), and a census of what it is carrying.",
  }

  // --- WS event handling ---
  function applyPool(e: WsEvent) {
    if (e.pool_active !== undefined) pool.active = e.pool_active
    if (e.pool_waiting !== undefined) pool.waiting = e.pool_waiting
  }

  function onEvent(e: WsEvent) {
    switch (e.event) {
      case 'task_started':
      case 'task_completed':
      case 'task_failed': {
        // Shared with PeerTimeline (lib/taskStore) so the local worker and
        // the cluster peers interpret the stream identically — including the
        // retry archiving under composite `:r<start_ts>` keys.
        applyTaskEvent(allTasks, e)
        applyPool(e)
        break
      }
      case 'arranged': {
        const a = arrangeFromEvent(e)
        arranges = [a, ...arranges].slice(0, maxHistory)
        queueArrangeLookup(a.task_ids)
        break
      }
      case 'annotation': {
        // Handler diagnostics. Kept in their own bounded buffer rather than
        // folded into task state: they attach to a message or a window just as
        // often as to a task, so there is no single record they belong on.
        const ann = annotationFromEvent(e)
        if (ann) annotations = [ann, ...annotations].slice(0, maxHistory)
        break
      }
      case 'runtime_health':
      case 'runtime_stall': {
        // The Runtime tab owns its own fetches; this bump just tells an
        // open tab that fresher data exists (~1 frame per 10s sample, or
        // per transition/stall — never high-rate).
        runtimeSeq += 1
        break
      }
      // task_complete / message_complete / window_complete drive the poll-backed
      // result feeds; the next 5s reload (and tab open) picks them up.
    }
  }

  // --- Arrange task-state lookups ---
  //
  // One arrange() call can produce a thousand tasks, so this lookup is the
  // heaviest request the page makes: it POSTs task IDs and the server expands
  // them into a bind parameter each. Three things keep it bounded:
  //
  //   1. Terminal states are never re-requested. A task that reported
  //      completed or failed cannot change again.
  //   2. Requests are coalesced. Several arranged events arriving together
  //      produce one request, not one each.
  //   3. Each request is capped, with the remainder carried to the next tick.
  const ARRANGE_LOOKUP_MAX = 500
  const ARRANGE_LOOKUP_DEBOUNCE_MS = 300

  let pendingArrangeIds = new Set<string>()
  let arrangeLookupTimer: ReturnType<typeof setTimeout> | undefined

  function isTerminal(id: string): boolean {
    const s = arrangeStates[id]?.status
    return s === 'completed' || s === 'failed'
  }

  function queueArrangeLookup(taskIds: string[]) {
    for (const id of taskIds) {
      if (!isTerminal(id)) pendingArrangeIds.add(id)
    }
    if (pendingArrangeIds.size && arrangeLookupTimer === undefined) {
      arrangeLookupTimer = setTimeout(flushArrangeLookup, ARRANGE_LOOKUP_DEBOUNCE_MS)
    }
  }

  async function flushArrangeLookup() {
    arrangeLookupTimer = undefined
    if (frozen || !pendingArrangeIds.size) return
    const batch: string[] = []
    for (const id of pendingArrangeIds) {
      if (batch.length >= ARRANGE_LOOKUP_MAX) break
      batch.push(id)
    }
    for (const id of batch) pendingArrangeIds.delete(id)
    try {
      const res = await api.arrangeTasks(batch)
      arrangeStates = { ...arrangeStates, ...res }
    } catch {
      // best-effort — the next tick retries whatever is still non-terminal
    }
    // Anything left over (or newly queued while the request was in flight)
    // goes out on the next tick rather than in one oversized request.
    if (pendingArrangeIds.size && arrangeLookupTimer === undefined) {
      arrangeLookupTimer = setTimeout(flushArrangeLookup, ARRANGE_LOOKUP_DEBOUNCE_MS)
    }
  }

  // Fold one good /recent-tasks payload into the page state. The WS-only
  // fields (stdin/stdout_lines/env/source_offsets/exit_code) survive the
  // rebuild — see mergeRecentTasks in lib/taskStore.
  function applyRecentTasks(rt: NormalizedRecentTasks) {
    allTasks = mergeRecentTasks(allTasks, rt.tasks)
    if (rt.lane_count) laneCount = rt.lane_count
    truncated = rt.truncated
  }

  async function resync() {
    if (frozen) return
    try {
      // Vetted before use: a degraded backend answers with a placeholder
      // payload (or, on older builds, a bare array), and iterating that as if
      // it were data is what used to freeze this page without a word.
      const rt = normalizeRecentTasks(await api.recentTasks(maxAgeMinutes))
      // A degraded read keeps the last good timeline and table on screen — an
      // empty render is indistinguishable from an idle worker — but says so.
      dataUnavailable = rt.unavailable
      if (!rt.unavailable) applyRecentTasks(rt)
    } catch {
      // Request failure: same operator experience as a degraded read, so the
      // same notice. Payload-shape errors can no longer reach this catch.
      dataUnavailable = true
    }
    // Refresh arrange-task states for the visible batches. Terminal states are
    // filtered out inside queueArrangeLookup, so in steady state this asks for
    // only the tasks still in flight rather than every task ever arranged.
    queueArrangeLookup(arranges.flatMap((a) => a.task_ids))
    void reloadFeeds()
  }

  async function reloadFeeds() {
    const limit = Math.max(10 * partitionCount, 30)
    if (hookFlags.task_complete) {
      try {
        taskResults = await api.liveTaskResults(limit)
      } catch {
        /* keep */
      }
    }
    if (hookFlags.message_complete) {
      try {
        messageResults = await api.liveMessageResults(limit)
      } catch {
        /* keep */
      }
    }
    if (hookFlags.window_complete) {
      try {
        windowResults = await api.liveWindowResults(limit)
      } catch {
        /* keep */
      }
    }
  }

  /**
   * Rebuild everything the WebSocket feeds, not just the task timeline.
   *
   * Used whenever the live stream had a hole in it: a reconnect, a reported
   * drop, or a resume after the tab was idle. `resync` alone is not enough —
   * the Arrange list is built purely from `arranged` frames, so any batch that
   * arrived during the gap would stay missing until the page was reloaded.
   */
  async function fullResync() {
    await Promise.all([resync(), loadArrangesBoot()])
  }

  async function loadArrangesBoot() {
    // Seed the Arrange tab from the recent 'arranged' events (the WS only carries
    // new ones from connect time onward).
    try {
      const evs = await api.events({ event_types: 'arranged', limit: maxHistory })
      arranges = evs.map((ev) =>
        arrangeFromEvent({
          event: 'arranged',
          ts: ev.ts,
          partition: ev.partition ?? -1,
          duration: ev.duration ?? 0,
          metadata: ev.metadata ?? undefined,
        }),
      )
      queueArrangeLookup(arranges.flatMap((a) => a.task_ids))
    } catch {
      /* best-effort */
    }
  }

  // --- freeze ---
  function setFrozen(f: boolean) {
    frozen = f
    socket?.setFrozen(f)
    if (!f) void resync() // catch up on unfreeze
  }
  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement
    const tag = (t.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return
    if (e.code === 'Space') {
      e.preventDefault()
      setFrozen(!frozen)
      return
    }
    // Plain "c" toggles cluster view; modifiers are left alone so it never
    // shadows browser shortcuts (same guard App.svelte uses for "f").
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      toggleClusterView()
    }
  }

  onMount(() => {
    // Bootstrap config; tolerate a missing overview endpoint.
    api
      .liveOverview()
      .then((o) => {
        if (o.pool_max != null) pool.max = o.pool_max
        if (o.pool_active != null) pool.active = o.pool_active
        if (o.pool_waiting != null) pool.waiting = o.pool_waiting
        if (o.partition_count != null) partitionCount = o.partition_count
        if (o.max_ui_rows != null) maxHistory = o.max_ui_rows
        if (o.hook_flags) {
          hookFlags = {
            task_complete: !!o.hook_flags.task_complete,
            message_complete: !!o.hook_flags.message_complete,
            window_complete: !!o.hook_flags.window_complete,
          }
        }
        hydrateFromOverview(o)
        void reloadFeeds()
      })
      .catch(() => {})

    void loadArrangesBoot()
    void resync()

    socket = createLiveSocket({
      onEvent,
      eventTypes: LIVE_EVENT_TYPES,
      onStatus: (s) => (status = s),
      // Events emitted while we were disconnected were delivered to nobody,
      // so rebuild from the database rather than resuming mid-stream.
      onOpen: () => void fullResync(),
      // The server discarded events for us, so in-memory state has a hole.
      // Rebuild immediately rather than waiting out the 5s tick with a view
      // that is quietly wrong.
      onGap: () => void fullResync(),
    })

    // Hidden tabs stop resyncing after the grace period. Each resync is
    // several requests, and each request costs the backend a main-loop
    // dispatch — ten background tabs were paying that with nobody watching.
    const stopResync = pausableInterval(resync, 5000)

    // ...and stop applying WebSocket frames too. Browsers throttle rendering
    // in a hidden tab but NOT WebSocket delivery, so without this a hidden
    // Live tab kept parsing frames and mutating reactive state at the full
    // event rate. Suspension is deliberately not the same thing as the
    // operator's pause: `frozen` stays untouched, so the button keeps
    // reading "Live" and the Space bar still means what it always meant.
    const stopGate = visibilityGate({
      onIdle: () => socket?.setSuspended(true),
      onActive: () => {
        socket?.setSuspended(false)
        void fullResync()
      },
    })

    document.addEventListener('keydown', onKey)
    return () => {
      stopResync()
      stopGate()
      if (arrangeLookupTimer !== undefined) clearTimeout(arrangeLookupTimer)
      document.removeEventListener('keydown', onKey)
      socket?.close()
    }
  })
</script>

<div class="head">
  <h1>Live Pipeline</h1>
  <span class="badge status-{status}">WS: {WS_STATUS_LABELS[status]}</span>
  <button class="freeze" class:on={frozen} onclick={() => setFrozen(!frozen)}>{frozen ? 'Frozen' : 'Live'}</button>
  <span class="spacer"></span>
  <span class="pool">Pool: {pool.active} / {pool.max} slots, <span class="waiting">{pool.waiting}</span> waiting</span>
</div>
<p class="tab-hint">{TAB_HINTS[activeTab]}</p>

<!-- Above the tabs, not inside one: every tab on this page is fed by the same
     resync, so they all go stale together and all need to say so. -->
{#if dataUnavailable}
  <p class="truncated-note stale-note">
    Live data unavailable — the worker's recorder may be degraded; check its logs.
  </p>
{/if}

<div class="tabs">
  {#each availableTabs as t}
    <button class="tab" class:active={activeTab === t} onclick={() => setHash(`#${t}`)}>{TAB_LABELS[t]}</button>
  {/each}
</div>

{#if activeTab === 'arrange'}
  <ArrangeTab {arranges} states={arrangeStates} {annotations} />
{:else if activeTab === 'execute'}
  {#if truncated}
    <p class="truncated-note">
      Showing the most recent tasks only — this worker produced more in the window than the timeline
      scan returns.
    </p>
  {/if}
  <div class="tl-actions">
    <button
      class="cluster-toggle"
      class:on={clusterView}
      onclick={toggleClusterView}
      title="Stack a timeline for every worker in this cluster (c)"
    >{clusterView ? 'Cluster view: on' : 'Cluster view'}</button>
  </div>
  {#if !clusterView}
    <Timeline
      tasks={tasksList}
      {laneCount}
      paused={frozen}
      minDurationMs={$runtimeConfig.wsMinDurationMs}
      timeline={timelineConfig}
      workerId={$identity?.worker_id}
    />
  {:else}
    <!-- This worker first, with the one toolbar; peers stack under it and
         follow the toolbar through sharedControls. -->
    <div class="peer-head">
      <h3 class="peer-name">{$identity?.worker_id ?? 'this worker'}</h3>
      <span class="tag-current">current</span>
    </div>
    <Timeline
      tasks={tasksList}
      {laneCount}
      paused={frozen}
      minDurationMs={$runtimeConfig.wsMinDurationMs}
      timeline={timelineConfig}
      workerId={$identity?.worker_id}
      shared={sharedControls}
      showHeader={false}
    />
    {#if clusterLoadFailed}
      <p class="truncated-note">Could not load the worker list — peer timelines are unavailable.</p>
    {:else if clusterPeers.length === 0}
      <p class="muted">No other workers found in this cluster.</p>
    {/if}
    {#each clusterPeers as w (w.worker_name)}
      <PeerTimeline
        peer={w}
        shared={sharedControls}
        paused={frozen}
        minDurationMs={$runtimeConfig.wsMinDurationMs}
        timeline={timelineConfig}
        fallbackLaneCount={laneCount}
      />
    {/each}
  {/if}
{:else if activeTab === 'task-results'}
  <ResultsTab kind="task" rows={taskResults} />
{:else if activeTab === 'message-results'}
  <ResultsTab kind="message" rows={messageResults} />
{:else if activeTab === 'window-results'}
  <ResultsTab kind="window" rows={windowResults} />
{:else if activeTab === 'runtime'}
  <RuntimeTab refreshSeq={runtimeSeq} />
{/if}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.25rem;
  }
  .tab-hint {
    font-size: 0.75rem;
    color: #9ca3af;
    line-height: 1.4;
    margin: 0 0 0.75rem;
    min-height: 1.4em;
  }
  .head h1 {
    margin: 0;
  }
  .head .spacer {
    flex: 1;
  }
  /* WS badge: green pill when connected, red for every other state —
     matching the reference's ws.onopen/onclose inline styling. */
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
  .freeze {
    font-size: 0.75rem;
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: #f5f3ee;
    color: #6b7280;
    border: 1px solid #ddd9ce;
  }
  .freeze.on {
    background: #dbeafe;
    color: #1e40af;
    border-color: #93c5fd;
  }
  .pool {
    font-size: 0.875rem;
    color: var(--muted);
  }
  .pool .waiting {
    color: #b45309;
  }
  .tabs {
    display: flex;
    gap: 0.25rem;
    border-bottom: 1px solid var(--line);
    margin-bottom: 1rem;
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
  /* Cluster-view toggle row, right-aligned above the timeline(s). The button
     reuses the freeze button's idiom (neutral pill, blue when active). */
  .tl-actions {
    display: flex;
    justify-content: flex-end;
    margin-bottom: 0.5rem;
  }
  .cluster-toggle {
    font-size: 0.75rem;
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: #f5f3ee;
    color: #6b7280;
    border: 1px solid #ddd9ce;
  }
  .cluster-toggle.on {
    background: #dbeafe;
    color: #1e40af;
    border-color: #93c5fd;
  }
  /* Per-worker heading in cluster view (peers render their own, with a WS
     badge, in PeerTimeline). */
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
  .tag-current {
    font-size: 0.7rem;
    color: #9ca3af;
  }
  .truncated-note {
    font-size: 0.75rem;
    color: #b45309;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 0.25rem;
    padding: 0.375rem 0.5rem;
    margin: 0 0 0.75rem;
  }
  /* Stale data is a fault, not a caveat — red rather than the amber the
     truncation note uses, so the two read differently when both are up. */
  .stale-note {
    color: #991b1b;
    background: #fef2f2;
    border-color: #fca5a5;
  }
</style>
