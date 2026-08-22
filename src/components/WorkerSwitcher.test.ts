// Worker-switcher liveness rendering (contract v1.18): peers with
// online=false gray out, gain an "offline" tag, and carry a last-seen title,
// while staying plain clickable links; peers without the field (pre-v1.18
// backend) and online=true peers render exactly as before. Raw-DOM mount
// harness (mount/flushSync/unmount), matching KafkaIcon.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import WorkerSwitcher from './WorkerSwitcher.svelte'
import type { WorkerPeer } from '../lib/types'

const NOW_S = Date.now() / 1000

function worker(over: Partial<WorkerPeer>): WorkerPeer {
  return {
    worker_name: 'worker-a',
    cluster: 'analytics-prod',
    url: 'http://worker-a:8080/',
    is_current: false,
    ip_address: null,
    debug_port: null,
    debug_url: 'http://worker-a:8080/',
    ...over,
  }
}

// What GET /api/v1/workers answers with; each test sets it before mounting.
let workersPayload: WorkerPeer[] = []

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(WorkerSwitcher, { target, props: {} })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

// Drains the component's awaited /workers fetch (a few microtask ticks),
// then applies the resulting state to the DOM.
async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await Promise.resolve()
  }
  flushSync()
}

async function openMenu() {
  const { target, cleanup } = renderMounted()
  await settled()
  target.querySelector<HTMLButtonElement>('.trigger')!.click()
  flushSync()
  return { target, cleanup }
}

function item(target: HTMLElement, name: string): HTMLElement {
  const el = [...target.querySelectorAll<HTMLElement>('.menu .item')].find(
    (i) => i.querySelector('.mono')?.textContent === name,
  )
  if (!el) throw new Error(`no menu item for ${name}`)
  return el
}

beforeEach(() => {
  workersPayload = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(workersPayload), { status: 200 })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WorkerSwitcher liveness', () => {
  it('renders peers without the v1.18 fields exactly as before (no offline chrome)', async () => {
    workersPayload = [
      worker({ worker_name: 'worker-a', is_current: true }),
      worker({ worker_name: 'worker-b', url: 'http://worker-b:8080/' }),
    ]
    const { target, cleanup } = await openMenu()

    const peer = item(target, 'worker-b')
    expect(peer.classList.contains('offline')).toBe(false)
    expect(peer.getAttribute('title')).toBeNull()
    expect([...peer.querySelectorAll('.tag')]).toHaveLength(0)
    cleanup()
  })

  it('renders online peers without offline chrome', async () => {
    workersPayload = [
      worker({ worker_name: 'worker-a', is_current: true, online: true, last_seen_ts: NOW_S }),
      worker({
        worker_name: 'worker-b',
        url: 'http://worker-b:8080/',
        online: true,
        last_seen_ts: NOW_S,
      }),
    ]
    const { target, cleanup } = await openMenu()

    const peer = item(target, 'worker-b')
    expect(peer.classList.contains('offline')).toBe(false)
    expect(peer.textContent).not.toContain('offline')
    cleanup()
  })

  it('grays offline peers, tags them, titles last-seen, and keeps them clickable', async () => {
    workersPayload = [
      worker({ worker_name: 'worker-a', is_current: true, online: true, last_seen_ts: NOW_S }),
      worker({
        worker_name: 'worker-b',
        url: 'http://worker-b:8080/',
        online: false,
        last_seen_ts: NOW_S - 90, // 1m30s ago → "1m ago"
      }),
    ]
    const { target, cleanup } = await openMenu()

    const peer = item(target, 'worker-b')
    expect(peer.classList.contains('offline')).toBe(true)
    expect(peer.querySelector('.tag')?.textContent).toBe('offline')
    expect(peer.getAttribute('title')).toBe('offline — last seen 1m ago')
    // Still a plain anchor to the peer's UI — visually dead, not dead-linked.
    expect(peer.tagName).toBe('A')
    expect(peer.getAttribute('href')).toBe('http://worker-b:8080/')
    cleanup()
  })

  it('says "last seen unknown" when an offline peer has no heartbeat timestamp', async () => {
    workersPayload = [
      worker({ worker_name: 'worker-a', is_current: true, online: true }),
      worker({
        worker_name: 'worker-b',
        url: 'http://worker-b:8080/',
        online: false,
        last_seen_ts: null,
      }),
    ]
    const { target, cleanup } = await openMenu()

    expect(item(target, 'worker-b').getAttribute('title')).toBe('offline — last seen unknown')
    cleanup()
  })

  it('never marks the current worker offline', async () => {
    workersPayload = [worker({ worker_name: 'worker-a', is_current: true, online: true })]
    const { target, cleanup } = await openMenu()

    const current = item(target, 'worker-a')
    expect(current.classList.contains('current')).toBe(true)
    expect(current.textContent).not.toContain('offline')
    cleanup()
  })
})
