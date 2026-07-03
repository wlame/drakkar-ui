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
  import { hydrateFromOverview } from '../lib/config'
  import { createLiveSocket, type WsStatus, type LiveSocket } from '../lib/ws'
  import { fmtTime, fmtTimeMs, dur3, safeJsonParse } from '../lib/format'
  import {
    baseTaskId,
    taskFromRecent,
    arrangeFromEvent,
    type TaskView,
    type ArrangeView,
  } from '../lib/live'
  import Timeline from '../components/live/Timeline.svelte'
  import ArrangeTab from '../components/live/ArrangeTab.svelte'
  import ResultsTab from '../components/live/ResultsTab.svelte'
  import Expandable from '../components/Expandable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  // --- bootstrap config (best-effort; defaults keep the page working) ---
  let hookFlags = $state({ task_complete: false, message_complete: false, window_complete: false })
  let partitionCount = $state(0)
  let maxHistory = $state(5000)
  let laneCount = $state(8)

  // --- live state ---
  let status = $state<WsStatus>('connecting')
  let frozen = $state(false)
  let pool = $state({ active: 0, max: 0, waiting: 0 })
  let allTasks = $state<Record<string, TaskView>>({})
  let arranges = $state<ArrangeView[]>([])
  let arrangeStates = $state<Record<string, ArrangeTaskState>>({})
  let taskResults = $state<TaskResult[]>([])
  let messageResults = $state<MessageResult[]>([])
  let windowResults = $state<WindowResult[]>([])

  let socket: LiveSocket | null = null

  const tasksList = $derived(Object.values(allTasks))
  const finished = $derived(
    tasksList
      .filter((t) => t.status === 'completed' || t.status === 'failed')
      .sort((a, b) => (b.end_ts ?? 0) - (a.end_ts ?? 0))
      .slice(0, maxHistory),
  )

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
        }
        applyPool(e)
        break
      }
      case 'arranged': {
        const a = arrangeFromEvent(e)
        arranges = [a, ...arranges].slice(0, maxHistory)
        if (a.task_ids.length) void refreshArrangeStates(a.task_ids)
        break
      }
      // task_complete / message_complete / window_complete drive the poll-backed
      // result feeds; the next 5s reload (and tab open) picks them up.
    }
  }

  // --- POST-driven + polled data ---
  async function refreshArrangeStates(taskIds: string[]) {
    if (!taskIds.length) return
    try {
      const res = await api.arrangeTasks(taskIds.slice(0, maxHistory))
      arrangeStates = { ...arrangeStates, ...res }
    } catch {
      // best-effort
    }
  }

  async function resync() {
    if (frozen) return
    try {
      const rt = await api.recentTasks(10)
      const map: Record<string, TaskView> = {}
      for (const t of rt.tasks) map[t.task_id] = taskFromRecent(t)
      allTasks = map
      if (rt.lane_count) laneCount = rt.lane_count
    } catch {
      // keep last good state
    }
    // Refresh arrange-task states for the visible batches.
    const ids = arranges.flatMap((a) => a.task_ids).slice(0, maxHistory)
    if (ids.length) void refreshArrangeStates(ids)
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
      const ids = arranges.flatMap((a) => a.task_ids).slice(0, maxHistory)
      if (ids.length) void refreshArrangeStates(ids)
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
      onStatus: (s) => (status = s),
      onOpen: () => void resync(),
    })

    const resyncId = setInterval(resync, 5000)
    document.addEventListener('keydown', onKey)
    return () => {
      clearInterval(resyncId)
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
  <span class="pool">Pool: <span class="mono">{pool.active} / {pool.max}</span> slots{#if pool.waiting}, <span class="mono">{pool.waiting}</span> waiting{/if}</span>
</div>

<div class="tabs">
  {#each availableTabs as t}
    <button class="tab" class:active={activeTab === t} onclick={() => setHash(`#${t}`)}>{TAB_LABELS[t]}</button>
  {/each}
</div>

{#if activeTab === 'arrange'}
  <ArrangeTab {arranges} states={arrangeStates} />
{:else if activeTab === 'execute'}
  <div class="pool-bar">
    <div class="pool-fill" style:width={`${pool.max ? Math.min(100, (pool.active / pool.max) * 100) : 0}%`}></div>
  </div>
  <Timeline tasks={tasksList} {laneCount} paused={frozen} />

  <h2>Finished <span class="count">({finished.length})</span></h2>
  {#if finished.length === 0}
    <p class="muted">No finished tasks.</p>
  {:else}
    <table>
      <thead>
        <tr><th>Task ID</th><th class="num">Partition</th><th>Labels</th><th>Status</th><th class="num">Duration</th><th>Time</th><th>CLI Args</th></tr>
      </thead>
      <tbody>
        {#each finished as t (t.task_id)}
          <tr>
            <td class="mono"><a href={`/task/${encodeURIComponent(baseTaskId(t.task_id))}`} use:link>{t.task_id}</a></td>
            <td class="num mono">{t.partition ?? '-'}</td>
            <td>
              {#if t.labels}
                <span class="lchips">
                  {#each Object.entries(t.labels) as [k, v]}<span class="lchip">{k}={v}</span>{/each}
                </span>
              {/if}
            </td>
            <td><span style:color={t.status === 'failed' ? '#dc2626' : '#059669'}>{t.status}</span></td>
            <td class="num mono">{t.duration != null ? dur3(t.duration) : '-'}</td>
            <td class="muted nowrap" title={fmtTimeMs(t.end_ts)}>{fmtTime(t.end_ts)}</td>
            <td>{#if t.args}<Expandable text={t.args} />{/if}</td>
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
    font-size: 0.7rem;
    color: var(--accent);
    background: #f0fdfa;
    border: 1px solid #99f6e4;
    border-radius: 4px;
    padding: 0.05rem 0.3rem;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .head h1 {
    margin: 0;
  }
  .head .spacer {
    flex: 1;
  }
  .badge {
    font-size: 0.72rem;
    font-family: var(--mono);
    border-radius: 999px;
    padding: 0.15rem 0.6rem;
    border: 1px solid var(--line);
  }
  .status-connected {
    color: #059669;
    border-color: rgba(52, 211, 153, 0.5);
  }
  .status-connecting {
    color: #d97706;
  }
  .status-disconnected,
  .status-unauthorized,
  .status-forbidden {
    color: #dc2626;
    border-color: rgba(248, 113, 113, 0.5);
  }
  .freeze {
    font-size: 0.8rem;
    padding: 0.25rem 0.7rem;
  }
  .freeze.on {
    color: #2563eb;
    border-color: #2563eb;
  }
  .pool {
    font-size: 0.85rem;
    color: var(--muted);
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
  .pool-bar {
    height: 0.5rem;
    background: var(--panel-2);
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .pool-fill {
    height: 100%;
    background: #059669;
    transition: width 200ms ease;
  }
  .nowrap {
    white-space: nowrap;
  }
</style>
