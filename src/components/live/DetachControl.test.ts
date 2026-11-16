// Detach control (contract v1.33): hidden without the feature, the UI switch
// or the route; presets within the maximum; the reason field; the POST and
// the fast poll during a transition; the outcome sentence; Attach while
// detached. All against a stubbed fetch and fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DetachControl from './DetachControl.svelte'
import type { DetachState } from '../../lib/types'

function detachState(overrides: Partial<DetachState> = {}): DetachState {
  return {
    enabled: true,
    ui_enabled: true,
    state: 'attached',
    origin: null,
    reason: '',
    since_ms: null,
    until_ms: null,
    max_duration_seconds: 3600,
    default_duration_seconds: 900,
    last_request: null,
    ...overrides,
  }
}

interface Holder {
  state: DetachState | null
  gets: number
  posts: { url: string; body: unknown }[]
}

// GET serves `holder.state` (404 when null); the POST routes record their
// body and move the state like the worker would at the start of a transition.
function stubFetch(initial: DetachState | null) {
  const holder: Holder = { state: initial, gets: 0, posts: [] }
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : null
      holder.posts.push({ url, body })
      if (url.endsWith('/debug/detach')) {
        holder.state = { ...holder.state!, state: 'detaching', origin: 'operator' }
      } else if (url.endsWith('/debug/attach')) {
        holder.state = { ...holder.state!, state: 'attaching' }
      }
      return new Response(JSON.stringify(holder.state), { status: 202 })
    }
    if (url.endsWith('/debug/detach')) {
      holder.gets += 1
      if (holder.state === null) return new Response('Not Found', { status: 404 })
      return new Response(JSON.stringify(holder.state), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
  return { stub, holder }
}

async function settled(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms)
  for (let i = 0; i < 4; i++) {
    flushSync()
    await Promise.resolve()
  }
  flushSync()
}

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DetachControl, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

function openForm(target: HTMLElement) {
  target.querySelector<HTMLButtonElement>('.detach-toggle')!.click()
  flushSync()
}

function buttonByText(target: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...target.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(text),
  )
}

describe('DetachControl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('renders nothing when the feature is off', async () => {
    vi.stubGlobal('fetch', stubFetch(detachState({ enabled: false })).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('button')).toBeNull()
    cleanup()
  })

  it('renders nothing when ui.detach_enabled is false', async () => {
    vi.stubGlobal('fetch', stubFetch(detachState({ ui_enabled: false })).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('button')).toBeNull()
    cleanup()
  })

  it('renders nothing and no error when the route answers 404', async () => {
    const { stub, holder } = stubFetch(null)
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.textContent?.trim()).toBe('')
    // An older worker is not polled again.
    await settled(20_000)
    expect(holder.gets).toBe(1)
    cleanup()
  })

  it('offers the presets within the maximum, a reason field and the note', async () => {
    vi.stubGlobal('fetch', stubFetch(detachState({ max_duration_seconds: 1800 })).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    openForm(target)
    const labels = [...target.querySelectorAll('.detach-presets button')].map((b) => b.textContent)
    expect(labels).toEqual(['5 min', '15 min'])
    const reason = target.querySelector<HTMLInputElement>('input.detach-reason')!
    expect(reason.maxLength).toBe(200)
    expect(target.querySelector('.detach-pop')?.textContent).toContain(
      'This worker leaves its consumer group. Kafka gives its partitions to the other workers.',
    )
    cleanup()
  })

  it('sends the detach, disables the button and polls once a second while detaching', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    openForm(target)
    buttonByText(target, '1 h')!.click()
    flushSync()
    const reason = target.querySelector<HTMLInputElement>('input.detach-reason')!
    reason.value = 'rolling restart of the database'
    reason.dispatchEvent(new Event('input'))
    flushSync()
    buttonByText(target, 'Detach from the group')!.click()
    await settled()

    expect(holder.posts).toEqual([
      {
        url: '/api/v1/debug/detach',
        body: { duration_seconds: 3600, reason: 'rolling restart of the database' },
      },
    ])
    const busy = buttonByText(target, 'Detaching')!
    expect(busy.disabled).toBe(true)

    const before = holder.gets
    await settled(3_000)
    expect(holder.gets - before).toBeGreaterThanOrEqual(2)

    holder.state = detachState({
      state: 'detached',
      origin: 'operator',
      since_ms: Date.now(),
      until_ms: Date.now() + 3_600_000,
      last_request: {
        origin: 'operator',
        action: 'detach',
        outcome: 'detached',
        at_ms: Date.now(),
      },
    })
    await settled(1_000)
    expect(buttonByText(target, 'Attach now')).toBeDefined()
    cleanup()
  })

  it('shows a refused request in plain words', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        detachState({
          last_request: {
            origin: 'operator',
            action: 'detach',
            outcome: 'budget_full',
            at_ms: Date.now(),
          },
        }),
      ).stub,
    )
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.detach-outcome')?.textContent).toContain(
      'The limit of detached workers in this group is reached.',
    )
    cleanup()
  })

  it('shows an unknown outcome as it is', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(
        detachState({
          last_request: {
            origin: 'handler',
            action: 'attach',
            outcome: 'moon_phase',
            at_ms: Date.now(),
          },
        }),
      ).stub,
    )
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.detach-outcome')?.textContent).toContain('moon_phase')
    cleanup()
  })

  it('shows Attach only while detached, and sends the attach', async () => {
    const { stub, holder } = stubFetch(
      detachState({ state: 'detached', origin: 'handler', until_ms: Date.now() + 60_000 }),
    )
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.detach-toggle')).toBeNull()
    buttonByText(target, 'Attach now')!.click()
    await settled()
    expect(holder.posts.map((p) => p.url)).toEqual(['/api/v1/debug/attach'])
    expect(buttonByText(target, 'Attach now')).toBeUndefined()
    expect(buttonByText(target, 'Attaching')?.disabled).toBe(true)
    cleanup()
  })

  it('surfaces a failed request as an inline error', async () => {
    const { stub } = stubFetch(detachState())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          return new Response('{"detail":"set ui.detach_enabled to true"}', { status: 403 })
        }
        return stub(input, init)
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    openForm(target)
    buttonByText(target, 'Detach from the group')!.click()
    await settled()
    expect(target.querySelector('.error')?.textContent).toContain('ui.detach_enabled')
    cleanup()
  })
})
