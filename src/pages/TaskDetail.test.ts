// Docs anchors on the task's label chips (contract v1.22): a chip whose label
// key — or whose exact key=value pair — an operator bound to a docs page
// carries the book icon; every other chip renders as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import TaskDetail from './TaskDetail.svelte'
import { openDocsAnchor, setDocsConfig } from '../lib/docsAnchors'
import type { EventRow } from '../lib/types'

function startedRow(labels: Record<string, string>): EventRow {
  return {
    id: 1,
    ts: 1_770_000_000,
    dt: '2026-02-02T00:00:00.000000Z',
    event: 'task_started',
    partition: 0,
    offset: 7,
    task_id: 'task-1',
    args: '--in file',
    stdout_size: 0,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: null,
    output_topic: null,
    metadata: null,
    pid: 4242,
    labels: JSON.stringify(labels),
    origin: 'kafka',
    client_name: null,
    request_id: null,
  }
}

const fetchMock = vi.fn()

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

// The page loads its task in an onMount-triggered promise; drain the
// microtask queue before asserting on the rendered chips.
async function renderTracked(labels: Record<string, string>) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ events: [startedRow(labels)] }),
    text: async () => '',
  } as unknown as Response)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(TaskDetail, { target, props: { params: { id: 'task-1' } } })
  mounted.push({ target, component })
  for (let i = 0; i < 3; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
  return target
}

function chipFor(target: HTMLElement, text: string): HTMLElement {
  const chip = [...target.querySelectorAll('.chip.teal')].find((c) =>
    (c.textContent ?? '').startsWith(text),
  )
  expect(chip).toBeDefined()
  return chip as HTMLElement
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  vi.unstubAllGlobals()
  setDocsConfig(null)
  openDocsAnchor.set(null)
})

describe('TaskDetail label docs anchors', () => {
  it('renders plain chips without a docs config', async () => {
    const target = await renderTracked({ module: 'ingest', file_size: '12K' })
    expect(target.querySelectorAll('.chip.teal')).toHaveLength(2)
    expect(target.querySelectorAll('.chip.teal .docs-icon')).toHaveLength(0)
  })

  it('marks only the chips whose label key is anchored', async () => {
    setDocsConfig({
      title: 'Operator handbook',
      anchors: [{ match: { label: 'module' }, path: 'labels/module.html', title: 'Modules' }],
    })
    const target = await renderTracked({ module: 'ingest', file_size: '12K' })
    expect(target.querySelectorAll('.chip.teal .docs-icon')).toHaveLength(1)
    expect(chipFor(target, 'module=').querySelector('.docs-icon')).not.toBeNull()
  })

  it('prefers the value-narrowed anchor and opens it from the chip', async () => {
    const wide = { match: { label: 'module' }, path: 'labels/module.html' }
    const narrow = { match: { label: 'module', value: 'ingest' }, path: 'labels/ingest.html' }
    setDocsConfig({ title: 'Operator handbook', anchors: [narrow, wide] })
    const target = await renderTracked({ module: 'ingest', other_module: 'x' })
    const icon = chipFor(target, 'module=').querySelector('.docs-icon') as HTMLButtonElement
    icon.click()
    flushSync()
    expect(get(openDocsAnchor)).toEqual(narrow)
  })
})
