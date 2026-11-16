// Detach control (contract v1.33): hidden without the feature, the UI switch
// or the route; presets within the maximum; the reason field; the POST, which
// the worker answers 202 with its state from before the request, and the wait
// until a read shows the change; the outcome sentence; Attach while detached.
// All against a stubbed fetch and fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DetachControl from './DetachControl.svelte'
import DetachBanner from '../DetachBanner.svelte'
import { DETACH_WAIT_LIMIT_MS, resetDetachForTests } from '../../lib/detach'
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

// GET serves `holder.state` (404 when null). A POST records its body and
// answers 202 with the state UNCHANGED, as the worker does: it only starts
// the transition, and a later read shows it. A test moves `holder.state` to
// play the worker.
function stubFetch(initial: DetachState | null) {
  const holder: Holder = { state: initial, gets: 0, posts: [] }
  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = init.body ? JSON.parse(String(init.body)) : null
      holder.posts.push({ url, body })
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

const WAITING_TEXT = 'Sent; waiting for the worker…'

// Opens the form and sends a detach with the default duration.
async function sendDetach(target: HTMLElement) {
  openForm(target)
  buttonByText(target, 'Detach from the group')!.click()
  await settled()
}

describe('DetachControl', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.UTC(2026, 10, 16, 12, 0, 0))
  })

  afterEach(() => {
    resetDetachForTests()
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

  it('renders nothing on a 404, checks again once a minute, and shows the control once the route answers', async () => {
    const { stub, holder } = stubFetch(null)
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.textContent?.trim()).toBe('')
    await settled(20_000)
    expect(holder.gets).toBe(1)

    holder.state = detachState()
    await settled(40_000)
    expect(holder.gets).toBe(2)
    expect(target.querySelector('.detach-toggle')).not.toBeNull()
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

  it('sends the detach, waits for the worker, then shows the transition and a clean form', async () => {
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
    // The 202 answer still says attached: the control waits, its button is off.
    expect(target.querySelector('.detach-waiting')?.textContent?.trim()).toBe(WAITING_TEXT)
    expect(target.querySelector<HTMLButtonElement>('.detach-toggle')!.disabled).toBe(true)

    holder.state = detachState({ state: 'detaching', origin: 'operator' })
    await settled(1_000)
    expect(target.querySelector('.detach-waiting')).toBeNull()
    expect(buttonByText(target, 'Detaching')!.disabled).toBe(true)

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
    expect(buttonByText(target, 'Attach now')!.disabled).toBe(false)

    // Back to attached: the form opens empty, not with the old reason.
    holder.state = detachState()
    await settled(5_000)
    expect(target.querySelector('.detach-pop')).toBeNull()
    openForm(target)
    expect(target.querySelector<HTMLInputElement>('input.detach-reason')!.value).toBe('')
    cleanup()
  })

  it('allows no second request while it waits for the worker', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    await sendDetach(target)
    await settled(2_000)
    // Still attached on the worker; the toggle stays off and opens nothing.
    const toggle = target.querySelector<HTMLButtonElement>('.detach-toggle')!
    expect(toggle.disabled).toBe(true)
    toggle.click()
    flushSync()
    expect(target.querySelector('.detach-pop')).toBeNull()
    expect(holder.posts).toHaveLength(1)
    cleanup()
  })

  it('ends the wait when a newer last_request shows, and shows its refusal', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    await sendDetach(target)
    holder.state = detachState({
      last_request: {
        origin: 'operator',
        action: 'detach',
        outcome: 'budget_full',
        at_ms: Date.now(),
      },
    })
    await settled(1_000)
    expect(target.querySelector('.detach-waiting')).toBeNull()
    expect(target.querySelector('.detach-outcome')?.textContent).toContain(
      'The limit of detached workers in this group is reached.',
    )
    expect(target.querySelector<HTMLButtonElement>('.detach-toggle')!.disabled).toBe(false)
    cleanup()
  })

  it('ends the wait at its bound and says the worker has not shown the request', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    await sendDetach(target)
    await settled(DETACH_WAIT_LIMIT_MS - 1_000)
    expect(target.querySelector('.detach-waiting')).not.toBeNull()
    await settled(1_000)
    expect(target.querySelector('.detach-waiting')).toBeNull()
    expect(target.querySelector('.detach-unshown')?.textContent?.trim()).toBe(
      'The worker has not shown the request yet. Check the state before you ask again.',
    )
    expect(target.querySelector<HTMLButtonElement>('.detach-toggle')!.disabled).toBe(false)
    expect(holder.posts).toHaveLength(1)
    cleanup()
  })

  it('hides an older refusal from the moment a new request is sent until last_request changes', async () => {
    const old = {
      origin: 'operator' as const,
      action: 'detach' as const,
      outcome: 'budget_full',
      at_ms: Date.now() - 600_000,
    }
    const { stub, holder } = stubFetch(detachState({ last_request: old }))
    vi.stubGlobal('fetch', stub)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.detach-outcome')).not.toBeNull()

    await sendDetach(target)
    expect(target.querySelector('.detach-outcome')).toBeNull()

    // The leave runs: still the old last_request, and no old sentence shows.
    holder.state = detachState({ state: 'detaching', origin: 'operator', last_request: old })
    await settled(1_000)
    expect(buttonByText(target, 'Detaching')).toBeDefined()
    expect(target.querySelector('.detach-outcome')).toBeNull()

    // The leave failed: a new refusal is news again.
    holder.state = detachState({
      last_request: { ...old, outcome: 'leave_failed', at_ms: Date.now() },
    })
    await settled(1_000)
    expect(target.querySelector('.detach-outcome')?.textContent).toContain(
      'The worker could not leave its group in time.',
    )
    cleanup()
  })

  it('polls once a second while the worker is detaching', async () => {
    const { stub, holder } = stubFetch(detachState({ state: 'detaching', origin: 'handler' }))
    vi.stubGlobal('fetch', stub)
    const { cleanup } = renderMounted()
    await settled()
    const before = holder.gets
    await settled(3_000)
    expect(holder.gets - before).toBe(3)
    cleanup()
  })

  it('polls at the slow pace while the worker is attached', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const { cleanup } = renderMounted()
    await settled()
    const before = holder.gets
    await settled(4_000)
    expect(holder.gets - before).toBe(0)
    await settled(1_000)
    expect(holder.gets - before).toBe(1)
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
    const outcome = target.querySelector('.detach-outcome')?.textContent ?? ''
    expect(outcome).toContain('The limit of detached workers in this group is reached.')
    expect(outcome).toContain('at 12:00:00 UTC')
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

  it('shows an unknown state as it is', async () => {
    vi.stubGlobal('fetch', stubFetch(detachState({ state: 'parked' as never })).stub)
    const { target, cleanup } = renderMounted()
    await settled()
    const button = buttonByText(target, 'State: parked')!
    expect(button.disabled).toBe(true)
    expect(buttonByText(target, 'Attaching')).toBeUndefined()
    cleanup()
  })

  it('shows Attach only while detached, sends the attach and waits for the worker', async () => {
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
    // The 202 answer still says detached: the button stays, but off.
    expect(buttonByText(target, 'Attach now')!.disabled).toBe(true)
    buttonByText(target, 'Attach now')!.click()
    await settled()
    expect(holder.posts).toHaveLength(1)

    holder.state = detachState({ state: 'attaching', origin: 'handler' })
    await settled(1_000)
    expect(buttonByText(target, 'Attach now')).toBeUndefined()
    expect(buttonByText(target, 'Attaching')?.disabled).toBe(true)
    cleanup()
  })

  it('keeps its view and its buttons while the worker does not answer', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 16, 14, 0, 0))
    const { stub, holder } = stubFetch(
      detachState({ state: 'detached', origin: 'operator', until_ms: Date.now() + 600_000 }),
    )
    let failing = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        failing && init?.method !== 'POST'
          ? new Response('boom', { status: 502 })
          : stub(input, init),
      ),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    failing = true
    await settled(10_000)
    expect(target.querySelector('.detach-stale')?.textContent).toBe(
      'The worker does not answer; this state is from 14:00:00 UTC',
    )
    const attach = buttonByText(target, 'Attach now')!
    expect(attach.disabled).toBe(false)
    attach.click()
    await settled()
    expect(holder.posts.map((p) => p.url)).toEqual(['/api/v1/debug/attach'])
    cleanup()
  })

  // A POST that fails with `answer`, against an attached worker; returns the
  // error line the control shows and the number of reads.
  async function failedDetach(
    answer: () => Promise<Response>,
  ): Promise<{ text: string | null; readsAfterPost: number }> {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST' ? answer() : stub(input, init),
      ),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    const readsBefore = holder.gets
    await sendDetach(target)
    const text = target.querySelector('.error')?.textContent ?? null
    const readsAfterPost = holder.gets - readsBefore
    expect(target.querySelector('.detach-waiting')).toBeNull()
    cleanup()
    return { text, readsAfterPost }
  }

  it('shows the detail of a 403 as it is', async () => {
    const { text } = await failedDetach(
      async () =>
        new Response('{"detail":"Detach from the UI is off; set ui.detach_enabled to true."}', {
          status: 403,
        }),
    )
    expect(text).toBe('Detach from the UI is off; set ui.detach_enabled to true.')
  })

  it('shows the messages of a 422 validation answer', async () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'duration_seconds'], msg: 'Input should be less than or equal to 3600' },
      ],
    })
    const { text } = await failedDetach(async () => new Response(body, { status: 422 }))
    expect(text).toBe('Input should be less than or equal to 3600')
  })

  it('after a 503 reads the state at once and says to check it before asking again', async () => {
    const { text, readsAfterPost } = await failedDetach(
      async () =>
        new Response('{"detail":"The worker did not answer in time; try again"}', { status: 503 }),
    )
    expect(text).toBe('The worker did not answer in time. Check the state before you ask again.')
    expect(readsAfterPost).toBe(1)
  })

  it('shows one sentence when the worker does not answer', async () => {
    const { text } = await failedDetach(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(text).toBe('The worker did not answer. Check the connection and try again.')
  })
})

