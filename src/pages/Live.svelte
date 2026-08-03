<script lang="ts">
  // Live pipeline (ports live.html). The WebSocket /ws stream drives the live view:
  // task_started/completed/failed update the executor timeline + pool, arranged
  // updates the Arrange tab. Every 5s a DB resync via /api/v1/recent-tasks reconciles
  // anything missed (the WS drops frames for slow consumers and hides sub-threshold
  // fast tasks). The on_*_complete result feeds poll every 5s like the reference.
  import { onMount } from 'svelte'
  import { api } from '../lib/api'
  import type { ArrangeTaskState, TaskResult, MessageResult, WindowResult, WsEvent } from '../lib/api'
  import { hash, setHash, link } from '../lib/router'
  import { hydrateFromOverview, runtimeConfig } from '../lib/config'
  import { createLiveSocket, type WsStatus, type LiveSocket } from '../lib/ws'
  import { pausableInterval, visibilityGate } from '../lib/visibility'
  import { fmtTimeMs, dur2, fmtBytes, safeJsonParse } from '../lib/format'
  import {
    baseTaskId,
    taskFromRecent,
    arrangeFromEvent,
    annotationFromEvent,
    type TaskView,
    type ArrangeView,
    type AnnotationView,
  } from '../lib/live'
  import Timeline from '../components/live/Timeline.svelte'
  import ArrangeTab from '../components/live/ArrangeTab.svelte'
  import ResultsTab from '../components/live/ResultsTab.svelte'
  import Expandable from '../components/Expandable.svelte'

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
  let pool = $state({ active: 0, max: 0, waiting: 0 })
  let allTasks = $state<Record<string, TaskView>>({})
  let arranges = $state<ArrangeView[]>([])
  let annotations = $state<AnnotationView[]>([])
  let arrangeStates = $state<Record<string, ArrangeTaskState>>({})
  let taskResults = $state<TaskResult[]>([])
  let messageResults = $state<MessageResult[]>([])
  let windowResults = $state<WindowResult[]>([])

  let socket: LiveSocket | null = null

  const tasksList = $derived(Object.values(allTasks))
  // How many finished rows the table actually renders.
  //
  // This used to slice to maxHistory, which is `ui.max_rows` (5000 by
  // default). A worker that finishes hundreds of tasks a second fills that
  // instantly, so the page built a five-thousand-row table and rebuilt it on
  // every resync. Nobody reads past the first screen of a live feed, and the
  // full history is a click away on the History page.
  const FINISHED_RENDER_LIMIT = 200

  const finishedAll = $derived(
    tasksList
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => (b.end_ts ?? 0) - (a.end_ts ?? 0)),
  )
  const finished = $derived(finishedAll.slice(0, FINISHED_RENDER_LIMIT))

  // --- tabs (hash-routed) ---
  type Tab = 'arrange' | 'execute' | 'task-results' | 'message-results' | 'window-results'
  const availableTabs = $derived<Tab[]>([
    'arrange',
    'execute',
    ...(hookFlags.task_complete ? (['task-results'] as Tab[]) : []),
    ...(hookFlags.message_complete ? (['message-results'] as Tab[]) : []),
    ...(hookFlags.window_complete ? (['window-results'] as Tab[]) : []),
  ])
  const TAB_LABELS: Record<Tab, string> = {
    arrange: 'Arrange',
    execute: 'Executors',
    'task-results': 'Task Results',
    'message-results': 'Message Results',
    'window-results': 'Window Results',
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
  }

  // Pool utilization bar: green under 50%, amber to 80%, red above — the
  // reference's bg-emerald-400 / bg-amber-400 / bg-red-400 thresholds.
  const poolPct = $derived(pool.max > 0 ? Math.min(100, (pool.active / pool.max) * 100) : 0)
  const poolColor = $derived(poolPct > 80 ? '#f87171' : poolPct > 50 ? '#fbbf24' : '#34d399')

  // Stdin cell: "-" when the task read nothing, otherwise lines + byte size.
  function fmtStdin(t: TaskView): string {
    if (!t.stdin_size) return '-'
    return `${t.stdin_lines ?? 0} lines, ${fmtBytes(t.stdin_size)}`
  }

  const statusLabel: Record<WsStatus, string> = {
    connecting: 'connecting',
    connected: 'connected',
    disconnected: 'disconnected',
    unauthorized: 'unauthorized',
    forbidden: 'forbidden origin',
  }

  // --- WS event handling ---
  function applyPool(e: WsEvent) {
    if (e.pool_active !== undefined) pool.active = e.pool_active
    if (e.pool_waiting !== undefined) pool.waiting = e.pool_waiting
  }

  function onEvent(e: WsEvent) {
    switch (e.event) {
      case 'task_started': {
        if (!e.task_id) return
        const existing = allTasks[e.task_id]
        // Archive a re-started (retried) task under a :r suffix before overwriting.
        if (existing && existing.status !== 'running') {
          allTasks[`${e.task_id}:r${existing.start_ts}`] = existing
        }
        // The recorder's task_started metadata carries env + source_offsets
        // (used by the timeline hover detail, like the reference).
        const meta = safeJsonParse<Record<string, unknown>>(e.metadata ?? undefined, {})
        allTasks[e.task_id] = {
          task_id: e.task_id,
          partition: e.partition ?? null,
          start_ts: e.ts,
          end_ts: null,
          duration: null,
          status: 'running',
          exit_code: null,
          args: e.args ?? null,
          pid: e.pid ?? null,
          slot: e.slot ?? null,
          labels: safeJsonParse(e.labels ?? undefined, null),
          origin: e.origin ?? 'kafka',
          client_name: e.client_name ?? null,
          request_id: e.request_id ?? null,
          stdout_size: null,
          stdin_lines: e.stdin_lines ?? null,
          stdin_size: e.stdin_size ?? null,
          env: (meta.env as Record<string, string> | undefined) ?? null,
          source_offsets: Array.isArray(meta.source_offsets)
            ? (meta.source_offsets as number[])
            : null,
        }
        applyPool(e)
        break
      }
      case 'task_completed':
      case 'task_failed': {
        if (!e.task_id) return
        const done = e.event === 'task_completed' ? 'completed' : 'failed'
        const ex = allTasks[e.task_id]
        const start = ex?.start_ts ?? e.ts - (e.duration ?? 0)
        allTasks[e.task_id] = {
          task_id: e.task_id,
          partition: e.partition ?? ex?.partition ?? null,
          start_ts: start,
          end_ts: e.ts,
          duration: e.duration ?? (ex ? e.ts - ex.start_ts : null),
          status: done,
          exit_code: e.exit_code ?? null,
          args: ex?.args ?? e.args ?? null,
          pid: e.pid ?? ex?.pid ?? null,
          slot: ex?.slot ?? e.slot ?? null,
          labels: ex?.labels ?? safeJsonParse(e.labels ?? undefined, null),
          origin: e.origin ?? ex?.origin ?? 'kafka',
          client_name: e.client_name ?? ex?.client_name ?? null,
          request_id: e.request_id ?? ex?.request_id ?? null,
          stdout_size: e.stdout_size ?? null,
          stdin_lines: ex?.stdin_lines ?? e.stdin_lines ?? null,
          stdin_size: ex?.stdin_size ?? e.stdin_size ?? null,
          env: ex?.env ?? null,
          source_offsets: ex?.source_offsets ?? null,
        }
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

  async function resync() {
    if (frozen) return
    try {
      const rt = await api.recentTasks(10)
      const map: Record<string, TaskView> = {}
      for (const t of rt.tasks) {
        const v = taskFromRecent(t)
        // /recent-tasks doesn't carry stdin/env/source_offsets — keep the
        // WS-provided values so the Stdin column and hover detail survive resyncs.
        const prev = allTasks[t.task_id]
        if (prev) {
          v.stdin_lines = prev.stdin_lines
          v.stdin_size = prev.stdin_size
          v.env = v.env ?? prev.env
          v.source_offsets = prev.source_offsets
        }
        map[t.task_id] = v
      }
      allTasks = map
      if (rt.lane_count) laneCount = rt.lane_count
      truncated = !!rt.truncated
    } catch {
      // keep last good state
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
    if (e.code !== 'Space') return
    const t = e.target as HTMLElement
    const tag = (t.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return
    e.preventDefault()
    setFrozen(!frozen)
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
  <span class="badge status-{status}">WS: {statusLabel[status]}</span>
  <button class="freeze" class:on={frozen} onclick={() => setFrozen(!frozen)}>{frozen ? 'Frozen' : 'Live'}</button>
  <span class="spacer"></span>
  <span class="pool">Pool: {pool.active} / {pool.max} slots, <span class="waiting">{pool.waiting}</span> waiting</span>
</div>
<p class="tab-hint">{TAB_HINTS[activeTab]}</p>

<div class="tabs">
  {#each availableTabs as t}
    <button class="tab" class:active={activeTab === t} onclick={() => setHash(`#${t}`)}>{TAB_LABELS[t]}</button>
  {/each}
</div>

{#if activeTab === 'arrange'}
  <ArrangeTab {arranges} states={arrangeStates} {annotations} />
{:else if activeTab === 'execute'}
  <div class="pool-bar">
    <div class="pool-fill" style:width={`${poolPct}%`} style:background={poolColor}></div>
  </div>
  {#if truncated}
    <p class="truncated-note">
      Showing the most recent tasks only — this worker produced more in the window than the timeline
      scan returns.
    </p>
  {/if}
  <Timeline tasks={tasksList} {laneCount} paused={frozen} minDurationMs={$runtimeConfig.wsMinDurationMs} />

  <h2>
    Finished <span class="count">({finishedAll.length})</span>
    {#if finishedAll.length > finished.length}
      <span class="count">— newest {finished.length} shown</span>
    {/if}
  </h2>
  {#if finished.length === 0}
    <p class="muted">No finished tasks.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Task ID</th><th>Partition</th><th>Labels</th><th>Status</th><th>Duration</th><th>Time</th><th>CLI Args</th><th>Stdin</th></tr>
      </thead>
      <tbody>
        {#each finished as t (t.task_id)}
          <tr>
            <td class="mono xs"><a href={`/task/${encodeURIComponent(baseTaskId(t.task_id))}`} use:link style:color={t.status === 'failed' ? '#dc2626' : '#059669'}>{t.task_id}</a></td>
            <td class="mono">{t.partition ?? '-'}</td>
            <td class="xs">
              {#if t.labels}
                <span class="lchips">
                  {#each Object.entries(t.labels) as [k, v]}<span class="lchip">{k}={v}</span>{/each}
                </span>
              {/if}
            </td>
            <td><span style:color={t.status === 'failed' ? '#dc2626' : '#059669'}>{t.status}</span></td>
            <td class="mono">{t.duration != null ? dur2(t.duration) : ''}</td>
            <td class="time nowrap">{fmtTimeMs(t.end_ts)}</td>
            <td>{#if t.args}<Expandable text={t.args} />{/if}</td>
            <td class="mono xs stdin">{fmtStdin(t)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{:else if activeTab === 'task-results'}
  <ResultsTab kind="task" rows={taskResults} />
{:else if activeTab === 'message-results'}
  <ResultsTab kind="message" rows={messageResults} />
{:else if activeTab === 'window-results'}
  <ResultsTab kind="window" rows={windowResults} />
{/if}

<style>
  .count {
    color: var(--muted);
    font-weight: 400;
    font-size: 0.9rem;
  }
  .lchips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .lchip {
    font-family: var(--mono);
    font-size: 0.75rem;
    color: var(--accent);
    background: #f0fdfa;
    border: 1px solid #99f6e4;
    border-radius: 3px;
    padding: 0 3px;
  }
  .xs {
    font-size: 0.75rem;
  }
  .time {
    color: #9ca3af;
    font-size: 0.75rem;
  }
  .stdin {
    color: #9ca3af;
  }
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
  /* Pool utilization bar (reference: h-3 bg-cream-200 rounded-full mb-4). */
  .pool-bar {
    height: 0.75rem;
    background: var(--line);
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .pool-fill {
    height: 100%;
    border-radius: 999px;
    transition:
      width 200ms ease,
      background 200ms ease;
  }
  .nowrap {
    white-space: nowrap;
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
</style>
