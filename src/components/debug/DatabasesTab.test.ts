// Archives section of the Databases tab: a read-only listing of compressed
// recorder archives (v1.8), rendered against a stubbed fetch. Covers
// rendering, graceful absence (404 / empty list), the download href's
// token + encoded-name shape, the lack of a merge checkbox on archive rows,
// and that payload order is preserved rather than client re-sorted.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DatabasesTab from './DatabasesTab.svelte'
import type { ArchiveEntry, DbInfo } from '../../lib/types'

const oneDb: DbInfo = {
  filename: 'workerA-2026-08-09__00_00_00.db',
  path: '/var/db/workerA-2026-08-09__00_00_00.db',
  worker_name: 'workerA',
  cluster_name: 'clusterA',
  event_count: 5,
  event_counts: { task_completed: 5 },
  first_event_ts: 1754697600,
  last_event_ts: 1754701200,
  has_events: true,
  has_config: false,
  has_state: false,
  size_bytes: 2048,
}

// Deliberately NOT in to_ts-descending order: the older window (lower
// to_ts) comes first in the payload. If the component re-sorted client-side
// it would put clusterB-archive above clusterA-archive; it must not.
const archives: ArchiveEntry[] = [
  {
    name: 'clusterA-2026-08-08_00-00__2026-08-09_00-00.db.gz',
    cluster: 'clusterA',
    from_ts: 1754611200,
    to_ts: 1754697600,
    size_bytes: 1536,
  },
  {
    name: 'clusterB-2026-08-09_00-00__2026-08-10_00-00.db.gz',
    cluster: 'clusterB',
    from_ts: 1754697600,
    to_ts: 1754784000,
    size_bytes: 3 * 1024 * 1024,
  },
]

function stubFetch(
  archivesStatus: number,
  archivesBody: unknown = { archives: [] },
  dbBody: DbInfo[] = [oneDb],
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/debug/archives')) {
      return new Response(archivesStatus === 200 ? JSON.stringify(archivesBody) : '{}', {
        status: archivesStatus,
      })
    }
    if (url.includes('/debug/databases')) {
      return new Response(JSON.stringify(dbBody), { status: 200 })
    }
    return new Response('[]', { status: 200 })
  })
}

// Drains the load()/loadArchives() async chain (each behind an awaited
// fetch + json()), same pattern RuntimeTab.test.ts uses for its own
// onMount-driven async reload.
async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DatabasesTab, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

function archivesTable(target: HTMLElement): HTMLTableElement | undefined {
  const heading = [...target.querySelectorAll('h2')].find((h) =>
    h.textContent?.startsWith('Archives'),
  )
  return heading?.nextElementSibling as HTMLTableElement | undefined
}

describe('DatabasesTab archives section', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('renders one row per archive: name, cluster, formatted window, human size', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives }))
    const { target, cleanup } = renderMounted()
    await settled()

    const table = archivesTable(target)
    expect(table).not.toBeUndefined()
    const rows = [...table!.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)

    const first = rows[0].textContent ?? ''
    expect(first).toContain('clusterA-2026-08-08_00-00__2026-08-09_00-00.db.gz')
    expect(first).toContain('clusterA')
    expect(first).toContain('2025-08-08 00:00:00')
    expect(first).toContain('2025-08-09 00:00:00')
    expect(first).toContain('1.5 KB')

    const second = rows[1].textContent ?? ''
    expect(second).toContain('3.0 MB')

    cleanup()
  })

  it('preserves payload order (newest-first from the server) without a client re-sort', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives }))
    const { target, cleanup } = renderMounted()
    await settled()

    const rows = [...archivesTable(target)!.querySelectorAll('tbody tr')]
    expect(rows[0].textContent).toContain('clusterA-2026-08-08')
    expect(rows[1].textContent).toContain('clusterB-2026-08-09')

    cleanup()
  })

  it('builds the download href with the token and the URL-encoded archive name', async () => {
    localStorage.setItem('drakkar_token', 'tok en')
    vi.stubGlobal('fetch', stubFetch(200, { archives }))
    const { target, cleanup } = renderMounted()
    await settled()

    const link = archivesTable(target)!.querySelector('tbody tr a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(
      '/api/v1/debug/archives/clusterA-2026-08-08_00-00__2026-08-09_00-00.db.gz?token=tok%20en',
    )

    cleanup()
  })

  it('renders no merge checkbox on archive rows', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives }))
    const { target, cleanup } = renderMounted()
    await settled()

    const table = archivesTable(target)!
    expect(table.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)

    cleanup()
  })

  it('hides the section entirely when the archive list is empty', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives: [] }))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(archivesTable(target)).toBeUndefined()

    cleanup()
  })

  it('hides the section on a 404 (old backend) without showing an error banner', async () => {
    vi.stubGlobal('fetch', stubFetch(404))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(archivesTable(target)).toBeUndefined()
    expect(target.querySelector('.error')).toBeNull()

    cleanup()
  })
})

