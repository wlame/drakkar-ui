<script lang="ts">
  // Executor timeline, ported from live.html's Executors tab: an h2 with the
  // window note, a Zoom toolbar + legend row, and a white panel containing the
  // time axis, one lane per executor slot and a fixed-height hover-detail strip.
  // Bars are colored by status; the view auto-follows "now" until the operator
  // scrolls away from the right edge.
  import { link } from '../../lib/router'
  import { baseTaskId, type TaskView } from '../../lib/live'
  import { fmtTime, fmtTimeMs, fmtBytes } from '../../lib/format'

  let {
    tasks = [],
    laneCount = 8,
    paused = false,
    minDurationMs = 0,
  }: { tasks?: TaskView[]; laneCount?: number; paused?: boolean; minDurationMs?: number } =
    $props()

  const WINDOW_SEC = 600 // 10 minutes
  const LANE_H = 22
  const LANE_GAP = 2
  const BASE_PX_PER_SEC = 8
  const MIN_BAR_PX = 2

  // Zoom is a factor over the base px/sec, exactly like the reference's
  // zoomLevel (default 2x, halving/doubling between 0.25x and 64x).
  let zoomLevel = $state(2)
  let following = $state(true)
  let now = $state(Date.now() / 1000)
  let viewport = $state<HTMLDivElement>()
  let hovered = $state<TaskView | null>(null)

  $effect(() => {
    if (paused) return
    const id = setInterval(() => (now = Date.now() / 1000), 250)
    return () => clearInterval(id)
  })

  const pxPerSec = $derived(BASE_PX_PER_SEC * zoomLevel)
  const windowStart = $derived(now - WINDOW_SEC)
  const innerWidth = $derived(WINDOW_SEC * pxPerSec)
  const lanesHeight = $derived(laneCount * (LANE_H + LANE_GAP))

  interface Bar {
    task: TaskView
    lane: number
    left: number
    width: number
    color: string
  }

  function barColor(s: string): string {
    if (s === 'completed') return '#34d399'
    if (s === 'failed') return '#f87171'
    return '#fbbf24'
  }

  const bars = $derived.by<Bar[]>(() => {
    const out: Bar[] = []
    for (const t of tasks) {
      const end = t.end_ts ?? now
      if (end < windowStart) continue
      const lane = Math.min(Math.max(t.slot ?? 0, 0), Math.max(laneCount - 1, 0))
      const left = Math.max(0, (t.start_ts - windowStart) * pxPerSec)
      const width = Math.max(MIN_BAR_PX, (end - Math.max(t.start_ts, windowStart)) * pxPerSec)
      out.push({ task: t, lane, left, width, color: barColor(t.status) })
    }
    return out
  })

  // Axis ticks: HH:MM:SS labels at a zoom-dependent interval (the reference's
  // rebuildAxis picks 5..120s so labels never crowd each other).
  const ticks = $derived.by<{ left: number; label: string }[]>(() => {
    let tick = 30
    if (pxPerSec >= 16) tick = 10
    if (pxPerSec >= 32) tick = 5
    if (pxPerSec < 4) tick = 60
    if (pxPerSec < 1) tick = 120
    const out: { left: number; label: string }[] = []
    for (let ts = Math.ceil(windowStart / tick) * tick; ts <= now; ts += tick) {
      out.push({ left: (ts - windowStart) * pxPerSec, label: fmtTime(ts) })
    }
    return out
  })

  // Auto-follow: keep scrolled to the right edge as time advances.
  $effect(() => {
    void now
    void innerWidth
    if (following && viewport) viewport.scrollLeft = viewport.scrollWidth
  })

  function onScroll() {
    if (!viewport) return
    const atRight = viewport.scrollWidth - viewport.scrollLeft - viewport.clientWidth < 6
    following = atRight
  }

  function zoomIn() {
    zoomLevel = Math.min(64, zoomLevel * 2)
  }
  function zoomOut() {
    zoomLevel = Math.max(0.25, zoomLevel / 2)
  }
  function zoomReset() {
    zoomLevel = 2
  }
  function jumpNow() {
    following = true
    if (viewport) viewport.scrollLeft = viewport.scrollWidth
  }

  // Ident mirrors the reference taskIdent(): p<partition>:o<offset> for Kafka
  // tasks, <client>:<request_id[:8]> for HTTP ones.
  function taskIdent(t: TaskView): string {
    if (t.origin === 'http') {
      const rid = t.request_id ? String(t.request_id).slice(0, 8) : '-'
      return `${t.client_name ?? '-'}:${rid}`
    }
    const off = t.source_offsets?.length ? t.source_offsets[0] : '-'
    return `p${t.partition ?? '-'}:o${off}`
  }
  function statusColor(s: string): string {
    return s === 'completed' ? '#059669' : s === 'failed' ? '#dc2626' : '#d97706'
  }
  function fmtStdin(t: TaskView): string {
    if (!t.stdin_size) return '-'
    return `${t.stdin_lines ?? 0} lines, ${fmtBytes(t.stdin_size)}`
  }
