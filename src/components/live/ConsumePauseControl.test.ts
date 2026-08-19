// Consume-pause control: hidden without the opt-in, preset buttons from the
// configured durations, pause POST → countdown banner, resume POST → back to
// the buttons — all against a stubbed fetch.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import ConsumePauseControl from './ConsumePauseControl.svelte'
import type { ConsumePauseState } from '../../lib/types'

function pauseState(overrides: Partial<ConsumePauseState> = {}): ConsumePauseState {
  return {
    enabled: true,
    durations_seconds: [15, 60, 300, 900],
    active: false,
    resume_at_ms: null,
    requested_seconds: null,
    ...overrides,
  }
}

// Stub fetch: GET serves `state`; POST pause/resume mutate it like the
// backend would and serve the result.
function stubFetch(state: ConsumePauseState) {
  const holder = { state }
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/debug/consume-resume')) {
      holder.state = pauseState({
        ...holder.state,
        active: false,
        resume_at_ms: null,
        requested_seconds: null,
      })
      return new Response(JSON.stringify(holder.state), { status: 200 })
    }
    if (url.includes('/debug/consume-pause') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { duration_seconds: number }
      holder.state = pauseState({
        ...holder.state,
        active: true,
        resume_at_ms: Date.now() + body.duration_seconds * 1000,
        requested_seconds: body.duration_seconds,
      })
      return new Response(JSON.stringify(holder.state), { status: 200 })
    }
    if (url.includes('/debug/consume-pause')) {
      return new Response(JSON.stringify(holder.state), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { stub, holder }
}

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
  const app = mount(ConsumePauseControl, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('ConsumePauseControl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders nothing when the deployment did not opt in', async () => {
    vi.stubGlobal('fetch', stubFetch(pauseState({ enabled: false })).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('button')).toBeNull()
    cleanup()
  })

  it('offers one button per configured preset, human-labelled', async () => {
    vi.stubGlobal('fetch', stubFetch(pauseState()).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    const labels = [...target.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['15s', '1m', '5m', '15m'])
    cleanup()
  })

  it('pausing shows the countdown banner; resume brings the buttons back', async () => {
    const { stub } = stubFetch(pauseState())
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()

    const oneMinute = [...target.querySelectorAll('button')].find((b) => b.textContent === '1m')!
    oneMinute.click()
    await settled()

    const banner = target.querySelector('.paused-banner')!
    expect(banner.textContent).toContain('Consuming paused')
    expect(banner.textContent).toMatch(/resumes in \d+:\d{2}/)
    expect(banner.textContent).toContain('no rebalance')

    const resume = [...target.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Resume now'),
    )!
    resume.click()
    await settled()

    expect(target.querySelector('.paused-banner')).toBeNull()
    const labels = [...target.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['15s', '1m', '5m', '15m'])
    cleanup()
  })

  it('renders an active pause on load (deep-linked or second tab)', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        pauseState({ active: true, resume_at_ms: Date.now() + 42_000, requested_seconds: 60 }),
      ).stub,
    )
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.paused-banner')?.textContent).toContain('Consuming paused')
    cleanup()
  })

  it('surfaces a failed pause as an inline error', async () => {
    const { stub } = stubFetch(pauseState())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response('{"detail":"Consumer is not running"}', { status: 503 })
        }
        return stub(input, init)
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    ;[...target.querySelectorAll('button')][0].click()
    await settled()
    expect(target.querySelector('.error')?.textContent).toContain('Consumer is not running')
    cleanup()
  })
})
