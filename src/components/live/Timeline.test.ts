// Mounts the real timeline against a ui.timeline config: rule-driven bar
// colors, bar tag/caption text, marker pins and lines, the rule legend, the
// highlight/filter emphasis, and the role-override popover.
//
// `paused` is set on every mount so neither the 250ms `now` tick nor the
// auto-follow rAF loop runs — the geometry under test is static then, and the
// tests stay deterministic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import Timeline from './Timeline.svelte'
import type { TaskView } from '../../lib/live'
import type { TimelineConfig, TimelineEventDecl } from '../../lib/types'
import type { EventMatch, TimelineEventView } from '../../lib/timelineEvents'
import { tagBoxWidth, TAG_EDGE_MARGIN_PX } from '../../lib/timeline'
import { openDocsAnchor, setDocsConfig } from '../../lib/docsAnchors'
import { identity } from '../../lib/config'
import { fmtTimeMs } from '../../lib/format'

// A fixed synthetic epoch (seconds), pinned onto the clock in beforeEach —
// deliberately NOT Date.now(). Every fixture timestamp below is expressed
// relative to NOW, while the component derives its own pixel origin from the
// clock at mount time (originTs = now - maxAge). Under a real clock those two
// drift apart by however long the file takes to reach a given test, and the
// drift is worth 16px/sec at the default zoom — enough to slide a chip across
// a cull boundary and fail the pixel-exact scroll assertions under load.
const NOW = 1_770_000_000

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
    run_started_at: null,
    reported_run_seconds: null,
    exit_notice_ms: null,
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
  // Only Date is faked: timers and requestAnimationFrame stay real, because
  // measureViewport() awaits a real rAF frame and the component coalesces its
  // scroll sync on one.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW * 1000)
  localStorage.clear()
})

