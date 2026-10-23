// The Slice view inside the Databases tab: links for the own worker and a
// peer, the whole-cluster rules, validation, and the state of a worker that
// has no slice route.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatabasesTab from '../DatabasesTab.svelte'
import { setQuery } from '../../../lib/router'
import type { DatabasesResponse, RecorderStatus } from '../../../lib/types'

const recorder = (provider: RecorderStatus['provider']): RecorderStatus => ({
  enabled: provider !== 'none',
  provider,
  memory: { window_seconds: 120, max_rows: 1000, max_bytes: 1000 },
  sqlite: null,
  postgres: null,
})

function answer(provider: RecorderStatus['provider'] | null): DatabasesResponse {
  return {
    own: [
      {
        filename: 'w-1-live.db',
        worker_name: 'w-1',
        cluster_name: 'search',
        kind: 'live',
        event_count: 1,
        event_counts: {},
        first_event_ts: 1760432400,
        last_event_ts: 1760432460,
        size_bytes: 1,
      },
    ],
    history: { folders: [] },
    ...(provider ? { recorder: recorder(provider) } : {}),
  }
}

const workers = ['w-1', 'w-2'].map((name, i) => ({
  worker_name: name,
  cluster: 'search',
  url: `http://${name}:8080/`,
  is_current: i === 0,
  online: true,
}))

interface Stub {
  provider?: RecorderStatus['provider'] | null
  /** What the own worker answers to the slice probe. */
  sliceStatus?: number
  /** Whether the peer's databases answer has a recorder block. */
  peerHasRecorder?: boolean
}

function stub({ provider = 'sqlite', sliceStatus = 400, peerHasRecorder = true }: Stub = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/v1/workers')) return new Response(JSON.stringify(workers))
    if (url.includes('/debug/slice')) return new Response('{"error":"x"}', { status: sliceStatus })
    if (url.includes('/debug/databases')) {
      const body = answer(url.startsWith('http://w-2') && !peerHasRecorder ? null : provider)
      return new Response(JSON.stringify(body))
    }
    return new Response('[]')
  })
}

async function settled() {
  for (let i = 0; i < 5; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

async function open(query: string, fetchMock: ReturnType<typeof stub>) {
  setQuery(query, { replace: true })
  vi.stubGlobal('fetch', fetchMock)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DatabasesTab, { target })
  await settled()
  return { target, close: () => (unmount(app), target.remove()) }
}

const links = (target: HTMLElement) =>
  [...target.querySelectorAll<HTMLAnchorElement>('.links a')].map((a) => [
    a.textContent?.trim(),
    a.getAttribute('href'),
  ])

describe('Slice view', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setQuery('', { replace: true })
    localStorage.clear()
  })

  it('links the own worker to its own slice route with the filters from the URL', async () => {
    const { target, close } = await open(
      'db_view=slice&db_from=1760430000&db_to=1760431000&db_types=task_failed',
      stub(),
    )
    expect(links(target)).toEqual([
      [
        'Download: w-1',
        '/api/v1/debug/slice?from=1760430000&to=1760431000&scope=worker&events=task_failed',
      ],
    ])
    expect(target.textContent).toContain('At most 200,000 rows')
    close()
  })

  it('links a picked peer to the peer origin', async () => {
    const { target, close } = await open('db_view=slice&db_worker=w-2&db_from=10&db_to=20', stub())
    expect(links(target)[0][1]).toBe(
      'http://w-2:8080/api/v1/debug/slice?from=10&to=20&scope=worker',
    )
    close()
  })

  it('lists the unsealed parts first and the cluster file last for sqlite', async () => {
    const { target, close } = await open(
      'db_view=slice&db_scope=cluster&db_from=10&db_to=20',
      stub(),
    )
    expect(links(target).map(([label]) => label)).toEqual([
      'Download: Unsealed part of w-1',
      'Download: Unsealed part of w-2',
      'Download: Cluster file',
    ])
    expect(links(target)[1][1]).toContain('http://w-2:8080/api/v1/debug/slice?')
    expect(links(target)[1][1]).toContain('sources=files')
    close()
  })

  it('offers one cluster file and no worker links for postgres', async () => {
    const { target, close } = await open(
      'db_view=slice&db_scope=cluster&db_from=10&db_to=20',
      stub({ provider: 'postgres' }),
    )
    expect(links(target).map(([label]) => label)).toEqual(['Download: Cluster file'])
    close()
  })

  it('shows the rule that is broken and offers no link', async () => {
    const { target, close } = await open('db_view=slice&db_from=0&db_to=700000', stub())
    expect(target.querySelector('[role=alert]')?.textContent).toBe('the time range is at most 168h')
    expect(target.querySelectorAll('.links a')).toHaveLength(0)
    close()
  })

  it('says this worker does not support slices when its route answers 404', async () => {
    const { target, close } = await open(
      'db_view=slice&db_from=10&db_to=20',
      stub({ sliceStatus: 404 }),
    )
    expect(target.querySelector('[data-state=unsupported]')?.textContent).toContain(
      'does not support slices',
    )
    expect(target.querySelectorAll('.links a')).toHaveLength(0)
    close()
  })

  it('says so for a picked peer whose answer has no recorder block (older release)', async () => {
    const { target, close } = await open(
      'db_view=slice&db_worker=w-2&db_from=10&db_to=20',
      stub({ peerHasRecorder: false }),
    )
    expect(target.querySelector('[data-state=unsupported]')).not.toBeNull()
    close()
  })

  it('opens a fresh link in a new tab on click and says the file is being built', async () => {
    const { target, close } = await open('db_view=slice&db_from=10&db_to=20', stub())
    const open_ = vi.fn()
    vi.stubGlobal('open', open_)
    target.querySelector<HTMLAnchorElement>('.links a')!.click()
    await settled()
    expect(open_).toHaveBeenCalledWith(
      '/api/v1/debug/slice?from=10&to=20&scope=worker',
      '_blank',
      'noopener',
    )
    expect(target.querySelector('[role=status]')?.textContent).toContain('Building on w-1')
    close()
  })
})