describe('DetachControl and DetachBanner together', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetDetachForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function mountBoth() {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const banner = mount(DetachBanner, { target })
    const control = mount(DetachControl, { target })
    return {
      target,
      unmountBanner: () => unmount(banner),
      unmountControl: () => unmount(control),
      remove: () => target.remove(),
    }
  }

  it('share one poll loop', async () => {
    const { stub, holder } = stubFetch(
      detachState({ state: 'detached', origin: 'operator', until_ms: Date.now() + 600_000 }),
    )
    vi.stubGlobal('fetch', stub)
    const both = mountBoth()
    await settled()
    expect(both.target.querySelector('.detach-banner')).not.toBeNull()
    expect(buttonByText(both.target, 'Attach now')).toBeDefined()
    expect(holder.gets).toBe(1)
    await settled(10_000)
    // One loop at the slow pace: the first read, then one at 5 s and one at 10 s.
    expect(holder.gets).toBe(3)
    both.unmountBanner()
    both.unmountControl()
    both.remove()
  })

  it('stop polling after the last one unmounts', async () => {
    const { stub, holder } = stubFetch(detachState())
    vi.stubGlobal('fetch', stub)
    const both = mountBoth()
    await settled()
    both.unmountBanner()
    await settled(5_000)
    expect(holder.gets).toBe(2)
    both.unmountControl()
    await settled(20_000)
    expect(holder.gets).toBe(2)
    both.remove()
  })
})
