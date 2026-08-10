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
import type { TimelineConfig } from '../../lib/types'
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

  it('renders the rule legend alongside the status entries', () => {
    const { target } = renderTracked()
    const legend = target.querySelector('.legend') as HTMLElement
    expect(legend.textContent).toContain('completed')
    expect(legend.textContent).toContain('empty output')
    // An unnamed rule falls back to generated condition text.
    expect(legend.textContent).toContain('file_size_bytes gt 10240')
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
