// Detach banner (contract v1.33): shown on every page while the worker is
// detached, with origin, reason and the deadline; a quiet line during a
// transition; nothing while attached or on an older worker.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DetachBanner from './DetachBanner.svelte'
import { resetDetachForTests } from '../lib/detach'
import type { DetachState } from '../lib/types'

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

function stubState(state: DetachState | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      state === null
        ? new Response('Not Found', { status: 404 })
        : new Response(JSON.stringify(state), { status: 200 }),
    ),
  )
}

async function settled() {
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 4; i++) {
    flushSync()
    await Promise.resolve()
  }
  flushSync()
}

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DetachBanner, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('DetachBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetDetachForTests()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows origin, reason, the deadline in UTC and the time left while detached', async () => {
    const until = Date.now() + 10 * 60_000
    stubState(
      detachState({
        state: 'detached',
        origin: 'handler',
        reason: 'database maintenance',
        since_ms: Date.now(),
        until_ms: until,
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    const banner = target.querySelector('.detach-banner')!
    expect(banner.textContent).toContain('Detached from the consumer group')
    expect(banner.textContent).toContain('handler')
    expect(banner.textContent).toContain('database maintenance')
    expect(banner.textContent).toContain(
      `attaches at ${new Date(until).toISOString().substring(11, 19)} UTC`,
    )
    expect(banner.textContent).toMatch(/10:00|9:59/)
    cleanup()
  })

  it('shows a quiet line during a transition', async () => {
    stubState(detachState({ state: 'attaching', origin: 'operator' }))
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.querySelector('.detach-banner')).toBeNull()
    expect(target.querySelector('.detach-transition')?.textContent).toContain('Attaching')
    cleanup()
  })

  it('shows nothing while attached', async () => {
    stubState(detachState())
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.textContent?.trim()).toBe('')
    cleanup()
  })

  it('shows nothing on a worker without the route', async () => {
    stubState(null)
    const { target, cleanup } = renderMounted()
    await settled()
    expect(target.textContent?.trim()).toBe('')
    cleanup()
  })

  it('says the deadline has passed instead of counting below zero', async () => {
    stubState(
      detachState({
        state: 'detached',
        origin: 'operator',
        since_ms: Date.now() - 120_000,
        until_ms: Date.now() - 1_000,
      }),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    const text = target.querySelector('.detach-banner')!.textContent ?? ''
    expect(text).toContain('the deadline has passed')
    expect(text).not.toContain('0:00')
    cleanup()
  })

  it('says the state is unknown after two failed reads, and drops the sign on a good read', async () => {
    vi.setSystemTime(Date.UTC(2026, 10, 16, 14, 0, 0))
    const detached = detachState({
      state: 'detached',
      origin: 'operator',
      since_ms: Date.now(),
      until_ms: Date.now() + 600_000,
    })
    let failing = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        failing
          ? new Response('boom', { status: 500 })
          : new Response(JSON.stringify(detached), { status: 200 }),
      ),
    )
    const { target, cleanup } = renderMounted()
    await settled()
    failing = true
    await vi.advanceTimersByTimeAsync(5_000)
    flushSync()
    expect(target.querySelector('.detach-stale')).toBeNull()
    await vi.advanceTimersByTimeAsync(5_000)
    flushSync()
    expect(target.querySelector('.detach-stale')?.textContent).toBe(
      'state unknown since 14:00:00 UTC: the worker does not answer',
    )
    failing = false
    await vi.advanceTimersByTimeAsync(5_000)
    flushSync()
    expect(target.querySelector('.detach-stale')).toBeNull()
    expect(target.querySelector('.detach-banner')).not.toBeNull()
    cleanup()
  })
})
