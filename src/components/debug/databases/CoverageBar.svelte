<script lang="ts">
  // The coverage bar (design 2.3, E): one lane per source on one time axis.
  // Dragging across the lanes selects a range, which the parent writes to
  // `db_from` and `db_to`.
  import { dragRange, spanPosition, type Coverage } from '../../../lib/coverage'
  import { fmtDateTimeMs } from '../../../lib/format'

  interface Props {
    coverage: Coverage
    /** The range now chosen in the URL, drawn over the lanes. */
    selection: { from: number; to: number } | null
    onselect: (range: { from: number; to: number }) => void
  }
  let { coverage, selection, onselect }: Props = $props()

  let tracks: HTMLDivElement | undefined = $state()
  let dragStart = $state<number | null>(null)
  let dragNow = $state<number | null>(null)

  function fractionAt(event: PointerEvent): number {
    const box = tracks?.getBoundingClientRect()
    if (!box || box.width === 0) return 0
    return (event.clientX - box.left) / box.width
  }

  function begin(event: PointerEvent) {
    dragStart = dragNow = fractionAt(event)
    tracks?.setPointerCapture?.(event.pointerId)
  }
  function move(event: PointerEvent) {
    if (dragStart !== null) dragNow = fractionAt(event)
  }
  function end(event: PointerEvent) {
    if (dragStart === null || !coverage.axis) return
    const range = dragRange(coverage.axis, dragStart, fractionAt(event))
    dragStart = dragNow = null
    if (range) onselect(range)
  }

  const axis = $derived(coverage.axis)
  const drag = $derived(
    dragStart !== null && dragNow !== null
      ? {
          left: Math.min(dragStart, dragNow) * 100,
          width: Math.abs(dragNow - dragStart) * 100,
        }
      : null,
  )
  const chosen = $derived(
    axis && selection ? spanPosition({ from: selection.from, to: selection.to }, axis, 0.3) : null,
  )

  function fmt(ts: number): string {
    return fmtDateTimeMs(ts * 1000)
  }
</script>

{#if axis}
  <div class="coverage" aria-label="coverage bar">
    <div class="lanes">
      {#each coverage.lanes as lane (lane.key)}
        <div class="label">{lane.label}</div>
      {/each}
    </div>
    <div class="area">
      <div
        class="tracks"
        bind:this={tracks}
        role="presentation"
        onpointerdown={begin}
        onpointermove={move}
        onpointerup={end}
        onpointercancel={() => (dragStart = dragNow = null)}
      >
        {#each coverage.lanes as lane (lane.key)}
          <div class="track" data-lane={lane.key}>
            {#each lane.spans as span, i (`${i}:${span.label}`)}
              {@const pos = spanPosition(span, axis)}
              <div
                class="span"
                style:left="{pos.left}%"
                style:width="{pos.width}%"
                title="{span.label}: {fmt(span.from)} to {fmt(span.to)}"
              ></div>
            {/each}
          </div>
        {/each}
        {#if chosen}<div class="pick" style:left="{chosen.left}%" style:width="{chosen.width}%"></div>{/if}
        {#if drag}<div class="pick drag" style:left="{drag.left}%" style:width="{drag.width}%"></div>{/if}
      </div>
      <div class="ends muted"><span>{fmt(axis.from)}</span><span>{fmt(axis.to)}</span></div>
      <div class="hint muted">Drag across the lanes to choose a range for a slice.</div>
    </div>
  </div>
{/if}

<style>
  .coverage {
    display: flex;
    gap: 0.6rem;
    margin-bottom: 1rem;
    font-size: 0.8rem;
  }
  .lanes .label,
  .track {
    height: 1.4rem;
    line-height: 1.4rem;
    margin-bottom: 0.25rem;
  }
  .lanes .label {
    color: var(--muted);
    white-space: nowrap;
  }
  .area {
    flex: 1;
    min-width: 0;
  }
  .tracks {
    position: relative;
    cursor: crosshair;
    touch-action: none;
    user-select: none;
  }
  .track {
    position: relative;
    background: var(--panel-2);
    border-radius: 4px;
  }
  .span {
    position: absolute;
    top: 0.2rem;
    bottom: 0.2rem;
    background: var(--accent);
    opacity: 0.75;
    border-radius: 3px;
  }
  .pick {
    position: absolute;
    top: 0;
    bottom: 0;
    border: 1px solid var(--text);
    background: rgba(13, 148, 136, 0.15);
    pointer-events: none;
  }
  .pick.drag {
    border-style: dashed;
  }
  .ends {
    display: flex;
    justify-content: space-between;
  }
</style>