</script>

<h2 class="tl-title">
  Timeline
  <span class="tl-note"
    >(last 10 min, 2 sec delayed{#if minDurationMs > 0}, tasks &ge; {minDurationMs}ms{/if})</span
  >
</h2>

<div class="tl-toolbar">
  <div class="zoom">
    <span class="zoom-lbl">Zoom:</span>
    <button class="tbtn plusminus" onclick={zoomIn} title="Zoom in">+</button>
    <span class="zoom-factor">{zoomLevel}x</span>
    <button class="tbtn plusminus" onclick={zoomOut} title="Zoom out">-</button>
    <button class="tbtn reset" onclick={zoomReset} title="Reset zoom">Reset</button>
  </div>
  <button class="tbtn now" onclick={jumpNow}>Now &rarr;</button>
  <div class="legend">
    <span><i style:background="#34d399"></i>completed</span>
    <span><i style:background="#fbbf24"></i>running</span>
    <span><i style:background="#f87171"></i>failed</span>
  </div>
</div>

<div class="tl-panel">
  <div class="tl-viewport" bind:this={viewport} onscroll={onScroll}>
    <div class="tl-inner" style:width={`${innerWidth}px`}>
      <div class="tl-axis">
        {#each ticks as tk}
          <div class="tick-line" style:left={`${tk.left}px`}></div>
          <div class="tick-label" style:left={`${tk.left}px`}>{tk.label}</div>
        {/each}
      </div>
      <div class="tl-lanes" style:height={`${lanesHeight}px`}>
        {#each Array(laneCount) as _, i}
          {#if i % 2 === 0}
            <div class="stripe" style:top={`${i * (LANE_H + LANE_GAP)}px`}></div>
          {/if}
          <div class="lane-label" style:top={`${i * (LANE_H + LANE_GAP)}px`}>#{i}</div>
        {/each}
        {#each bars as b (b.task.task_id)}
          <a
            class="bar"
            class:http={b.task.origin === 'http'}
            href={`/task/${encodeURIComponent(baseTaskId(b.task.task_id))}`}
            use:link
            style:left={`${b.left}px`}
            style:top={`${b.lane * (LANE_H + LANE_GAP)}px`}
            style:width={`${b.width}px`}
            style:background={b.color}
            onmouseenter={() => (hovered = b.task)}
            onmouseleave={() => (hovered = null)}
            aria-label={b.task.task_id}
          ></a>
        {/each}
      </div>
    </div>
  </div>

  <div class="tl-hover">
    {#if hovered}
      <span class="hl">Task:</span><span class="hv">{hovered.task_id}</span>
      <span class="hl">Slot:</span><span class="hv"
        >{hovered.slot != null ? `#${hovered.slot}` : '-'}</span
      >
      <span class="hl">PID:</span><span class="hv">{hovered.pid ?? '-'}</span>
      <span class="hl">Ident:</span><span class="hv">{taskIdent(hovered)}</span>
      {#if hovered.origin === 'http'}
        <span class="hl">Origin:</span><span class="hv" style:color="#9C27B0">http</span>
      {:else}
        <span class="hl">P:</span><span class="hv">{hovered.partition ?? '-'}</span>
      {/if}
      <span class="hl">Status:</span><span class="hv" style:color={statusColor(hovered.status)}
        >{hovered.status}</span
      >
      <span class="hl">Duration:</span><span class="hv"
        >{hovered.duration != null ? `${hovered.duration.toFixed(3)}s` : 'running'}</span
      >
      <span class="hl">Start:</span><span class="hv">{fmtTimeMs(hovered.start_ts)}</span>
      <span class="hl">End:</span><span class="hv"
        >{hovered.end_ts ? fmtTimeMs(hovered.end_ts) : 'running'}</span
      >
      <br />
      <span class="hl">CLI:</span><span class="hv">{hovered.args ?? '-'}</span>
      {#if hovered.stdin_size}
        <span class="hl">Stdin:</span><span class="hv">{fmtStdin(hovered)}</span>
      {/if}
      {#if hovered.labels && Object.keys(hovered.labels).length}
        <br />
        {#each Object.entries(hovered.labels) as [k, v]}
          <span class="chip label-chip">{k}={v}</span>
        {/each}
      {/if}
      {#if hovered.env && Object.keys(hovered.env).length}
        <br />
        <span class="env-lbl">env:</span>
        {#each Object.entries(hovered.env) as [k, v]}
          <span class="chip env-chip">{k}={v}</span>
        {/each}
      {/if}
    {:else}
      <span class="hint">hover over a task bar to see details</span>
    {/if}
  </div>
</div>

<style>
  /* Heading: reference `text-lg font-semibold mb-2 text-ink-800`. */
  .tl-title {
    font-size: 1.125rem;
    font-weight: 600;
    color: #1a1a1a;
    margin: 0 0 0.5rem;
  }
  .tl-note {
    font-size: 0.875rem;
    font-weight: 400;
    color: #9ca3af;
  }

  .tl-toolbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
  }
  .zoom {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .zoom-lbl {
    font-size: 0.75rem;
    color: #9ca3af;
  }
  .zoom-factor {
    font-size: 0.75rem;
    color: #9ca3af;
    width: 2.5rem;
    text-align: center;
  }
  /* Toolbar buttons: reference `bg-cream-200 hover:bg-cream-300 rounded`. */
  .tbtn {
    background: #e5e1d8;
    border: none;
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    font-size: 0.75rem;
    line-height: 1.4;
  }
  .tbtn:hover {
    background: #ddd9ce;
  }
  .tbtn.plusminus {
    font-size: 0.875rem;
    font-weight: 700;
  }
  .tbtn.reset {
    margin-left: 0.25rem;
  }
  .tbtn.now {
    padding: 0.25rem 0.5rem;
  }
  .legend {
    margin-left: auto;
    display: flex;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
  }
  .legend i {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 0.25rem;
    margin-right: 0.25rem;
  }

  /* White card wrapping axis + lanes + hover strip (bg-white rounded-lg
     border border-cream-200 p-2 mb-6). */
  .tl-panel {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.5rem;
    margin-bottom: 1.5rem;
  }
  .tl-viewport {
    position: relative;
    overflow-x: scroll;
    overflow-y: hidden;
    scrollbar-width: none;
  }
  .tl-viewport::-webkit-scrollbar {
    display: none;
  }
  .tl-inner {
    position: relative;
    min-width: 100%;
  }
  .tl-axis {
    position: relative;
    height: 18px;
    border-bottom: 1px solid #ddd9ce;
  }
  .tick-line {
    position: absolute;
    top: 0;
    width: 1px;
    height: 100%;
    background: #e5e7eb;
  }
  .tick-label {
    position: absolute;
    top: 2px;
    font-size: 9px;
    color: #9ca3af;
    font-family: var(--mono);
    transform: translateX(-50%);
  }
  .tl-lanes {
    position: relative;
  }
  .stripe {
    position: absolute;
    left: 0;
    width: 100%;
    height: 22px;
    background: rgba(0, 0, 0, 0.02);
    pointer-events: none;
  }
  .lane-label {
    position: absolute;
    left: 2px;
    font-size: 10px;
    line-height: 22px;
    color: #9ca3af;
    font-family: var(--mono);
    pointer-events: none;
    z-index: 1;
  }
  .bar {
    position: absolute;
    height: 22px;
    border-radius: 3px;
    cursor: pointer;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(0, 0, 0, 0.15);
    z-index: 2;
  }
  /* HTTP-origin tasks: distinct purple, same as the reference .task--http. */
  .bar.http {
    background: #9c27b0 !important;
    border-color: #6a1b9a !important;
  }

  /* Hover-detail strip: fixed 9em height so the panel doesn't jump as tasks
     are hovered/unhovered; overflow hidden clamps very long CLI args. */
  .tl-hover {
    border-top: 1px solid var(--line);
    padding: 0.5rem 0.75rem;
    height: 9em;
    overflow: hidden;
    background: #f9f8f5;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: #6b7280;
  }
  .tl-hover .hint {
    color: #9ca3af;
  }
  .hl {
    color: #9ca3af;
    margin-right: 2px;
  }
  .hv {
    margin-right: 12px;
  }
  .chip {
    display: inline-block;
    padding: 0 6px;
    border-radius: 3px;
    margin-right: 6px;
    font-size: 11px;
  }
  .label-chip {
    background: #f0fdfa;
    border: 1px solid #99f6e4;
    color: #0d9488;
  }
  .env-chip {
    background: #fffbeb;
    border: 1px solid #fde68a;
    color: #92400e;
  }
  .env-lbl {
    color: #9ca3af;
    margin-right: 4px;
    font-size: 11px;
  }
</style>
