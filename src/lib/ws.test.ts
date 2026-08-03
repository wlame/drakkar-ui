import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLiveSocket } from './ws'
import type { WsEvent } from './types'

// Minimal stand-in for the browser WebSocket. Only the surface createLiveSocket
// touches is implemented, plus helpers to drive it from the test.
class FakeWebSocket {
  static last: FakeWebSocket | null = null
  static instances = 0

  url: string
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: ((e: { code: number }) => void) | null = null
  closed = false

  constructor(url: string) {
    this.url = url
    FakeWebSocket.last = this
    FakeWebSocket.instances += 1
  }

  close() {
    this.closed = true
  }

  // --- test drivers ---
  open() {
    this.onopen?.()
  }
  deliver(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  deliverRaw(data: string) {
    this.onmessage?.({ data })
  }
  serverClose(code: number) {
    this.onclose?.({ code })
  }
}

function install() {
  FakeWebSocket.last = null
  FakeWebSocket.instances = 0
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
}

function sock() {
  const s = FakeWebSocket.last
  if (!s) throw new Error('no socket was created')
  return s
}

describe('createLiveSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    install()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('declares its event types in the query string', () => {
    const s = createLiveSocket({
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      eventTypes: ['task_started', 'arranged'],
    })
    expect(sock().url).toContain('events=task_started%2Carranged')
    s.close()
  })

  it('omits the filter when no event types are given', () => {
    const s = createLiveSocket({ onEvent: vi.fn(), onStatus: vi.fn() })
    expect(sock().url).not.toContain('events=')
    s.close()
  })

  it('dispatches every event in a batched frame, in order', () => {
    const onEvent = vi.fn()
    const s = createLiveSocket({ onEvent, onStatus: vi.fn() })
    sock().deliver({
      dropped: 0,
      events: [
        { event: 'task_started', ts: 1 },
        { event: 'task_completed', ts: 2 },
      ],
    })
    expect(onEvent).toHaveBeenCalledTimes(2)
    expect((onEvent.mock.calls[0][0] as WsEvent).event).toBe('task_started')
    expect((onEvent.mock.calls[1][0] as WsEvent).event).toBe('task_completed')
    s.close()
  })

  it('reports a gap before dispatching the frame that carried it', () => {
    const seen: string[] = []
    const s = createLiveSocket({
      onEvent: () => seen.push('event'),
      onGap: () => seen.push('gap'),
      onStatus: vi.fn(),
    })
    sock().deliver({ dropped: 4, events: [{ event: 'task_started', ts: 1 }] })
    // The resync a gap triggers must account for this frame's events too.
    expect(seen).toEqual(['gap', 'event'])
    s.close()
  })

  it('does not report a gap when nothing was dropped', () => {
    const onGap = vi.fn()
    const s = createLiveSocket({ onEvent: vi.fn(), onGap, onStatus: vi.fn() })
    sock().deliver({ dropped: 0, events: [] })
    expect(onGap).not.toHaveBeenCalled()
    s.close()
  })

  it('ignores malformed frames instead of dying', () => {
    const onEvent = vi.fn()
    const s = createLiveSocket({ onEvent, onStatus: vi.fn() })
    sock().deliverRaw('{not json')
    sock().deliver({ dropped: 0 }) // no events key
    expect(onEvent).not.toHaveBeenCalled()
    s.close()
  })

  it('drops frames while frozen and resumes after', () => {
    const onEvent = vi.fn()
    const s = createLiveSocket({ onEvent, onStatus: vi.fn() })
    s.setFrozen(true)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 1 }] })
    expect(onEvent).not.toHaveBeenCalled()

    s.setFrozen(false)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 2 }] })
    expect(onEvent).toHaveBeenCalledTimes(1)
    s.close()
  })

  it('drops frames while suspended and resumes after', () => {
    const onEvent = vi.fn()
    const s = createLiveSocket({ onEvent, onStatus: vi.fn() })
    s.setSuspended(true)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 1 }] })
    expect(onEvent).not.toHaveBeenCalled()

    s.setSuspended(false)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 2 }] })
    expect(onEvent).toHaveBeenCalledTimes(1)
    s.close()
  })

  it('keeps freeze and suspend independent', () => {
    // Clearing one must not resume delivery while the other still holds.
    const onEvent = vi.fn()
    const s = createLiveSocket({ onEvent, onStatus: vi.fn() })
    s.setFrozen(true)
    s.setSuspended(true)

    s.setSuspended(false)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 1 }] })
    expect(onEvent).not.toHaveBeenCalled() // still frozen by the operator

    s.setFrozen(false)
    sock().deliver({ dropped: 0, events: [{ event: 'task_started', ts: 2 }] })
    expect(onEvent).toHaveBeenCalledTimes(1)
    s.close()
  })

  it('reconnects after an ordinary close', () => {
    const s = createLiveSocket({ onEvent: vi.fn(), onStatus: vi.fn() })
    expect(FakeWebSocket.instances).toBe(1)
    sock().serverClose(1006)
    vi.advanceTimersByTime(3000)
    expect(FakeWebSocket.instances).toBe(2)
    s.close()
  })

  it('does not retry an auth or origin rejection', () => {
    // Reconnecting with a bad token would loop forever.
    for (const code of [4401, 4403]) {
      install()
      const onStatus = vi.fn()
      const s = createLiveSocket({ onEvent: vi.fn(), onStatus })
      sock().serverClose(code)
      vi.advanceTimersByTime(30_000)
      expect(FakeWebSocket.instances).toBe(1)
      expect(onStatus).toHaveBeenCalledWith(code === 4401 ? 'unauthorized' : 'forbidden')
      s.close()
    }
  })

  it('stops reconnecting once closed by the caller', () => {
    const s = createLiveSocket({ onEvent: vi.fn(), onStatus: vi.fn() })
    s.close()
    sock().serverClose(1006)
    vi.advanceTimersByTime(30_000)
    expect(FakeWebSocket.instances).toBe(1)
  })
})
