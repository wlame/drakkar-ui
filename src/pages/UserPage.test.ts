// Regression: two widgets sharing a title must still render both cards. The
// wire contract (UIPageWidget) has no unique id and does not guarantee
// title uniqueness within a page, so the {#each} must key on the array
// index, not widget.title — keying on title throws Svelte's duplicate-key
// error the moment two widgets share one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import UserPage from './UserPage.svelte'
import { loadUiPages } from '../lib/pages'
import { setLinkBases } from '../lib/enrich'
import type { TaskResult, UIPage } from '../lib/types'

const fetchMock = vi.fn()

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Lets a widget's async reload() (fetchWidgetRows/fetchStatValue, each behind
// an awaited fetch) resolve before assertions run — same drain loop
// RuntimeTab.test.ts uses for its own $effect-driven async reload.
async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

describe('UserPage widget list', () => {
  it('renders both cards when two widgets share a title', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Summary', view: 'stat', source: { kind: 'field' } },
        { title: 'Summary', view: 'table', source: { kind: 'field' } },
      ],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    flushSync()

    const widgets = target.querySelectorAll('.widget')
    expect(widgets).toHaveLength(2)
    expect([...widgets].map((w) => w.querySelector('h2')?.textContent)).toEqual([
      'Summary',
      'Summary',
    ])

    unmount(app)
    target.remove()
  })
})

describe('UserPage widget rendering', () => {
  it('renders a table widget with declared columns and a resolved link', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        {
          title: 'Recent tasks',
          view: 'table',
          source: { kind: 'tasks', limit: 50 },
          columns: [{ key: 'task_id', label: 'Task', link_template: '{tracing}/task/{value}' }],
        },
      ],
    }
    const taskRows: TaskResult[] = [
      {
        ts: 1,
        task_id: 't-42',
        partition: 0,
        source_offsets: null,
        hook_duration: null,
        exec_duration: 0.1,
        status: 'completed',
        exit_code: 0,
        output_message_count: 1,
      },
    ]
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/live/task-results')) return okJson(taskRows)
      return okJson([page])
    })
    setLinkBases({ tracing: 'https://tracing.example.com' })
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    const headers = [...target.querySelectorAll('th')].map((th) => th.textContent?.trim())
    expect(headers).toEqual(['Task'])

    const link = target.querySelector('a') as HTMLAnchorElement
    expect(link).not.toBeNull()
    expect(link.getAttribute('href')).toBe('https://tracing.example.com/task/t-42')
    expect(link.textContent).toBe('t-42')

    unmount(app)
    target.remove()
    setLinkBases({})
  })

  it('renders the unsupported-widget placeholder for an unknown view', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Trend', view: 'sparkline', source: { kind: 'tasks' } }],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    expect(target.textContent).toContain(
      "This widget needs a newer UI (unsupported view 'sparkline').",
    )

    unmount(app)
    target.remove()
  })

  it('names the source kind, not the view, when the view is known but the source is not', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [{ title: 'Mystery', view: 'table', source: { kind: 'crystal-ball' } }],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    await settled()

    expect(target.textContent).toContain(
      "This widget needs a newer UI (unsupported source 'crystal-ball').",
    )
    expect(target.textContent).not.toContain("unsupported view 'table'")

    unmount(app)
    target.remove()
  })
})