describe('DatabasesTab v1.12 rows', () => {
  const liveDb: DbInfo = {
    ...oneDb,
    filename: 'workerA-2026-08-14__10_00_00.db',
    path: '/var/db/workerA-2026-08-14__10_00_00.db',
    live_for: 'workerA',
    kind: 'recorder',
    stats_pending: false,
    cache_entry_count: null,
  }
  const cacheDb: DbInfo = {
    filename: 'workerA-cache.db',
    path: '/var/db/workerA-cache.db.actual',
    worker_name: 'workerA',
    cluster_name: 'clusterA',
    event_count: 0,
    event_counts: {},
    first_event_ts: null,
    last_event_ts: null,
    has_events: false,
    has_config: false,
    has_state: false,
    size_bytes: 4096,
    kind: 'cache',
    live_for: 'workerA',
    stats_pending: false,
    cache_entry_count: 42,
  }
  const pendingDb: DbInfo = {
    ...oneDb,
    filename: 'workerA-2026-08-01__00_00_00.db',
    path: '/var/db/workerA-2026-08-01__00_00_00.db',
    event_count: 0,
    event_counts: {},
    first_event_ts: null,
    last_event_ts: null,
    kind: 'unknown',
    live_for: '',
    stats_pending: true,
    cache_entry_count: null,
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('highlights the in-use row with a chip naming the worker', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives: [] }, [oneDb, liveDb]))
    const { target, cleanup } = renderMounted()
    await settled()

    const inUse = target.querySelectorAll('tr.in-use')
    expect(inUse.length).toBe(1)
    expect(inUse[0].textContent).toContain(liveDb.filename)
    expect(inUse[0].textContent).toContain('in use · workerA')
    cleanup()
  })

  it('shows a cache DB as a typed row: entries count, no merge checkbox, no download', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives: [] }, [oneDb, cacheDb]))
    const { target, cleanup } = renderMounted()
    await settled()

    const row = [...target.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('workerA-cache.db'),
    )
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('42 entries')
    expect(row!.textContent).toContain('cache')
    expect(row!.querySelector('input[type=checkbox]')).toBeNull()
    expect(row!.querySelector('a[title=Download]')).toBeNull()
    cleanup()
  })

  it('shows pending rows with a scanning marker instead of hiding them as empty', async () => {
    vi.stubGlobal('fetch', stubFetch(200, { archives: [] }, [oneDb, pendingDb]))
    const { target, cleanup } = renderMounted()
    await settled()

    const row = [...target.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(pendingDb.filename),
    )
    expect(row).toBeTruthy()
    expect(row!.textContent).toContain('scanning…')
    cleanup()
  })

  it('still hides settled empty recorder files', async () => {
    const emptyDb: DbInfo = { ...oneDb, filename: 'workerA-empty.db', event_count: 0, stats_pending: false }
    vi.stubGlobal('fetch', stubFetch(200, { archives: [] }, [oneDb, emptyDb]))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.textContent).not.toContain('workerA-empty.db')
    expect(target.textContent).toContain('1 empty hidden')
    cleanup()
  })
})
