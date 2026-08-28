// Mounts the real timeline against a ui.timeline config: rule-driven bar
// colors, bar tag/caption text, marker pins and lines, the rule legend, the
// highlight/filter emphasis, and the role-override popover.
//
// `paused` is set on every mount so neither the 250ms `now` tick nor the
// auto-follow rAF loop runs — the geometry under test is static then, and the
// tests stay deterministic.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import Timeline from './Timeline.svelte'
import type { TaskView } from '../../lib/live'
import type { TimelineConfig, TimelineEventDecl } from '../../lib/types'
import type { EventMatch, TimelineEventView } from '../../lib/timelineEvents'
import { tagBoxWidth, TAG_EDGE_MARGIN_PX } from '../../lib/timeline'

const NOW = Date.now() / 1000

function task(id: string, startOffset: number, extra: Partial<TaskView> = {}): TaskView {
  return {
    task_id: id,
    partition: 0,
    start_ts: NOW - startOffset,
    end_ts: NOW - startOffset + 20,
    duration: 20,
    status: 'completed',
    exit_code: 0,
    args: '--in file',
    pid: 100,
    slot: 0,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
    stdout_size: 4096,
    stdout_lines: 10,
    stdin_lines: null,
    stdin_size: null,
    env: null,
    source_offsets: null,
    spawn_ms: null,
    queue_wait_ms: null,
    ...extra,
  }
}

const config: TimelineConfig = {
  history_factor: 100,
  max_age_minutes: 30,
  color_rules: [
    {
      name: 'empty output',
      when: [{ field: 'stdout_size', op: 'eq', value: 0 }],
      color: 'lightgray',
    },
    { name: '', when: [{ label: 'file_size_bytes', op: 'gt', value: 10240 }], color: 'blue' },
  ],
  labels: {
    tag: 'file_size',
    caption: 'file_name',
    highlight: 'lines',
    filter: 'module',
    marker: 'request',
  },
}

// Two tasks 30s apart: one big file (matches the blue rule), one empty-output
// task (matches the lightgray rule). Distinct `request` values give two
// marker pins far enough apart not to collapse.
const tasks: TaskView[] = [
  task('big', 60, {
    labels: {
      file_size: '12.4K',
      file_name: 'first_input_file.csv',
      file_size_bytes: '20480',
      lines: '900',
      module: 'importer',
      request: '0:41',
    },
  }),
  task('empty', 30, {
    stdout_size: 0,
    labels: {
      file_size: '80',
      file_name: 'second_input_file.csv',
      file_size_bytes: '80',
      lines: '3',
      module: 'vendor/legacy',
      request: '0:42',
    },
  }),
]

function render(props: Record<string, unknown> = {}) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(Timeline, {
    target,
    props: { tasks, laneCount: 2, paused: true, timeline: config, workerId: 'worker-a', ...props },
  })
  flushSync()
  return { target, component }
}

function barFor(target: HTMLElement, taskId: string): HTMLAnchorElement {
  const bar = target.querySelector(`a.bar[aria-label="${taskId}"]`)
  expect(bar).not.toBeNull()
  return bar as HTMLAnchorElement
}

