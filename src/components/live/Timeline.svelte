<script lang="ts">
  // Executor timeline, ported from live.html's Executors tab: an h2 with the
  // window note, a Zoom toolbar + legend row, and a white panel containing the
  // time axis, one lane per executor slot and a fixed-height hover-detail strip.
  // Bars are colored by status; the view auto-follows "now" until the operator
  // scrolls away from the right edge.
  //
  // Coordinate system: bar/tick positions are computed against a fixed
  // `originTs`, not against "now". An earlier version used `now - WINDOW_SEC`
  // as the origin, which steps every 250ms — every bar's absolute pixel
  // position (and the strip's width) was recomputed against a moving target,
  // which reads as a jump, not a slide, four times a second. Here `originTs`
  // only moves on a rare rebase (see `maybeRebase` below), so a task's pixel
  // position is stable between rebases and "time passing" is real scrolling,
  // driven by a requestAnimationFrame loop instead of state churn. The pure
  // math lives in src/lib/timeline.ts (tested independently of the DOM).
  import { untrack } from 'svelte'
  import { link } from '../../lib/router'
  import { baseTaskId, type TaskView } from '../../lib/live'
  import { fmtTime, fmtTimeMs, fmtBytes } from '../../lib/format'
  import { pausableInterval, isHidden } from '../../lib/visibility'
  import {
    barGeometry,
    tickMarks,
    followScrollLeft,
    shouldRebase,
    rebase,
    RENDER_DELAY_SEC,
  } from '../../lib/timeline'

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
  // Extra room past the furthest possible bar tip (a running task drawn out to
  // `now`) so its right edge never clips against the strip boundary.
  const RIGHT_PAD_PX = 16
  // Re-arm auto-follow once the operator scrolls back within this many pixels
  // of the live edge — half the render-delay band, floored at 6px so it still
  // means something at very low zoom.
  const MIN_FOLLOW_THRESHOLD_PX = 6

  // Zoom is a factor over the base px/sec, exactly like the reference's
  // zoomLevel (default 2x, halving/doubling between 0.25x and 64x).
  let zoomLevel = $state(2)
  let following = $state(true)
  let now = $state(Date.now() / 1000)
  let viewport = $state<HTMLDivElement>()
  let hovered = $state<TaskView | null>(null)
  let hiddenState = $state(isHidden())

  // Chosen once at mount, one full window back — pre-existing tasks from the
  // last WINDOW_SEC have room to draw; anything older still clamps to the
  // left edge via barGeometry, same as the old windowStart clamp did. Only
  // `maybeRebase` moves it again after that.
  let originTs = $state(Date.now() / 1000 - WINDOW_SEC)

  $effect(() => {
    if (paused) return
    // Also stops while the tab is hidden: advancing `now` re-derives every bar
    // and re-lays-out the strip, which is pure waste with nobody watching.
    return pausableInterval(() => {
      now = Date.now() / 1000
      maybeRebase()
    }, 250)
  })

  $effect(() => {
    function onVisibilityChange() {
      hiddenState = isHidden()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  })

  // Slide the origin forward by one window once the strip has grown to more
  // than twice WINDOW_SEC, so the DOM/coordinate range doesn't grow forever.
  // The viewport's scrollLeft shifts by the exact same pixel delta in the same
  // synchronous step, which is what makes the jump invisible — see the
  // pixel-delta invariant documented and tested next to `rebase()` in
  // src/lib/timeline.ts. Runs from the 250ms tick above (not the follow rAF
  // loop) so it keeps happening even while the operator has scrolled away and
  // auto-follow is off.
  function maybeRebase() {
    if (!shouldRebase(now, originTs, WINDOW_SEC)) return
    const newOrigin = rebase(originTs, WINDOW_SEC)
    const deltaPx = (newOrigin - originTs) * pxPerSec
    originTs = newOrigin
    if (viewport) applyScrollLeft(viewport.scrollLeft - deltaPx)
  }

  const pxPerSec = $derived(BASE_PX_PER_SEC * zoomLevel)
  const windowStart = $derived(now - WINDOW_SEC)
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

  // Horizontal culling bounds, tracked from the viewport's scroll position.
  //
  // The strip is WINDOW_SEC * pxPerSec wide — 9600px at the default zoom —
  // while the viewport shows perhaps 1200px of it. Without culling roughly 85%
  // of the bars were in the DOM purely to sit off-screen, and every `now` tick
  // re-laid-out all of them. On a worker producing hundreds of tasks a second
  // that is the difference between a smooth timeline and a stuck tab.
  //
  // CULL_MARGIN_PX keeps a band rendered on each side so a scroll or the
  // auto-follow advance does not expose an empty gap before the next update.
  const CULL_MARGIN_PX = 400
  let scrollLeft = $state(0)
  let viewportWidth = $state(0)
  let cullPending = false

  function syncViewportBounds() {
    if (!viewport) return
    scrollLeft = viewport.scrollLeft
    viewportWidth = viewport.clientWidth
  }

  // The strip must be at least one viewport wide, and wide enough that the
  // furthest bar tip (a running task drawn out to `now`) never clips.
  const innerWidth = $derived(Math.max(viewportWidth, (now - originTs) * pxPerSec + RIGHT_PAD_PX))

  // Scroll fires far faster than a frame; coalesce to one read per frame so
  // the handler never forces synchronous layout in a tight loop.
  function scheduleViewportSync() {
    if (cullPending) return
    cullPending = true
    requestAnimationFrame(() => {
      cullPending = false
      syncViewportBounds()
    })
  }

  // A window resize changes how much of the strip is visible without moving
  // the scroll position, so it needs its own trigger.
  $effect(() => {
    syncViewportBounds()
    window.addEventListener('resize', scheduleViewportSync)
    return () => window.removeEventListener('resize', scheduleViewportSync)
  })

  const bars = $derived.by<Bar[]>(() => {
    // viewportWidth stays 0 until the element is measured; render everything
    // until then rather than showing an empty strip on the first paint.
    const culling = viewportWidth > 0
    const visibleFrom = scrollLeft - CULL_MARGIN_PX
    const visibleTo = scrollLeft + viewportWidth + CULL_MARGIN_PX
    const out: Bar[] = []
    for (const t of tasks) {
      // `now` still ticks every 250ms, so a running bar's right edge still
      // grows in small jumps rather than a true animation. That is fine here:
      // originTs is fixed, so the jump is confined to the bar's own width,
      // not to its (or every other bar's) position — and a running bar's tip
      // sits either in the render-delay band the operator isn't looking at
      // yet, or off the right edge entirely.
      const end = t.end_ts ?? now
      if (end < windowStart) continue // stale-data filter only, not a coordinate
      const lane = Math.min(Math.max(t.slot ?? 0, 0), Math.max(laneCount - 1, 0))
      const { left, width } = barGeometry(t.start_ts, end, originTs, pxPerSec, MIN_BAR_PX)
      if (culling && (left + width < visibleFrom || left > visibleTo)) continue
      out.push({ task: t, lane, left, width, color: barColor(t.status) })
    }
    return out
  })

  // Axis ticks: HH:MM:SS labels at a zoom-dependent interval (the reference's
  // rebuildAxis picks 5..120s so labels never crowd each other). Positions are
  // relative to originTs, so a tick's pixel position is stable as `now`
  // advances — only the set of ticks in range changes.
  const ticks = $derived.by<{ left: number; ts: number; label: string }[]>(() => {
    return tickMarks(originTs, now, pxPerSec, originTs).map((t) => ({
      ...t,
      label: fmtTime(t.ts),
    }))
  })

  // Track the last scrollLeft we set programmatically (auto-follow, rebase,
  // zoom-preserve). onScroll compares against it to tell our own writes apart
  // from a real user scroll, without relying on scroll-event timing/ordering.
  let lastProgrammaticScrollLeft: number | null = null

  function applyScrollLeft(px: number) {
    if (!viewport) return
    const clamped = Math.max(0, px)
    if (Math.abs(viewport.scrollLeft - clamped) >= 0.5) {
      viewport.scrollLeft = clamped
    }
    lastProgrammaticScrollLeft = viewport.scrollLeft
    syncViewportBounds()
  }

  // One follow step: place `renderNow` (now, minus the intentional display
  // delay) at the viewport's right edge. Called once synchronously whenever
  // the follow loop (re)starts, and then once per animation frame.
  function followTick() {
    if (!viewport) return
    const renderNow = Date.now() / 1000 - RENDER_DELAY_SEC
    applyScrollLeft(followScrollLeft(renderNow, originTs, pxPerSec, viewport.clientWidth))
  }

  // Smooth auto-follow: while following, not paused, and the tab is visible,
  // step the scroll position every animation frame instead of jumping it on
  // each 250ms `now` tick — that's what turns the "slide" back into an actual
  // slide.
  //
  // `untrack` around the followTick() calls keeps this effect's dependencies
  // to exactly {paused, following, hiddenState, viewport}: without it, the
  // pxPerSec/originTs reads inside followTick would make it a dependency too,
  // and the effect would tear down and rebuild the whole rAF loop on every
  // zoom change and every rebase instead of just letting the next frame pick
  // up the new values. The scrollLeft write itself goes straight to the DOM
  // (not a $state), and the one $state it touches (via syncViewportBounds) is
  // only read by the `bars` culling derived, not by this effect — so there is
  // no reactive loop feeding back into this effect's own re-execution.
  $effect(() => {
    if (paused || !following || hiddenState || !viewport) return
    let raf = 0
    function loop() {
      untrack(followTick)
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  })

  function onScroll() {
    if (!viewport) return
    const isOurs =
      lastProgrammaticScrollLeft != null &&
      Math.abs(viewport.scrollLeft - lastProgrammaticScrollLeft) < 0.5
    if (!isOurs) {
      // A real user scroll: re-arm auto-follow only once they're back near
      // the live edge, so scrolling away reliably stops the content sliding
      // under the cursor, and scrolling back reliably resumes it.
      const distanceFromEdge = viewport.scrollWidth - viewport.scrollLeft - viewport.clientWidth
      const threshold = Math.max(MIN_FOLLOW_THRESHOLD_PX, (RENDER_DELAY_SEC * pxPerSec) / 2)
      following = distanceFromEdge < threshold
    }
    scheduleViewportSync()
  }

  // Zoom while not following keeps the timestamp at the viewport's right edge
  // fixed, so zooming doesn't also relocate what the operator is looking at.
  // While following, the rAF loop repositions on the very next frame, so
  // there's nothing to preserve here.
  function zoomTo(target: number) {
    const clamped = Math.min(64, Math.max(0.25, target))
    if (!viewport || following) {
      zoomLevel = clamped
      return
    }
    const oldPxPerSec = pxPerSec
    const rightEdgeTs = originTs + (viewport.scrollLeft + viewport.clientWidth) / oldPxPerSec
    zoomLevel = clamped
    applyScrollLeft((rightEdgeTs - originTs) * pxPerSec - viewport.clientWidth)
  }
  function zoomIn() {
    zoomTo(zoomLevel * 2)
  }
  function zoomOut() {
    zoomTo(zoomLevel / 2)
  }
  function zoomReset() {
    zoomTo(2)
  }
  function jumpNow() {
    // The follow effect calls followTick() synchronously as soon as
    // `following` flips true, so this snaps to the live edge immediately
    // rather than waiting for the next animation frame.
    following = true
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
    >(last 10 min, {RENDER_DELAY_SEC} sec delayed{#if minDurationMs > 0}, tasks &ge; {minDurationMs}ms{/if})</span
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
