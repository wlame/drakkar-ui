<script lang="ts">
  // Executor timeline: one lane per executor slot, with a bar per task positioned
  // over the last 10 minutes. Mirrors the Executors-tab timeline in live.html
  // (DOM bars rather than canvas). Bars are colored by status; hovering shows the
  // task detail; the view auto-follows "now" until the operator scrolls away.
  import { link } from '../../lib/router'
  import { baseTaskId, type TaskView } from '../../lib/live'
  import { fmtTime, fmtTimeMs, dur3 } from '../../lib/format'

  let {
    tasks = [],
    laneCount = 8,
    paused = false,
  }: { tasks?: TaskView[]; laneCount?: number; paused?: boolean } = $props()

  const WINDOW_SEC = 600 // 10 minutes
  const LANE_H = 22
  const MIN_BAR_PX = 3

  let zoom = $state(8) // px per second
  let following = $state(true)
  let now = $state(Date.now() / 1000)
  let viewport = $state<HTMLDivElement>()
  let hovered = $state<TaskView | null>(null)

  $effect(() => {
    if (paused) return
    const id = setInterval(() => (now = Date.now() / 1000), 250)
    return () => clearInterval(id)
  })

  const windowStart = $derived(now - WINDOW_SEC)
  const innerWidth = $derived(WINDOW_SEC * zoom)

  interface Bar {
    task: TaskView
    lane: number
    left: number
    width: number
    color: string
  }

  function barColor(t: TaskView): string {
    if (t.origin === 'http') return '#9333ea'
    if (t.status === 'completed') return '#059669'
    if (t.status === 'failed') return '#dc2626'
    return '#d97706'
  }

  const bars = $derived.by<Bar[]>(() => {
    const out: Bar[] = []
    for (const t of tasks) {
      const end = t.end_ts ?? now
      if (end < windowStart) continue
      const lane = Math.min(Math.max(t.slot ?? 0, 0), Math.max(laneCount - 1, 0))
      const left = Math.max(0, (t.start_ts - windowStart) * zoom)
      const width = Math.max(MIN_BAR_PX, (end - Math.max(t.start_ts, windowStart)) * zoom)
      out.push({ task: t, lane, left, width, color: barColor(t) })
    }
    return out
  })

  // Minute gridlines/ticks across the window.
  const ticks = $derived.by<{ left: number; label: string }[]>(() => {
    const out: { left: number; label: string }[] = []
    const firstMin = Math.ceil(windowStart / 60) * 60
    for (let ts = firstMin; ts <= now; ts += 60) {
      out.push({ left: (ts - windowStart) * zoom, label: fmtTime(ts).substring(0, 5) })
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
    zoom = Math.min(64, zoom * 2)
  }
  function zoomOut() {
    zoom = Math.max(0.25, zoom / 2)
  }
  function zoomReset() {
    zoom = 8
  }
  function jumpNow() {
    following = true
    if (viewport) viewport.scrollLeft = viewport.scrollWidth
  }
</script>

<div class="tl">
  <div class="tl-controls">
    <span class="muted">last 10 min · {tasks.length} tasks</span>
    <span class="spacer"></span>
    <div class="legend">
      <span><i style:background="#059669"></i>completed</span>
      <span><i style:background="#d97706"></i>running</span>
      <span><i style:background="#dc2626"></i>failed</span>
    </div>
    <button onclick={zoomOut} title="Zoom out">−</button>
    <button onclick={zoomReset} title="Reset zoom">Reset</button>
    <button onclick={zoomIn} title="Zoom in">+</button>
    <button onclick={jumpNow} class:active={following}>Now →</button>
  </div>

  <div class="tl-viewport" bind:this={viewport} onscroll={onScroll}>
    <div class="tl-inner" style:width={`${innerWidth}px`} style:height={`${laneCount * LANE_H}px`}>
      {#each ticks as tk}
        <div class="tick" style:left={`${tk.left}px`}><span>{tk.label}</span></div>
      {/each}
      {#each Array(laneCount) as _, i}
        <div class="lane" style:top={`${i * LANE_H}px`} style:height={`${LANE_H}px`}>
          <span class="lane-label">{i}</span>
        </div>
      {/each}
      {#each bars as b (b.task.task_id)}
        <a
          class="bar"
          href={`/task/${encodeURIComponent(baseTaskId(b.task.task_id))}`}
          use:link
          style:left={`${b.left}px`}
          style:top={`${b.lane * LANE_H + 3}px`}
          style:width={`${b.width}px`}
          style:background={b.color}
          onmouseenter={() => (hovered = b.task)}
          onmouseleave={() => (hovered = null)}
          aria-label={b.task.task_id}
        ></a>
      {/each}
    </div>
  </div>

  {#if hovered}
    <div class="tl-hover">
      <span class="mono">{hovered.task_id}</span>
      <span class="muted">slot {hovered.slot ?? '-'}</span>
      <span class="muted">pid {hovered.pid ?? '-'}</span>
      <span class="muted">P{hovered.partition ?? '-'} · {hovered.origin}</span>
      <span>{hovered.status}</span>
      <span class="muted">{hovered.duration != null ? dur3(hovered.duration) : 'running'}</span>
      <span class="muted" title={fmtTimeMs(hovered.start_ts)}>{fmtTime(hovered.start_ts)}</span>
    </div>
  {/if}
</div>

<style>
  .tl-controls {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
    font-size: 0.8rem;
  }
  .tl-controls .spacer {
    flex: 1;
  }
  .tl-controls button {
    padding: 0.2rem 0.5rem;
    font-size: 0.8rem;
  }
  .tl-controls button.active {
    border-color: var(--accent);
    color: var(--text);
  }
  .legend {
    display: flex;
    gap: 0.7rem;
    color: var(--muted);
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .legend i {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 2px;
    display: inline-block;
  }
  .tl-viewport {
    overflow-x: auto;
    overflow-y: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
  }
  .tl-inner {
    position: relative;
    min-width: 100%;
  }
  .tick {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--line);
    opacity: 0.5;
  }
  .tick span {
    position: absolute;
    top: 0;
    left: 2px;
    font-size: 0.6rem;
    color: var(--muted);
  }
  .lane {
    position: absolute;
    left: 0;
    right: 0;
    border-bottom: 1px solid rgba(40, 48, 79, 0.4);
  }
  .lane-label {
    position: sticky;
    left: 0;
    font-size: 0.6rem;
    color: var(--muted);
    padding: 0 0.2rem;
    background: var(--panel);
  }
  .bar {
    position: absolute;
    height: 16px;
    border-radius: 3px;
    cursor: pointer;
    opacity: 0.9;
  }
  .bar:hover {
    opacity: 1;
    outline: 1px solid var(--text);
  }
  .tl-hover {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin-top: 0.5rem;
    padding: 0.5rem 0.75rem;
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    font-size: 0.8rem;
  }
</style>