afterEach(async () => {
  for (const { target, component } of mounted.splice(0)) {
    await unmount(component)
    target.remove()
  }
  vi.useRealTimers()
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

  it('draws a v1.29 bar from run_started_at and duration, not from the completion ts', () => {
    // Completion ts 20s after start, but the process ran 5s: a stalled loop.
    const stalled = task('stalled', 60, { duration: 5, run_started_at: NOW - 60 })
    const plain = task('plain', 60, { slot: 1 })
    const { target } = renderTracked({ tasks: [stalled, plain] })
    const stalledBar = barFor(target, 'stalled')
    const plainBar = barFor(target, 'plain')
    expect(styleNumber(stalledBar, 'left')).toBeCloseTo(styleNumber(plainBar, 'left'))
    // Same start, a quarter of the width: 5s against 20s.
    expect(styleNumber(stalledBar, 'width') * 4).toBeCloseTo(styleNumber(plainBar, 'width'))
  })

  it('draws the reported run time and names both times in the hover', () => {
    const reported = task('reported', 60, {
      duration: 8,
      run_started_at: NOW - 60,
      reported_run_seconds: 2,
      exit_notice_ms: 300,
    })
    const plain = task('plain', 60, { slot: 1 })
    const { target } = renderTracked({ tasks: [reported, plain] })
    const bar = barFor(target, 'reported')
    expect(styleNumber(bar, 'width') * 10).toBeCloseTo(
      styleNumber(barFor(target, 'plain'), 'width'),
    )
    bar.dispatchEvent(new Event('mouseenter'))
    flushSync()
    const hover = (target.querySelector('.tl-hover') as HTMLElement).textContent ?? ''
    expect(hover).toContain('reported 2.000s, process 8.000s')
    expect(hover).toContain('worker noticed the exit 300 ms late')
  })

  it('shows the drawn bar edges as Start and End in the hover', () => {
    // Completion ts 20s after start; the process ran 5s.
    const stalled = task('stalled', 60, { duration: 5, run_started_at: NOW - 60 })
    const { target } = renderTracked({ tasks: [stalled] })
    barFor(target, 'stalled').dispatchEvent(new Event('mouseenter'))
    flushSync()
    const hover = (target.querySelector('.tl-hover') as HTMLElement).textContent ?? ''
    expect(hover).toContain(fmtTimeMs(NOW - 55))
    expect(hover).not.toContain(fmtTimeMs(NOW - 40))
  })

  it('shows the size alone when the backend sent no line count', () => {
    // stdin_lines/stdout_lines are WS-only fields the backend computes only
    // while a client is connected, and /recent-tasks never carries them.
    // Null must render as the byte size, not as "0 lines".
    const { target } = renderTracked({
      tasks: [
        task('t-null-lines', -3, {
          status: 'completed',
          stdin_size: 4096,
          stdin_lines: null,
          stdout_size: 2048,
          stdout_lines: null,
        }),
      ],
    })
    barFor(target, 't-null-lines').dispatchEvent(new Event('mouseenter'))
    flushSync()
    const hover = (target.querySelector('.tl-hover') as HTMLElement).textContent ?? ''
    expect(hover).not.toContain('0 lines')
    expect(hover).toContain('4.0 KB')
    expect(hover).toContain('2.0 KB')
  })

  it('shows the line count when the backend sent one', () => {
    const { target } = renderTracked({
      tasks: [
        task('t-counted-lines', -3, {
          status: 'completed',
          stdin_size: 4096,
          stdin_lines: 12,
          stdout_size: 2048,
          stdout_lines: 7,
        }),
      ],
    })
    barFor(target, 't-counted-lines').dispatchEvent(new Event('mouseenter'))
    flushSync()
    const hover = (target.querySelector('.tl-hover') as HTMLElement).textContent ?? ''
    expect(hover).toContain('12 lines')
    expect(hover).toContain('7 lines')
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

describe('memory window note', () => {
  afterEach(() => identity.set(null))

  const title = (target: HTMLElement) => target.querySelector('.tl-note')?.textContent ?? ''

  it('says the window is in memory when the recorder is off', () => {
    identity.set({
      worker_id: 'w',
      cluster: null,
      config_summary: '',
      capabilities: {
        recorder: { enabled: false, provider: 'none', history_search: false },
        memory: { enabled: true, window_seconds: 120, max_rows: 12000 },
      },
    })
    const { target } = renderTracked()
    expect(title(target)).toContain('last 2 minutes, in memory')
    expect(title(target)).not.toContain('last 30 min')
  })

  it('keeps the configured depth when the recorder runs or capabilities are missing', () => {
    expect(title(renderTracked().target)).toContain('last 30 min')
    identity.set({
      worker_id: 'w',
      cluster: null,
      config_summary: '',
      capabilities: { recorder: { enabled: true } },
    })
    expect(title(renderTracked().target)).toContain('last 30 min')
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

  // Label resolution order with no declared template: the per-type track's
  // own left-side label already names the type (see .track-label), so a
  // bare chip repeating the type name buries the one thing that actually
  // varies per instance. The type name is only the last resort, for an
  // instance with no text of its own.
  it('shows the instance text on the chip when no label template is configured', () => {
    const decl = eventDecl('deploy') // no `label`
    const ev = eventInstance('deploy', tasks[0].start_ts, { text: 'v2.1 rollout' })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('.event-chip') as HTMLElement
    expect(chip.textContent).toBe('v2.1 rollout')
  })

  it('falls back to the type name when there is no label template AND no instance text', () => {
    const decl = eventDecl('deploy') // no `label`
    const ev = eventInstance('deploy', tasks[0].start_ts) // text: '' by default
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('.event-chip') as HTMLElement
    expect(chip.textContent).toBe('deploy')
  })

  it('still prefers a configured label template over the instance text', () => {
    const decl = eventDecl('deploy', { label: 'deploy {text}' })
    const ev = eventInstance('deploy', tasks[0].start_ts, { text: 'v2.1' })
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })

    const chip = target.querySelector('.event-chip') as HTMLElement
    expect(chip.textContent).toBe('deploy v2.1')
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

describe('per-type event tracks', () => {
  const trackFor = (target: HTMLElement, name: string) =>
    target.querySelector(`.event-track[aria-label="${name} timeline events"]`)

  it('renders one track per type that is visible and has an instance in the buffer, in declaration order', () => {
    const deployDecl = eventDecl('deploy')
    const ghostDecl = eventDecl('ghost') // declared, but no instance below — no track
    const ev = eventInstance('deploy', tasks[0].start_ts)
    const { target } = renderTracked({
      timeline: { ...config, events: [deployDecl, ghostDecl] },
      events: [ev],
    })

    expect(trackFor(target, 'deploy')).not.toBeNull()
    expect(trackFor(target, 'ghost')).toBeNull()
    expect(trackFor(target, 'deploy')?.querySelector('.track-label')?.textContent).toBe('deploy')
  })

  it('drops a track when its type is hidden via the gear, and restores it when re-enabled', () => {
    const decl = eventDecl('deploy')
    const ev = eventInstance('deploy', tasks[0].start_ts)
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: [ev],
    })
    expect(trackFor(target, 'deploy')).not.toBeNull()

    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const checkbox = target.querySelector(
      'input[type="checkbox"][aria-label="Show deploy timeline events"]',
    ) as HTMLInputElement
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(trackFor(target, 'deploy')).toBeNull()

    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
    expect(trackFor(target, 'deploy')).not.toBeNull()
  })

  it('collapses a dense same-type burst into one "+N" cluster glyph', () => {
    const decl = eventDecl('deploy')
    const base = tasks[0].start_ts
    // 0.2s apart at the default 16px/sec (8 * zoom 2) is 3.2px — well inside
    // the 12px collapse distance from the first (anchor) member.
    const evs = [
      eventInstance('deploy', base, { text: 'a' }),
      eventInstance('deploy', base + 0.2, { text: 'b' }),
      eventInstance('deploy', base + 0.4, { text: 'c' }),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    const chips = target.querySelectorAll('.event-chip')
    expect(chips).toHaveLength(1)
    expect(chips[0].classList.contains('cluster')).toBe(true)
    expect(chips[0].textContent?.trim()).toBe('+3')
  })

  // Turns on the "Vertical labels" gear toggle — opt-in since it defaults
  // off (the automatic vertical stage read badly and surprised operators).
  function enableVerticalLabels(target: HTMLElement) {
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const checkbox = target.querySelector(
      'input[type="checkbox"][aria-label="Vertical labels"]',
    ) as HTMLInputElement
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change', { bubbles: true }))
    flushSync()
  }

  it('degrades a crowded label to a bare glyph by default, keeping the track at 16px', () => {
    const decl = eventDecl('maintenance_window_alert') // 24 chars — needs real room
    const base = tasks[0].start_ts
    const evs = [
      // No text on either instance: with no label template configured,
      // each chip's label falls back to the 24-char type name — still
      // needing real room, same as before text-first fallback existed.
      eventInstance('maintenance_window_alert', base),
      // +2.5s => 40px at 16px/sec: far enough not to cluster (>12px), but
      // nowhere near enough room for a 24-char label to fit before it.
      eventInstance('maintenance_window_alert', base + 2.5),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    const track = trackFor(target, 'maintenance_window_alert') as HTMLElement
    expect(track).not.toBeNull()
    // Vertical labels are off by default, so nothing pushes the track tall.
    expect(track.style.height).toBe('16px')

    const chips = track.querySelectorAll('.event-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].classList.contains('vertical')).toBe(false)
    expect(chips[0].classList.contains('glyph')).toBe(true)
    expect(chips[0].textContent?.trim()).toBe('')
    // The uncrowded second chip is unaffected either way.
    expect(chips[1].classList.contains('glyph')).toBe(false)
  })

  it('keeps a lone chip horizontal but switches a crowded one to trimmed vertical text once the gear toggle is on, growing the track', () => {
    const decl = eventDecl('maintenance_window_alert') // 24 chars — needs real room
    const base = tasks[0].start_ts
    const evs = [
      // No text on either instance: falls back to the 24-char type name.
      eventInstance('maintenance_window_alert', base),
      // +2.5s => 40px at 16px/sec: far enough not to cluster (>12px), but
      // nowhere near enough room for a 24-char label to fit before it.
      eventInstance('maintenance_window_alert', base + 2.5),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })
    enableVerticalLabels(target)

    const track = trackFor(target, 'maintenance_window_alert') as HTMLElement
    expect(track).not.toBeNull()
    expect(track.style.height).toBe('44px')

    const chips = track.querySelectorAll('.event-chip')
    expect(chips).toHaveLength(2)
    expect(chips[0].classList.contains('vertical')).toBe(true)
    // Trimmed to VERTICAL_LABEL_MAX_CHARS (6) with a trailing ellipsis.
    expect(chips[0].textContent).toBe('maint…')
    // The second chip has no further neighbor, so it stays horizontal even
    // though its own label ('maintenance_window_alert') is long too.
    expect(chips[1].classList.contains('vertical')).toBe(false)
  })

  // The density ladder (layoutTrack) trims whatever string resolveEventLabel
  // hands it — it has no idea whether that came from a template, instance
  // text, or the type-name fallback. Pins that down with a SHORT type name
  // (would trivially fit on its own) paired with LONG instance text (the
  // one that actually needs trimming) — the crowding, and the trim, must
  // track the text, not the type name.
  it('trims whichever resolved string is crowded, not just a long type name', () => {
    const decl = eventDecl('a') // 1 char — would never need vertical mode on its own
    const base = tasks[0].start_ts
    const evs = [
      eventInstance('a', base, { text: 'deployment-marker-event' }), // 24 chars
      // +2.5s => 40px at 16px/sec: not enough room for the 24-char text.
      eventInstance('a', base + 2.5, { text: 'y' }),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })
    enableVerticalLabels(target)

    const track = trackFor(target, 'a') as HTMLElement
    const chips = track.querySelectorAll('.event-chip')
    expect(chips[0].classList.contains('vertical')).toBe(true)
    expect(chips[0].textContent).toBe('deplo…')
  })

  it('persists the "Vertical labels" toggle across a remount', () => {
    const decl = eventDecl('maintenance_window_alert')
    const base = tasks[0].start_ts
    const evs = [
      eventInstance('maintenance_window_alert', base),
      eventInstance('maintenance_window_alert', base + 2.5),
    ]
    const { target: firstTarget } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })
    enableVerticalLabels(firstTarget)
    expect(JSON.parse(localStorage.getItem('dk.timeline.eventLabels.worker-a') ?? '{}')).toEqual({
      vertical: true,
    })

    // A fresh mount (e.g. navigating away and back) reads the same worker's
    // stored prefs, not the module-level default.
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })
    const track = trackFor(target, 'maintenance_window_alert') as HTMLElement
    expect(track.style.height).toBe('44px')
    expect(track.querySelector('.event-chip.vertical')).not.toBeNull()

    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
    const checkbox = target.querySelector(
      'input[type="checkbox"][aria-label="Vertical labels"]',
    ) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
  })

  it('shows cluster member details on hover and opens a popover listing members on click', () => {
    const decl = eventDecl('slow_window', { kind: 'flag', action: 'highlight', label: '{text}' })
    const base = tasks[0].start_ts
    const evs = [
      eventInstance('slow_window', base, { text: 'first', match: { offsets: [[0, 10]] } }),
      eventInstance('slow_window', base + 0.2, { text: 'second', match: { offsets: [[0, 20]] } }),
    ]
    const taskA: TaskView = { ...tasks[0], source_offsets: [10] }
    const taskB: TaskView = { ...tasks[1], source_offsets: [20] }
    const { target } = renderTracked({
      tasks: [taskA, taskB],
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    const cluster = target.querySelector('.event-chip.cluster') as HTMLButtonElement
    expect(cluster).not.toBeNull()
    cluster.dispatchEvent(new Event('mouseenter'))
    flushSync()
    const hover = target.querySelector('.tl-hover') as HTMLElement
    expect(hover.textContent).toContain('Members:')
    expect(hover.textContent).toContain('2')
    expect(hover.textContent).toContain('first')
    expect(hover.textContent).toContain('second')

    cluster.click()
    flushSync()
    const pop = target.querySelector('.event-cluster-pop') as HTMLElement
    expect(pop).not.toBeNull()
    const members = pop.querySelectorAll('.event-cluster-member')
    expect(members).toHaveLength(2)
    expect(members[0].textContent).toContain('first')
    expect(members[1].textContent).toContain('second')

    // Clicking a member fires its own highlight action and closes the popover.
    ;(members[0] as HTMLButtonElement).click()
    flushSync()
    expect(target.querySelector('.event-cluster-pop')).toBeNull()
    expect(barFor(target, taskA.task_id).classList.contains('dim')).toBe(false)
    expect(barFor(target, taskB.task_id).classList.contains('dim')).toBe(true)
  })

  it('closes the cluster popover on an outside click', () => {
    const decl = eventDecl('deploy')
    const base = tasks[0].start_ts
    const evs = [eventInstance('deploy', base), eventInstance('deploy', base + 0.2)]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    ;(target.querySelector('.event-chip.cluster') as HTMLButtonElement).click()
    flushSync()
    expect(target.querySelector('.event-cluster-pop')).not.toBeNull()

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    flushSync()
    expect(target.querySelector('.event-cluster-pop')).toBeNull()
  })

  it('keeps DOM identity and an open popover across a zoom change (identity key, not position)', () => {
    const decl = eventDecl('deploy')
    const base = tasks[0].start_ts
    // 0.05s apart: at both the default 16px/sec and the 32px/sec zoomed-in
    // rate the spread stays far inside the 12px collapse distance, so the
    // cluster's membership itself does not change across the zoom step —
    // only every chip's `left` position does.
    const evs = [
      eventInstance('deploy', base, { text: 'a' }),
      eventInstance('deploy', base + 0.05, { text: 'b' }),
      eventInstance('deploy', base + 0.1, { text: 'c' }),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    const wrapBefore = target.querySelector('.event-cluster-wrap') as HTMLElement
    const chipBefore = target.querySelector('.event-chip.cluster') as HTMLButtonElement
    const leftBefore = styleNumber(wrapBefore, 'left')
    chipBefore.click()
    flushSync()
    expect(target.querySelector('.event-cluster-pop')).not.toBeNull()

    const zoomInBtn = [...target.querySelectorAll('.tbtn.plusminus')].find(
      (b) => b.getAttribute('title') === 'Zoom in',
    ) as HTMLButtonElement
    zoomInBtn.click()
    flushSync()

    // Position moved (doubled pxPerSec)...
    const wrapAfter = target.querySelector('.event-cluster-wrap') as HTMLElement
    expect(styleNumber(wrapAfter, 'left')).toBeCloseTo(leftBefore * 2, 5)
    // ...but the element itself is the same node — an identity-derived key
    // means the keyed {#each} reused it rather than tearing it down and
    // rebuilding it, and the popover that was open on it is still open.
    expect(wrapAfter).toBe(wrapBefore)
    expect(target.querySelector('.event-chip.cluster')).toBe(chipBefore)
    expect(target.querySelector('.event-cluster-pop')).not.toBeNull()
    expect(target.querySelectorAll('.event-cluster-member')).toHaveLength(3)
  })

  it('shows a disabled, titled row for a cluster member whose link cannot resolve, instead of a silent no-op', () => {
    const decl = eventDecl('deploy', {
      action: 'link',
      link: 'https://ci.example/{sha}',
      label: '{text}',
    })
    const base = tasks[0].start_ts
    const evs = [
      eventInstance('deploy', base, { text: 'resolved', values: { sha: 'abc123' } }),
      eventInstance('deploy', base + 0.05, { text: 'unresolved' }), // no `sha` value
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })

    ;(target.querySelector('.event-chip.cluster') as HTMLButtonElement).click()
    flushSync()
    const members = [...target.querySelectorAll('.event-cluster-member')] as HTMLButtonElement[]
    expect(members).toHaveLength(2)

    const resolvedRow = members.find((m) => m.textContent?.includes('resolved'))!
    const unresolvedRow = members.find((m) => m.textContent?.includes('unresolved'))!
    expect(resolvedRow.classList.contains('unresolved')).toBe(false)
    expect(resolvedRow.disabled).toBe(false)
    expect(resolvedRow.title).toBe('')

    expect(unresolvedRow.classList.contains('unresolved')).toBe(true)
    expect(unresolvedRow.disabled).toBe(true)
    expect(unresolvedRow.title).toBe('link unresolved — missing variable')

    // Disabled elements don't dispatch click in the browser — the row is
    // truly inert, not just silently no-op-ing on an active click.
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    unresolvedRow.click()
    flushSync()
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('keeps a track height stable across scroll positions instead of resizing as its neighbor chip is culled', async () => {
    const decl = eventDecl('maintenance_window_alert') // 24 chars — needs real room
    const base = tasks[0].start_ts
    // Same spacing as the vertical-mode test above: 2.5s apart at 16px/sec
    // (40px) is far enough not to cluster, but not enough room for the first
    // chip's label to fit before the second — so with vertical labels on,
    // the first chip needs vertical mode and the track needs its tall
    // height, PROVIDED the layout decision is made from the type's whole
    // buffer rather than whatever the current scroll position happens to
    // leave in the culled render window.
    const evs = [
      // No text on either instance: falls back to the 24-char type name.
      eventInstance('maintenance_window_alert', base),
      eventInstance('maintenance_window_alert', base + 2.5),
    ]
    const { target } = renderTracked({
      timeline: { ...config, events: [decl] },
      events: evs,
    })
    enableVerticalLabels(target)

    // Both chips inside the culled render window: height 44px, 2 rendered.
    await measureViewport(target, 300, 27500)
    const track = trackFor(target, 'maintenance_window_alert') as HTMLElement
    expect(track.style.height).toBe('44px')
    expect(track.querySelectorAll('.event-chip')).toHaveLength(2)

    // Scroll far enough that the FIRST chip (the one that needs vertical
    // mode) falls outside CULL_MARGIN_PX and is dropped from what's
    // rendered — only the second chip is still in the DOM. The track's
    // height must not shrink back to 16px: the layout decision (this chip
    // needs vertical mode because of its neighbor) was made from the full
    // buffer, not from whichever chips the current scroll happens to render.
    await measureViewport(target, 300, 28260)
    const trackAfterScroll = trackFor(target, 'maintenance_window_alert') as HTMLElement
    expect(trackAfterScroll.style.height).toBe('44px')
    expect(trackAfterScroll.querySelectorAll('.event-chip')).toHaveLength(1)
  })

  // The wire format truncates an instance's ts to whole milliseconds and
  // stamps partition from the emitting hook's own Kafka partition (see
  // eventContentKey's doc comment in lib/timelineEvents.ts) — so two
  // genuinely different range instances of one type CAN legitimately share
  // type+ts+partition. Before the identity fix, the keyed {#each} over
  // eventRangeBands threw Svelte's each_key_duplicate on exactly this input,
  // which unmounts the component (this is the reported "task bars
  // disappear" — any subsequent re-render hit the same broken list).
  it('renders two distinct events that share type+ts+partition without throwing or losing the bars', () => {
    const decl = eventDecl('scan_window_processing_range', { kind: 'range', action: 'highlight' })
    const ts = tasks[0].start_ts
    const evs = [
      eventInstance('scan_window_processing_range', ts, {
        text: '3 tasks',
        endTs: ts + 1,
        partition: 11,
      }),
      eventInstance('scan_window_processing_range', ts, {
        text: '7 tasks',
        endTs: ts + 2,
        partition: 11,
      }),
    ]
    let target!: HTMLElement
    expect(() => {
      target = renderTracked({ timeline: { ...config, events: [decl] }, events: evs }).target
    }).not.toThrow()
    expect(barFor(target, 'big')).not.toBeNull()
    expect(barFor(target, 'empty')).not.toBeNull()
    expect(target.querySelectorAll('.tl-event-band')).toHaveLength(2)
  })

  // A separate case from the above: two BYTE-IDENTICAL instances (a genuine
  // ingestion-level duplicate, e.g. the same wire delivery recorded twice)
  // still collide on every content field, not just type+ts+partition — the
  // occurrence-index tiebreaker in withUniqueKeys is what keeps this one
  // from throwing, not the richer identity key alone.
  it('renders exact-duplicate event instances without throwing or losing the bars', () => {
    const decl = eventDecl('scan_window_processing_range', { kind: 'range', action: 'highlight' })
    const ts = tasks[0].start_ts
    const one = eventInstance('scan_window_processing_range', ts, {
      text: 'dup',
      endTs: ts + 1,
      partition: 11,
    })
    const evs = [one, { ...one }]
    let target!: HTMLElement
    expect(() => {
      target = renderTracked({ timeline: { ...config, events: [decl] }, events: evs }).target
    }).not.toThrow()
    expect(barFor(target, 'big')).not.toBeNull()
    expect(target.querySelectorAll('.tl-event-band')).toHaveLength(2)
  })
})

// Docs anchors (contract v1.22): an operator can bind a docs page to an event
// type, and the timeline then offers the book icon everywhere it names that
// type — the gear's per-type row and the hover strip's event detail.
describe('event-type docs anchors', () => {
  const deployAnchor = {
    match: { event: 'deploy' },
    path: 'events/deploy.html#reading-the-track',
    title: 'Deploy events',
  }

  afterEach(() => {
    setDocsConfig(null)
    openDocsAnchor.set(null)
  })

  function openGear(target: HTMLElement) {
    ;(target.querySelector('button.gear') as HTMLButtonElement).click()
    flushSync()
  }

  it('renders no docs icon in the gear list without a docs config', () => {
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    openGear(target)
    expect(target.querySelectorAll('.event-row .docs-icon')).toHaveLength(0)
  })

  it('renders the gear icon only for the anchored event type', () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy'), eventDecl('rollback')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    openGear(target)
    const icons = target.querySelectorAll('.event-row .docs-icon')
    expect(icons).toHaveLength(1)
    expect(icons[0].closest('.event-row')?.textContent).toContain('deploy')
    expect(icons[0].getAttribute('aria-label')).toBe('Deploy events')
  })

  it('publishes the anchor to the drawer store when the gear icon is clicked', () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    openGear(target)
    ;(target.querySelector('.event-row .docs-icon') as HTMLButtonElement).click()
    flushSync()
    expect(get(openDocsAnchor)).toEqual(deployAnchor)
  })

  it('offers the icon in the hover strip beside the hovered event type', () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    const chip = target.querySelector('.event-chip') as HTMLElement
    chip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    expect(target.querySelector('.tl-hover .docs-icon')).not.toBeNull()
  })

  // The grace period below is real time: the file fakes only Date, so the
  // component's setTimeout runs on the real clock.
  const GRACE_WAIT_MS = 300
  const waitOutGrace = () => new Promise((resolve) => setTimeout(resolve, GRACE_WAIT_MS))

  // The first chip on one type's track — the tracks render in declaration
  // order, so a bare '.event-chip' query would always return the first type's.
  function chipIn(target: HTMLElement, typeName: string) {
    const chip = target.querySelector(
      `.event-track[aria-label="${typeName} timeline events"] .event-chip`,
    )
    expect(chip).not.toBeNull()
    return chip as HTMLElement
  }

  function hoverChip(target: HTMLElement) {
    const chip = target.querySelector('.event-chip') as HTMLElement
    chip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    return { chip, strip: target.querySelector('.tl-hover') as HTMLElement }
  }

  it('keeps the hovered event alive while the pointer travels onto the strip', async () => {
    // Without the grace period the chip's own mouseleave would clear the
    // detail — and destroy the icon — before the pointer could reach it.
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    const { chip, strip } = hoverChip(target)
    chip.dispatchEvent(new Event('mouseleave'))
    strip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    await waitOutGrace()
    flushSync()

    const icon = strip.querySelector('.docs-icon') as HTMLButtonElement
    expect(icon).not.toBeNull()
    icon.click()
    flushSync()
    expect(get(openDocsAnchor)).toEqual(deployAnchor)
  })

  it('clears the event detail once the pointer leaves both the chip and the strip', async () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    const { chip, strip } = hoverChip(target)
    chip.dispatchEvent(new Event('mouseleave'))
    strip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    strip.dispatchEvent(new Event('mouseleave'))
    flushSync()

    expect(strip.querySelector('.docs-icon')).toBeNull()
    expect(strip.textContent).toContain('hover over a task bar to see details')
  })

  it('clears the event detail after the grace period when the strip is never entered', async () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    const { chip, strip } = hoverChip(target)
    chip.dispatchEvent(new Event('mouseleave'))
    flushSync()
    await waitOutGrace()
    flushSync()

    expect(strip.querySelector('.docs-icon')).toBeNull()
    expect(strip.textContent).toContain('hover over a task bar to see details')
  })

  it('hands the hover over to the next chip instead of letting the older timer fire', async () => {
    // The leaving chip schedules a clear and the entering one must cancel it,
    // or the handoff would blank the strip mid-hover.
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy'), eventDecl('rollback')] },
      events: [
        eventInstance('deploy', tasks[0].start_ts),
        eventInstance('rollback', tasks[0].start_ts),
      ],
    })
    const deployChip = chipIn(target, 'deploy')
    const rollbackChip = chipIn(target, 'rollback')
    const strip = target.querySelector('.tl-hover') as HTMLElement

    deployChip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    deployChip.dispatchEvent(new Event('mouseleave'))
    rollbackChip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    await waitOutGrace()
    flushSync()

    expect(strip.textContent).toContain('rollback')
    expect(strip.querySelector('.docs-icon')).toBeNull()
  })

  it('drops a pending event hover the moment a cluster glyph takes the pointer', () => {
    // The strip prefers hoveredEvent over hoveredCluster, so a cluster that
    // left the pending clear running would show the previous chip's detail
    // for the whole grace period.
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const base = tasks[0].start_ts
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy'), eventDecl('rollback')] },
      events: [
        eventInstance('deploy', base),
        // 0.2s apart collapses into one "+3" cluster glyph.
        eventInstance('rollback', base, { text: 'a' }),
        eventInstance('rollback', base + 0.2, { text: 'b' }),
        eventInstance('rollback', base + 0.4, { text: 'c' }),
      ],
    })
    const deployChip = chipIn(target, 'deploy')
    const cluster = chipIn(target, 'rollback')
    expect(cluster.classList.contains('cluster')).toBe(true)
    const strip = target.querySelector('.tl-hover') as HTMLElement

    deployChip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    deployChip.dispatchEvent(new Event('mouseleave'))
    cluster.dispatchEvent(new Event('mouseenter'))
    flushSync()

    expect(strip.textContent).toContain('Members:')
    expect(strip.textContent).not.toContain('deploy')
    expect(strip.querySelector('.docs-icon')).toBeNull()
  })

  it('trails the type name in the gear row rather than wrapping below it', () => {
    // Layout, asserted structurally: the icon is a sibling of the visibility
    // label inside one flex row, not a child of it (a click inside the label
    // would toggle the checkbox) and not a row of its own.
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('deploy')] },
      events: [eventInstance('deploy', tasks[0].start_ts)],
    })
    openGear(target)
    const icon = target.querySelector('.event-row .docs-icon') as HTMLElement
    expect(icon.parentElement?.classList.contains('event-row')).toBe(true)
    expect(icon.previousElementSibling?.classList.contains('event-check')).toBe(true)
    expect(icon.closest('label')).toBeNull()
  })

  it('leaves the hover strip plain for an event type with no anchor', () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [deployAnchor] })
    const { target } = renderTracked({
      timeline: { ...config, events: [eventDecl('rollback')] },
      events: [eventInstance('rollback', tasks[0].start_ts)],
    })
    const chip = target.querySelector('.event-chip') as HTMLElement
    chip.dispatchEvent(new Event('mouseenter'))
    flushSync()
    expect(target.querySelector('.tl-hover')?.textContent).toContain('rollback')
    expect(target.querySelector('.tl-hover .docs-icon')).toBeNull()
  })
})