// happy-dom does no layout, so the viewport measures 0 and the component
// treats the whole strip as visible. Stamp a size and a scroll position on
// it, then let the component's rAF-coalesced sync pick them up.
async function measureViewport(target: HTMLElement, width: number, scrollLeft: number) {
  const viewport = target.querySelector('.tl-viewport') as HTMLElement
  Object.defineProperty(viewport, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(viewport, 'scrollLeft', {
    value: scrollLeft,
    writable: true,
    configurable: true,
  })
  viewport.dispatchEvent(new Event('scroll'))
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  flushSync()
}

function styleNumber(el: HTMLElement, property: 'left' | 'width'): number {
  return parseFloat(el.style.getPropertyValue(property))
}

function eventDecl(name: string, extra: Partial<TimelineEventDecl> = {}): TimelineEventDecl {
  return {
    name,
    kind: 'marker',
    color: '#7c3aed',
    show: true,
    action: 'none',
    ...extra,
  }
}

function eventInstance(
  type: string,
  ts: number,
  extra: Partial<TimelineEventView> = {},
): TimelineEventView {
  return {
    type,
    ts,
    endTs: null,
    text: '',
    values: {},
    match: null,
    partition: 0,
    ...extra,
  }
}

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

function renderTracked(props: Record<string, unknown> = {}) {
  const handle = render(props)
  mounted.push(handle)
  return handle
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(async () => {
  for (const { target, component } of mounted.splice(0)) {
    await unmount(component)
    target.remove()
  }
})

describe('Timeline', () => {
  it('colors bars from the configured rules', () => {
    const { target } = renderTracked()
    // First-match-wins: 'big' clears the gt rule (blue), 'empty' matches the
    // stdout_size rule declared before it (lightgray).
    expect(barFor(target, 'big').getAttribute('style')).toContain('#60a5fa')
    expect(barFor(target, 'empty').getAttribute('style')).toContain('#d1d5db')
  })

  it('falls back to the status color with no rules configured', () => {
    const { target } = renderTracked({ timeline: { ...config, color_rules: [] } })
    expect(barFor(target, 'big').getAttribute('style')).toContain('#34d399')
  })

  it('renders the rule legend as bare swatches that name themselves on hover', () => {
    const { target } = renderTracked()
    const legend = target.querySelector('.legend') as HTMLElement
    // Words only on hover: the strip itself carries no text.
    expect(legend.textContent?.trim()).toBe('')
    const titles = [...legend.querySelectorAll('i')].map((i) => i.getAttribute('title'))
    expect(titles.slice(0, 3)).toEqual(['completed', 'running', 'failed'])
    expect(titles).toContain('empty output')
    // An unnamed rule falls back to generated condition text.
    expect(titles).toContain('file_size_bytes gt 10240')
  })

  it('draws the tag and caption labels inside the bars', () => {
    const { target } = renderTracked()
    const bar = barFor(target, 'big')
    expect(bar.querySelector('.bar-tag')?.textContent).toBe('12.4K')
    expect(bar.querySelector('.bar-caption')?.textContent).toBe('first_input_file.csv')
  })

  it('clamps a running bar tag to the viewport edge and leaves a visible bar tag on its own edge', async () => {
    // A running bar is drawn out to `now`, which is past the viewport's right
    // edge by design; a fully visible completed bar sits next to it.
    const running = task('running', 60, {
      status: 'running',
      end_ts: null,
      duration: null,
      stdout_size: null,
      labels: { file_size: '12.4K', file_name: 'first_input_file.csv', request: '0:41' },
    })
    const done = task('done', 58, {
      end_ts: NOW - 48,
      duration: 10,
      labels: { file_size: '12.4K', file_name: 'second_input_file.csv', request: '0:42' },
    })
    const { target } = renderTracked({ tasks: [running, done] })

    const runningBar = barFor(target, 'running')
    const viewportWidth = 300
    // Scroll so the running bar starts exactly at the viewport's left edge:
    // bar-local offsets and viewport-local offsets then coincide.
    await measureViewport(target, viewportWidth, styleNumber(runningBar, 'left'))

    expect(styleNumber(runningBar, 'width')).toBeGreaterThan(viewportWidth)
    const runningTag = runningBar.querySelector('.bar-tag') as HTMLElement
    const tagWidth = tagBoxWidth(runningTag.textContent ?? '')
    // Rides the viewport edge, not the bar's right edge far off-screen.
    expect(styleNumber(runningTag, 'left')).toBe(viewportWidth - tagWidth - TAG_EDGE_MARGIN_PX)
    expect(styleNumber(runningTag, 'left') + tagWidth).toBeLessThanOrEqual(
      viewportWidth - TAG_EDGE_MARGIN_PX,
    )

    // The completed bar ends inside the viewport, so its tag stays on the
    // bar's own right edge.
    const doneBar = barFor(target, 'done')
    const doneWidth = styleNumber(doneBar, 'width')
    expect(doneWidth).toBeLessThan(viewportWidth)
    const doneTag = doneBar.querySelector('.bar-tag') as HTMLElement
    expect(styleNumber(doneTag, 'left')).toBe(doneWidth - tagWidth - TAG_EDGE_MARGIN_PX)
  })

  it('draws no bar text when the roles are unbound', () => {
    const { target } = renderTracked({ timeline: { ...config, labels: {} } })
    expect(target.querySelector('.bar-tag')).toBeNull()
    expect(target.querySelector('.bar-caption')).toBeNull()
  })

  it('renders one marker pin and guide line per distinct marker value', () => {
    const { target } = renderTracked()
    expect(target.querySelectorAll('.marker-pin')).toHaveLength(2)
    expect(target.querySelectorAll('.marker-line')).toHaveLength(2)
    expect(target.querySelector('.marker-pin')?.textContent?.trim()).toBe('0:41')
  })

  it('renders no marker rail when the marker role is unbound', () => {
    const { target } = renderTracked({
      timeline: { ...config, labels: { ...config.labels, marker: undefined } },
    })
    expect(target.querySelector('.tl-markers')).toBeNull()
    expect(target.querySelector('.marker-line')).toBeNull()
  })

  it('shows the hovered marker values in the hover strip', () => {
    const { target } = renderTracked()
    const pin = target.querySelector('.marker-pin') as HTMLElement
    pin.dispatchEvent(new Event('mouseenter'))
    flushSync()
    expect((target.querySelector('.tl-hover') as HTMLElement).textContent).toContain('marker:')
    expect((target.querySelector('.tl-hover') as HTMLElement).textContent).toContain('0:41')
  })

  it('clears the hovered marker when the cursor leaves the rail', () => {
    const { target } = renderTracked()
    ;(target.querySelector('.marker-pin') as HTMLElement).dispatchEvent(new Event('mouseenter'))
    flushSync()
    ;(target.querySelector('.tl-markers') as HTMLElement).dispatchEvent(new Event('mouseleave'))
    flushSync()
    expect((target.querySelector('.tl-hover') as HTMLElement).textContent).toContain(
      'hover over a task bar',
    )
  })

  it('clears the hovered marker when its pin leaves the rendered set', () => {
    // Unbinding the marker role drops every pin without any mouseleave ever
    // firing — the same shape as a pin culled away under the cursor.
    const { target } = renderTracked()
    ;(target.querySelector('.marker-pin') as HTMLElement).dispatchEvent(new Event('mouseenter'))
    flushSync()
    expect((target.querySelector('.tl-hover') as HTMLElement).textContent).toContain('marker:')
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const select = target.querySelector('select[aria-label="marker label"]') as HTMLSelectElement
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()

    expect(target.querySelector('.marker-pin')).toBeNull()
    expect((target.querySelector('.tl-hover') as HTMLElement).textContent).not.toContain('marker:')
  })

  it('marks no bar while both toolbar inputs are empty', () => {
    const { target } = renderTracked()
    expect(target.querySelector('a.bar.emph')).toBeNull()
    expect(target.querySelector('a.bar.dim')).toBeNull()
  })

  it('emphasizes bars over the highlight threshold and dims the rest', () => {
    const { target } = renderTracked()
    const input = target.querySelector('.role-num') as HTMLInputElement
    input.value = '100'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(barFor(target, 'big').classList.contains('emph')).toBe(true)
    expect(barFor(target, 'empty').classList.contains('dim')).toBe(true)
  })

  it('requires every active input to pass', () => {
    const { target } = renderTracked()
    const num = target.querySelector('.role-num') as HTMLInputElement
    num.value = '100'
    num.dispatchEvent(new Event('input', { bubbles: true }))
    const text = target.querySelector('.role-text') as HTMLInputElement
    // Case-insensitive substring, and 'big' is in module 'importer' — it
    // clears the threshold but fails the filter, so nothing is emphasized.
    text.value = 'VENDOR'
    text.dispatchEvent(new Event('input', { bubbles: true }))
    flushSync()
    expect(barFor(target, 'big').classList.contains('dim')).toBe(true)
    expect(barFor(target, 'empty').classList.contains('dim')).toBe(true)
  })

  it('hides a role input whose role is unbound', () => {
    const { target } = renderTracked({
      timeline: { ...config, labels: { ...config.labels, highlight: undefined } },
    })
    expect(target.querySelector('.role-num')).toBeNull()
    expect(target.querySelector('.role-text')).not.toBeNull()
  })

  it('applies a role override from the popover immediately and persists it', () => {
    const { target } = renderTracked()
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()

    const select = target.querySelector('select[aria-label="caption label"]') as HTMLSelectElement
    expect([...select.options].some((o) => o.textContent === 'file_name (default)')).toBe(true)
    select.value = 'module'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()

    expect(barFor(target, 'big').querySelector('.bar-caption')?.textContent).toBe('importer')
    expect(JSON.parse(localStorage.getItem('dk.timeline.roles.worker-a') ?? '{}')).toEqual({
      caption: 'module',
    })
    // The override is flagged on the gear and on its own row.
    expect(target.querySelectorAll('.dot').length).toBeGreaterThanOrEqual(2)
  })

  it('disables a role through the (none) option and restores it with Reset', () => {
    const { target } = renderTracked()
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()

    const select = target.querySelector('select[aria-label="tag label"]') as HTMLSelectElement
    select.value = ''
    select.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(target.querySelector('.bar-tag')).toBeNull()

    const row = select.closest('.role-row') as HTMLElement
    ;(row.querySelector('button') as HTMLButtonElement).click()
    flushSync()
    expect(target.querySelector('.bar-tag')?.textContent).toBe('12.4K')
  })

  it('clears every override with Reset all', () => {
    localStorage.setItem(
      'dk.timeline.roles.worker-a',
      JSON.stringify({ caption: 'module', tag: null }),
    )
    const { target } = renderTracked()
    expect(barFor(target, 'big').querySelector('.bar-caption')?.textContent).toBe('importer')

    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const resetAll = [...target.querySelectorAll('.role-pop-head button')].find((b) =>
      b.textContent?.includes('Reset all'),
    ) as HTMLButtonElement
    resetAll.click()
    flushSync()

    expect(barFor(target, 'big').querySelector('.bar-caption')?.textContent).toBe(
      'first_input_file.csv',
    )
    expect(localStorage.getItem('dk.timeline.roles.worker-a')).toBeNull()
  })

  it('links bars to the same-origin task route by default', () => {
    const { target } = renderTracked()
    expect(barFor(target, 'big').getAttribute('href')).toBe('/task/big')
  })

  it('links bars to the owning worker when taskUrlBase is set (cluster peers)', () => {
    const { target } = renderTracked({ taskUrlBase: 'http://worker-2:8080' })
    // Absolute http(s) hrefs fall through the router's link action, so the
    // click becomes a full navigation to the peer's own task page.
    expect(barFor(target, 'big').getAttribute('href')).toBe('http://worker-2:8080/task/big')
  })

  it('takes the window note and the stale cut from the configured depth', () => {
    const { target } = renderTracked({
      tasks: [...tasks, task('ancient', 25 * 60)],
      timeline: { ...config, max_age_minutes: 20 },
    })
    expect((target.querySelector('.tl-note') as HTMLElement).textContent).toContain('last 20 min')
    // 25 minutes old, outside a 20-minute window: cut, not drawn.
    expect(target.querySelector('a.bar[aria-label="ancient"]')).toBeNull()
    expect(target.querySelector('a.bar[aria-label="big"]')).not.toBeNull()
  })
})

describe('throughput track', () => {
  const win = (v: number) => ({ throughput: v, task_rate: 1.5, tasks: 9 })
  const sample = (offset: number, value: number) => ({
    ts: NOW - offset,
    windows: {
      '1': win(value),
      '5': win(value),
      '30': win(value),
    },
  })
  const openGear = (target: HTMLElement) => {
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
  }

  it('hides the track and the window switcher without samples', () => {
    const { target } = render({ tasks: [task('t-1', 60)] })
    expect(target.querySelector('.tl-throughput')).toBeNull()
    openGear(target)
    expect(target.querySelector('.tp-controls')).toBeNull()
  })

  it('keeps the window switcher out of the toolbar until the gear opens', () => {
    const { target } = render({
      tasks: [task('t-1', 60)],
      throughput: [sample(10, 30_000_000), sample(5, 41_250_000)],
    })

    expect(target.querySelector('.tl-throughput polyline')).not.toBeNull()
    expect(target.querySelector('.tp-controls')).toBeNull()

    openGear(target)
    const chips = [...target.querySelectorAll('.tp-chip')].map((c) => c.textContent)
    expect(chips).toEqual(['1s', '5s', '30s'])
    expect(target.querySelector('.tp-now')?.textContent).toContain('41.3M/s')
    expect(target.querySelector('.tp-now')?.textContent).toContain('1.5 t/s')
  })

  it('draws the 5 s window by default and switches via the chips', () => {
    const mixed = {
      ts: NOW - 5,
      windows: {
        '1': win(1_000_000),
        '5': win(5_000_000),
        '30': win(1_000_000),
      },
    }
    const { target } = render({ tasks: [task('t-1', 60)], throughput: [mixed] })
    openGear(target)
    expect(target.querySelector('.tp-now')?.textContent).toContain('5.0M/s') // default 5s

    const chip = [...target.querySelectorAll('.tp-chip')].find((c) => c.textContent === '30s')
    ;(chip as HTMLButtonElement).click()
    flushSync()

    expect(target.querySelector('.tp-now')?.textContent).toContain('1.0M/s')
  })

  it('shows per-task speed in the bar hover detail', () => {
    const { target } = render({
      tasks: [task('t-speedy', 60, { speed: 4_194_304, cost: 8_388_608 })],
    })
    const bar = barFor(target, 't-speedy')
    bar.dispatchEvent(new MouseEvent('mouseenter'))
    flushSync()

    expect(target.querySelector('.tl-hover')?.textContent).toContain('Speed:')
    expect(target.querySelector('.tl-hover')?.textContent).toContain('4.2M/s')
  })
})

describe('custom timeline events', () => {
  it('draws a marker line for a custom event at its geometry position with the decl color', () => {
    const decl = eventDecl('deploy', { kind: 'marker', color: '#7c3aed' })
    const ev = eventInstance('deploy', tasks[0].start_ts, { text: 'v2 deployed' })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const line = target.querySelector('.tl-event-line') as HTMLElement
    expect(line).not.toBeNull()
    expect(styleNumber(line, 'left')).toBeCloseTo(styleNumber(barFor(target, 'big'), 'left'), 5)
    expect(line.getAttribute('style')).toContain('#7c3aed')
  })

  it('draws a translucent range band spanning its geometry', () => {
    const decl = eventDecl('maintenance', { kind: 'range', color: '#f59e0b' })
    const ev = eventInstance('maintenance', tasks[0].start_ts, { endTs: tasks[1].start_ts })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const band = target.querySelector('.tl-event-band') as HTMLElement
    expect(band).not.toBeNull()
    const expectedWidth =
      styleNumber(barFor(target, 'empty'), 'left') - styleNumber(barFor(target, 'big'), 'left')
    expect(styleNumber(band, 'left')).toBeCloseTo(styleNumber(barFor(target, 'big'), 'left'), 5)
    expect(styleNumber(band, 'width')).toBeCloseTo(expectedWidth, 5)
    expect(band.getAttribute('style')).toContain('#f59e0b')
  })

  it('silently skips an event instance whose type has no declaration', () => {
    const decl = eventDecl('deploy')
    const ev = eventInstance('unknown_type', tasks[0].start_ts)
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    expect(target.querySelector('.tl-event-line')).toBeNull()
    expect(target.querySelector('.event-chip')).toBeNull()
  })

  it('hides a show:false declared event until enabled via the gear checkbox', () => {
    const decl = eventDecl('deploy', { show: false })
    const ev = eventInstance('deploy', tasks[0].start_ts)
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })
    expect(target.querySelector('.event-chip')).toBeNull()

    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const checkbox = target.querySelector(
      'input[type="checkbox"][aria-label="Show deploy timeline events"]',
    ) as HTMLInputElement
    expect(checkbox).not.toBeNull()
    expect(checkbox.checked).toBe(false)
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()

    expect(target.querySelector('.event-chip')).not.toBeNull()
    expect(JSON.parse(localStorage.getItem('dk.timeline.events.worker-a') ?? '{}')).toEqual({
      deploy: true,
    })
  })

  it('renders a link-action chip as an anchor with the resolved href', () => {
    const decl = eventDecl('deploy', {
      action: 'link',
      link: 'https://grafana.example/d/deploys?ts={ts_ms}',
      label: 'deploy {text}',
    })
    const ev = eventInstance('deploy', tasks[0].start_ts, { text: 'v2.1' })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('a.event-chip') as HTMLAnchorElement
    expect(chip).not.toBeNull()
    expect(chip.getAttribute('target')).toBe('_blank')
    expect(chip.getAttribute('rel')).toBe('noopener')
    expect(chip.textContent).toBe('deploy v2.1')
    expect(chip.getAttribute('href')).toBe(
      `https://grafana.example/d/deploys?ts=${Math.round(ev.ts * 1000)}`,
    )
  })

  // String.replace treats a string replacement's `$&`/`$1`/`$$`/... as
  // substitution patterns; a replacer FUNCTION does not, so handler text
  // containing one of those sequences must come through unmangled.
  it('inserts handler text with a $-sequence literally, not as a replace pattern', () => {
    const decl = eventDecl('deploy', { label: 'deploy {text}' })
    const ev = eventInstance('deploy', tasks[0].start_ts, { text: 'v2.1 ($&/$1/$$)' })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('.event-chip') as HTMLElement
    expect(chip).not.toBeNull()
    expect(chip.textContent).toBe('deploy v2.1 ($&/$1/$$)')
  })

  it('shows an unresolved-link note in the hover strip when action=link cannot resolve an href', () => {
    // {sha} is never supplied (no `values` on the instance, no matching
    // link_bases entry), so resolveEventLink returns null and the chip
    // renders as a plain button rather than an anchor.
    const decl = eventDecl('deploy', { action: 'link', link: 'https://ci.example/{sha}' })
    const ev = eventInstance('deploy', tasks[0].start_ts)
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('button.event-chip') as HTMLButtonElement
    expect(chip).not.toBeNull()
    chip.dispatchEvent(new Event('mouseenter'))
    flushSync()

    expect(target.querySelector('.tl-hover')?.textContent).toContain(
      'link unresolved — missing variable',
    )
  })

  it('emphasizes matching bars when a highlight chip is clicked, and clears on a second click', () => {
    const decl = eventDecl('slow_window', { kind: 'flag', action: 'highlight' })
    const match: EventMatch = { offsets: [[0, 5]] }
    const ev = eventInstance('slow_window', tasks[0].start_ts, { match })
    const matchingTask: TaskView = { ...tasks[1], source_offsets: [5] }
    const { target } = renderTracked({
      tasks: [tasks[0], matchingTask],
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('button.event-chip') as HTMLButtonElement
    expect(chip).not.toBeNull()
    chip.click()
    flushSync()
    expect(barFor(target, 'big').classList.contains('dim')).toBe(true)
    expect(barFor(target, 'empty').classList.contains('dim')).toBe(false)

    chip.click()
    flushSync()
    expect(barFor(target, 'big').classList.contains('dim')).toBe(false)
    expect(barFor(target, 'empty').classList.contains('dim')).toBe(false)
  })

  it('clears active highlight emphasis on Escape', () => {
    const decl = eventDecl('slow_window', { kind: 'flag', action: 'highlight' })
    const match: EventMatch = { offsets: [[0, 5]] }
    const ev = eventInstance('slow_window', tasks[0].start_ts, { match })
    const matchingTask: TaskView = { ...tasks[1], source_offsets: [5] }
    const { target } = renderTracked({
      tasks: [tasks[0], matchingTask],
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('button.event-chip') as HTMLButtonElement
    chip.click()
    flushSync()
    expect(barFor(target, 'big').classList.contains('dim')).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    flushSync()
    expect(barFor(target, 'big').classList.contains('dim')).toBe(false)
    expect(barFor(target, 'empty').classList.contains('dim')).toBe(false)
  })

  it('renders no event overlay when the config declares no events', () => {
    const { target } = renderTracked()
    expect(target.querySelector('.tl-events')).toBeNull()
    expect(target.querySelector('.tl-event-line')).toBeNull()
    expect(target.querySelector('.tl-event-band')).toBeNull()
  })
})
