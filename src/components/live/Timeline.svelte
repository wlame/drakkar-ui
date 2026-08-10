<script lang="ts">
  // Executor timeline, ported from live.html's Executors tab: an h2 with the
  // window note, a Zoom toolbar + legend row, and a white panel containing the
  // time axis, one lane per executor slot and a fixed-height hover-detail strip.
  // Bars are colored by the configured rules (falling back to status); the
  // view auto-follows "now" until the operator scrolls away from the right
  // edge.
  //
  // Coordinate system: bar/tick positions are computed against a fixed
  // `originTs`, not against "now". An earlier version used `now - maxAgeSec`
  // as the origin, which steps every 250ms — every bar's absolute pixel
  // position (and the strip's width) was recomputed against a moving target,
  // which reads as a jump, not a slide, four times a second. Here `originTs`
  // only moves on a rare rebase (see `maybeRebase` below), so a task's pixel
  // position is stable between rebases and "time passing" is real scrolling,
  // driven by a requestAnimationFrame loop instead of state churn. The pure
  // math lives in src/lib/timeline.ts (tested independently of the DOM).
  import { untrack, flushSync } from 'svelte'
  import { link } from '../../lib/router'
  import { baseTaskId, type TaskView } from '../../lib/live'
  import { fmtTime, fmtTimeMs, fmtBytes } from '../../lib/format'
  import { pausableInterval, isHidden } from '../../lib/visibility'
  import type { TimelineConfig } from '../../lib/types'
  import { barColorFor, legendEntries } from '../../lib/timelineRules'
  import {
    TIMELINE_ROLES,
    loadRoleOverrides,
    saveRoleOverride,
    clearRoleOverride,
    clearAllRoleOverrides,
    resolveRoles,
    labelKeyUnion,
    isOverridden,
    type RoleOverrides,
    type TimelineRole,
  } from '../../lib/timelineRoles'
  import {
    barGeometry,
    barTexts,
    deriveMarkers,
    textColorFor,
    tickMarks,
    followScrollLeft,
    shouldRebase,
    rebase,
    RENDER_DELAY_SEC,
    type MarkerPin,
  } from '../../lib/timeline'

  let {
    tasks = [],
    laneCount = 8,
    paused = false,
    minDurationMs = 0,
    timeline = undefined,
    workerId = '',
  }: {
    tasks?: TaskView[]
    laneCount?: number
    paused?: boolean
    minDurationMs?: number
    // ui.timeline from GET /api/v1/identity: bar-color rules, label-role
    // bindings and the history depth. Undefined on backends that predate it,
    // which keeps the legacy 10-minute, status-colored timeline.
    timeline?: TimelineConfig
    // Which worker's role overrides to read/write (they are per worker).
    workerId?: string
  } = $props()

  // How far back the timeline draws when the backend says nothing.
  const DEFAULT_MAX_AGE_MIN = 10
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
  let hoveredMarker = $state<MarkerPin | null>(null)
  let hiddenState = $state(isHidden())

  // --- configured depth, colors and label roles -------------------------------

  // The visible history depth, in seconds. Everything that used to be the
  // fixed 10-minute WINDOW_SEC reads this instead: the stale cut, the rebase
  // step, and the heading note.
  const maxAgeMinutes = $derived(timeline?.max_age_minutes ?? DEFAULT_MAX_AGE_MIN)
  const maxAgeSec = $derived(maxAgeMinutes * 60)

  const colorRules = $derived(timeline?.color_rules ?? [])
  const ruleLegend = $derived(legendEntries(colorRules))
  // The backend's role bindings; the viewer's local overrides win over them.
  const backendRoles = $derived(timeline?.labels ?? {})
  // Writable derived: it re-reads storage whenever the worker identity lands
  // or changes, and the popover handlers assign to it directly after a write
  // so an override applies on the same tick it is made.
  let overrides = $derived<RoleOverrides>(loadRoleOverrides(workerId))
  const roles = $derived(resolveRoles(backendRoles, overrides))

  // Chosen once at mount, one full window back — pre-existing tasks from the
  // last `maxAgeSec` have room to draw; anything older still clamps to the
  // left edge via barGeometry, same as the old windowStart clamp did. Only
  // `maybeRebase` and the deepening effect move it again after that.
  // untrack: this is an initial value, not a subscription — a depth that
  // lands later is picked up by that effect.
  let originTs = $state(Date.now() / 1000 - untrack(() => maxAgeSec))

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

  // Moves the coordinate origin and shifts the viewport's scrollLeft by the
  // exact same pixel delta in the same synchronous step, which is what makes
  // the move invisible — see the pixel-delta invariant documented and tested
  // next to `rebase()` in src/lib/timeline.ts. Both callers below depend on
  // that pairing.
  function setOrigin(newOrigin: number) {
    const deltaPx = (newOrigin - originTs) * pxPerSec
    originTs = newOrigin
    if (viewport) applyScrollLeft(viewport.scrollLeft - deltaPx)
  }

  // Slide the origin forward by one window once the strip has grown to more
  // than twice maxAgeSec, so the DOM/coordinate range doesn't grow forever.
  // Runs from the 250ms tick above (not the follow rAF loop) so it keeps
  // happening even while the operator has scrolled away and auto-follow is
  // off.
  function maybeRebase() {
    if (!shouldRebase(now, originTs, maxAgeSec)) return
    setOrigin(rebase(originTs, maxAgeSec))
  }

  // The identity payload (and with it the configured depth) usually lands
  // after this component mounts, so the origin picked at mount can be far too
  // recent for the window the backend actually serves — a 60-minute history
  // would pile up against the left edge of a 10-minute strip. Pull the origin
  // back once when a deeper depth appears.
  $effect(() => {
    const wanted = Date.now() / 1000 - maxAgeSec
    untrack(() => {
      if (wanted < originTs) setOrigin(wanted)
    })
  })

  const pxPerSec = $derived(BASE_PX_PER_SEC * zoomLevel)
  const windowStart = $derived(now - maxAgeSec)
  const lanesHeight = $derived(laneCount * (LANE_H + LANE_GAP))

  interface Bar {
    task: TaskView
    lane: number
    left: number
    width: number
    color: string
    // Text drawn inside the bar, already truncated and fitted by barTexts;
    // absent when the role is unbound, the task lacks the label, or the bar
    // is too narrow.
    tag?: string
    caption?: string
    // Readable text color for `color`; '' when the bar draws no text.
    textColor: string
    // Toolbar highlight/filter outcome. Both false while no input is active,
    // which is what keeps an untouched timeline looking exactly as before.
    emph: boolean
    dim: boolean
  }

  // Shared empty result so the common "no tag/caption roles bound" case
  // allocates nothing per bar per frame.
  const NO_BAR_TEXTS: { tag?: string; caption?: string } = {}

  // --- toolbar role inputs ----------------------------------------------------
  //
  // Both are kept as strings: an empty box means "inactive", which a number
  // binding could not express, and the filter needle is a string anyway.
  let highlightInput = $state('')
  let filterInput = $state('')

  const highlightKey = $derived(roles.highlight ?? '')
  const filterKey = $derived(roles.filter ?? '')
  const highlightThreshold = $derived(
    highlightInput.trim() === '' ? Number.NaN : Number(highlightInput),
  )
  const highlightActive = $derived(highlightKey !== '' && Number.isFinite(highlightThreshold))
  const filterNeedle = $derived(filterInput.trim().toLowerCase())
  const filterActive = $derived(filterKey !== '' && filterNeedle !== '')
  const roleInputActive = $derived(highlightActive || filterActive)

  // A task missing the label never matches an active input — it cannot be
  // shown to clear the threshold or contain the needle.
  function matchesHighlight(t: TaskView, key: string, threshold: number): boolean {
    const raw = t.labels?.[key]
    if (raw === undefined) return false
    const value = parseFloat(raw)
    return Number.isFinite(value) && value > threshold
  }
  function matchesFilter(t: TaskView, key: string, needle: string): boolean {
    const raw = t.labels?.[key]
    if (raw === undefined) return false
    return raw.toLowerCase().includes(needle)
  }

  // Horizontal culling bounds, tracked from the viewport's scroll position.
  //
  // The strip is maxAgeSec * pxPerSec wide — 9600px at the default zoom and
  // the default depth —
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
    // Read the role bindings once per pass, not once per bar.
    const tagKey = roles.tag
    const captionKey = roles.caption
    const drawsText = tagKey !== undefined || captionKey !== undefined
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
      const color = barColorFor(t, colorRules)
      const texts = drawsText
        ? barTexts(
            width,
            tagKey !== undefined ? t.labels?.[tagKey] : undefined,
            captionKey !== undefined ? t.labels?.[captionKey] : undefined,
          )
        : NO_BAR_TEXTS
      // Every active input must pass; with none active no bar is marked, so
      // emph/dim never touch the default look.
      const passes =
        roleInputActive &&
        (!highlightActive || matchesHighlight(t, highlightKey, highlightThreshold)) &&
        (!filterActive || matchesFilter(t, filterKey, filterNeedle))
      out.push({
        task: t,
        lane,
        left,
        width,
        color,
        tag: texts.tag,
        caption: texts.caption,
        textColor: texts.tag || texts.caption ? textColorFor(color) : '',
        emph: passes,
        dim: roleInputActive && !passes,
      })
    }
    return out
  })

  // Marker pins for the marker-role label, one per distinct value at its
  // earliest start. Deliberately NOT derived on scrollLeft: this walks every
  // loaded task, so it recomputes only when the tasks, the role, the origin
  // or the zoom actually change — never on a scroll or a `now` tick.
  const markerKey = $derived(roles.marker ?? '')
  const markers = $derived(deriveMarkers(tasks, markerKey, originTs, pxPerSec))

  // Culled the same way bars are: a deep window with a high-cardinality
  // marker label can produce thousands of pins, and only the visible band
  // needs to exist in the DOM. Filtering the precomputed array is cheap
  // enough to redo per frame.
  const visibleMarkers = $derived.by<MarkerPin[]>(() => {
    if (viewportWidth <= 0 || markers.length === 0) return markers
    const visibleFrom = scrollLeft - CULL_MARGIN_PX
    const visibleTo = scrollLeft + viewportWidth + CULL_MARGIN_PX
    return markers.filter((m) => m.left >= visibleFrom && m.left <= visibleTo)
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
    // Zooming in shrinks the pre-zoom scrollWidth's headroom or grows past it
    // depending on direction, but on zoom-IN the target scrollLeft can exceed
    // the *pre-zoom* scrollWidth. The `.tl-inner` width binding reacts to
    // `innerWidth`/`pxPerSec` through Svelte 5's template effect, which is
    // batched to a microtask — a plain onclick handler doesn't wait for it.
    // Without forcing that effect to run first, the browser clamps the
    // scrollLeft write below to the stale (smaller) pre-zoom scrollWidth, and
    // nothing later corrects it: the right edge silently lands at an earlier
    // timestamp than requested. flushSync forces the width binding to commit
    // to the DOM before the scrollLeft write, so the browser clamps against
    // the correct, already-widened strip.
    flushSync(() => {
      zoomLevel = clamped
    })
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

  // --- role-override popover --------------------------------------------------
  //
  // Lives in the toolbar, outside every keyed {#each}, so applying an override
  // cannot detach the very element the click started on while the bar list
  // re-renders underneath.
  let gearOpen = $state(false)
  let gearEl = $state<HTMLDivElement>()

  // Scanning every loaded task for label keys is only worth it while the
  // picker is actually open.
  const labelKeys = $derived(gearOpen ? labelKeyUnion(tasks, backendRoles) : [])
  const anyOverridden = $derived(
    TIMELINE_ROLES.some((role) => isOverridden(backendRoles, overrides, role)),
  )

  // The union plus the role's own resolved key, so an override pointing at a
  // key no loaded task currently carries still shows as the selected option
  // instead of silently reading as "(none)".
  function roleOptions(role: TimelineRole): string[] {
    const current = roles[role]
    if (!current || labelKeys.includes(current)) return labelKeys
    return [...labelKeys, current].sort()
  }

  function applyRoleSelection(role: TimelineRole, value: string) {
    // '' is the "(none)" option — an explicit disable, stored as null. That
    // is not the same as having no override, which follows the backend.
    saveRoleOverride(workerId, role, value === '' ? null : value)
    overrides = loadRoleOverrides(workerId)
  }
  function resetRole(role: TimelineRole) {
    clearRoleOverride(workerId, role)
    overrides = loadRoleOverrides(workerId)
  }
  function resetAllRoles() {
    clearAllRoleOverrides(workerId)
    overrides = loadRoleOverrides(workerId)
  }

  // Close on a click anywhere outside the gear. pointerdown rather than click
  // so the decision is made against the DOM as it was when the press started.
  $effect(() => {
    if (!gearOpen) return
    function onPointerDown(e: PointerEvent) {
      if (gearEl && !gearEl.contains(e.target as Node)) gearOpen = false
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  })

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
  function fmtStdout(t: TaskView): string {
    if (!t.stdout_size) return '-'
    if (t.stdout_lines == null) return fmtBytes(t.stdout_size)
    return `${t.stdout_lines} lines, ${fmtBytes(t.stdout_size)}`
  }
</script>

<h2 class="tl-title">
  Timeline
  <span class="tl-note"
    >(last {maxAgeMinutes} min, {RENDER_DELAY_SEC} sec delayed{#if minDurationMs > 0}, tasks &ge; {minDurationMs}ms{/if})</span
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
  {#if highlightKey}
    <label class="role-input" title={`Emphasize tasks whose ${highlightKey} label exceeds n`}>
      <span class="role-key">{highlightKey} &gt;</span>
      <input
        class="role-num"
        type="number"
        placeholder="n"
        value={highlightInput}
        oninput={(e) => (highlightInput = e.currentTarget.value)}
      />
    </label>
  {/if}
  {#if filterKey}
    <label class="role-input" title={`Emphasize tasks whose ${filterKey} label contains the text`}>
      <span class="role-key">{filterKey} &ni;</span>
      <input
        class="role-text"
        type="text"
        placeholder="contains"
        value={filterInput}
        oninput={(e) => (filterInput = e.currentTarget.value)}
      />
    </label>
  {/if}
  <div class="legend">
    <span><i style:background="#34d399"></i>completed</span>
    <span><i style:background="#fbbf24"></i>running</span>
    <span><i style:background="#f87171"></i>failed</span>
    {#each ruleLegend as entry}
      <span><i style:background={entry.color}></i>{entry.label}</span>
    {/each}
  </div>
  <div class="roles" bind:this={gearEl}>
    <button
      class="tbtn gear"
      onclick={() => (gearOpen = !gearOpen)}
      title="Label roles"
      aria-label="Label roles"
      aria-expanded={gearOpen}
    >
      &#9881;{#if anyOverridden}<i class="dot"></i>{/if}
    </button>
    {#if gearOpen}
      <div class="role-pop">
        <div class="role-pop-head">
          <span>Label roles</span>
          <button class="tbtn" onclick={resetAllRoles}>Reset all</button>
        </div>
        {#each TIMELINE_ROLES as role}
          <div class="role-row">
            <span class="role-name"
              >{role}{#if isOverridden(backendRoles, overrides, role)}<i class="dot"></i>{/if}</span
            >
            <select
              value={roles[role] ?? ''}
              onchange={(e) => applyRoleSelection(role, e.currentTarget.value)}
              aria-label={`${role} label`}
            >
              <option value="">(none)</option>
              {#each roleOptions(role) as key}
                <option value={key}>{key}{backendRoles[role] === key ? ' (default)' : ''}</option>
              {/each}
            </select>
            <button class="tbtn" onclick={() => resetRole(role)} disabled={!(role in overrides)}
              >Reset</button
            >
          </div>
        {/each}
      </div>
    {/if}
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
      {#if markerKey}
        <div class="tl-markers">
          {#each visibleMarkers as m (m.ts)}
            <button
              class="marker-pin"
              type="button"
              style:left={`${m.left}px`}
              onmouseenter={() => (hoveredMarker = m)}
              onmouseleave={() => (hoveredMarker = null)}
              onfocus={() => (hoveredMarker = m)}
              onblur={() => (hoveredMarker = null)}
            >
              <span class="marker-val">{m.values[0]}</span>
              {#if m.values.length > 1}
                <span class="marker-count">+{m.values.length - 1}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
      <div class="tl-lanes" style:height={`${lanesHeight}px`}>
        {#each Array(laneCount) as _, i}
          {#if i % 2 === 0}
            <div class="stripe" style:top={`${i * (LANE_H + LANE_GAP)}px`}></div>
          {/if}
          <div class="lane-label" style:top={`${i * (LANE_H + LANE_GAP)}px`}>#{i}</div>
        {/each}
        {#each visibleMarkers as m (m.ts)}
          <div class="marker-line" style:left={`${m.left}px`}></div>
        {/each}
        {#each bars as b (b.task.task_id)}
          <a
            class="bar"
            class:emph={b.emph}
            class:dim={b.dim}
            href={`/task/${encodeURIComponent(baseTaskId(b.task.task_id))}`}
            use:link
            style:left={`${b.left}px`}
            style:top={`${b.lane * (LANE_H + LANE_GAP)}px`}
            style:width={`${b.width}px`}
            style:background={b.color}
            style:color={b.textColor}
            onmouseenter={() => (hovered = b.task)}
            onmouseleave={() => (hovered = null)}
            aria-label={b.task.task_id}
          >
            {#if b.caption}<span class="bar-caption">{b.caption}</span>{/if}
            {#if b.tag}<span class="bar-tag">{b.tag}</span>{/if}
          </a>
        {/each}
      </div>
    </div>
  </div>

  <div class="tl-hover">
    <!-- A hovered bar wins: a pin whose element was culled away mid-hover
         never got its mouseleave, and a stale marker must not shadow the
         task detail the operator is actually pointing at. -->
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
      {#if hovered.stdout_size}
        <span class="hl">Stdout:</span><span class="hv stdout-ok">{fmtStdout(hovered)}</span>
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
    {:else if hoveredMarker}
      <span class="hl">marker:</span><span class="hv">{hoveredMarker.values.join(', ')}</span>
      <span class="hl">at</span><span class="hv">{fmtTimeMs(hoveredMarker.ts)}</span>
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
  /* Toolbar inputs for the highlight (numeric) and filter (substring) roles.
     Rendered only when the role resolves to a label key. */
  .role-input {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .role-key {
    font-family: var(--mono);
    color: #9ca3af;
  }
  .role-input input {
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    padding: 0.0625rem 0.25rem;
    font-size: 0.75rem;
    font-family: var(--mono);
    background: #fff;
  }
  .role-num {
    width: 5rem;
  }
  .role-text {
    width: 7rem;
  }

  .legend {
    margin-left: auto;
    display: flex;
    flex-wrap: wrap;
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

  /* Role-override popover. Anchored to the gear button and kept in the
     toolbar, well away from the bar list that re-renders under it. */
  .roles {
    position: relative;
  }
  .gear {
    font-size: 0.875rem;
    line-height: 1.2;
  }
  .dot {
    display: inline-block;
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
    background: #0d9488;
    margin-left: 0.25rem;
    vertical-align: middle;
  }
  .role-pop {
    position: absolute;
    top: calc(100% + 0.25rem);
    right: 0;
    z-index: 20;
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 0.375rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    padding: 0.5rem;
    min-width: 20rem;
  }
  .role-pop-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    font-size: 0.75rem;
    color: #6b7280;
    margin-bottom: 0.375rem;
  }
  .role-row {
    display: grid;
    grid-template-columns: 5rem 1fr auto;
    align-items: center;
    gap: 0.375rem;
    margin-top: 0.25rem;
  }
  .role-name {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .role-row select {
    font-size: 0.75rem;
    font-family: var(--mono);
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    padding: 0.0625rem 0.25rem;
    background: #fff;
    max-width: 100%;
  }
  .role-row button:disabled {
    opacity: 0.4;
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
    overflow: hidden;
  }
  /* Highlight/filter result. Neither class is applied while every toolbar
     input is empty, so an untouched timeline is unaffected. */
  .bar.emph {
    outline: 2px solid #1f2937;
    opacity: 1;
    z-index: 3;
  }
  .bar.dim {
    opacity: 0.25;
  }
  /* Bar text. Both pieces are drawn only when barTexts said they fit, and
     both are click-through so the bar itself stays the hover/link target. */
  .bar-tag {
    position: absolute;
    right: 3px;
    top: 50%;
    transform: translateY(-50%);
    padding: 0 2px;
    border: 1px solid currentColor;
    border-radius: 2px;
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1.3;
    white-space: nowrap;
    pointer-events: none;
  }
  .bar-caption {
    position: absolute;
    left: 4px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 10px;
    line-height: 1.3;
    white-space: nowrap;
    pointer-events: none;
  }

  /* Marker rail between the axis and the lanes: one pin per distinct value
     of the marker-role label, with its guide line drawn down the lanes. */
  .tl-markers {
    position: relative;
    height: 14px;
  }
  .marker-pin {
    position: absolute;
    top: 0;
    display: inline-flex;
    align-items: center;
    gap: 2px;
    background: transparent;
    border: none;
    border-left: 1px solid #9ca3af;
    border-radius: 0;
    padding: 0 3px;
    font-family: var(--mono);
    font-size: 9px;
    line-height: 14px;
    color: #6b7280;
    white-space: nowrap;
    cursor: default;
  }
  .marker-count {
    background: #e5e7eb;
    border-radius: 6px;
    padding: 0 3px;
    color: #4b5563;
  }
  .marker-line {
    position: absolute;
    top: 0;
    width: 1px;
    height: 100%;
    background: #9ca3af;
    pointer-events: none;
    z-index: 1;
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
  /* Non-empty stdout in the hover detail — same green as completed status. */
  .hv.stdout-ok {
    color: #059669;
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
