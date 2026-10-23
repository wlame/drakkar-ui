// The cluster fan-out (contract v1.23): one call per worker, a timeout per
// worker, and the workers that did not answer listed with a reason instead
// of failing the page.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fanOut, fanOutTargets, type FanOutTarget } from './fanout'
import { HttpError } from './api'
import type { WorkerPeer } from './types'

function peer(name: string, extra: Partial<WorkerPeer> = {}): WorkerPeer {
  return {
    worker_name: name,
    cluster: 'search',
    url: `http://${name}:8080/`,
    is_current: false,
    ip_address: null,
    debug_port: null,
    debug_url: null,
    online: true,
    ...extra,
  } as WorkerPeer
}

describe('fanOutTargets', () => {
  it('puts the current worker first on its own origin, then its online cluster peers by name', () => {
    const { targets, unreachable } = fanOutTargets([
      peer('w-3'),
      peer('w-1', { is_current: true }),
      peer('w-2', { online: null }),
      peer('w-off', { online: false }),
      peer('w-other', { cluster: 'index' }),
    ])

    expect(targets).toEqual([
      { worker: 'w-1', base: '' },
      { worker: 'w-2', base: 'http://w-2:8080' },
      { worker: 'w-3', base: 'http://w-3:8080' },
    ])
    expect(unreachable).toEqual([])
  })

  it('leaves a worker with ui_enabled false out of the fan-out, not even listed', () => {
    const { targets, unreachable } = fanOutTargets([
      peer('w-1', { is_current: true }),
      peer('w-headless', { ui_enabled: false }),
    ])

    expect(targets.map((t) => t.worker)).toEqual(['w-1'])
    expect(unreachable).toEqual([])
  })

  it('lists a peer without an address as unreachable', () => {
    const { targets, unreachable } = fanOutTargets([
      peer('w-1', { is_current: true }),
      peer('w-2', { url: '' }),
    ])

    expect(targets.map((t) => t.worker)).toEqual(['w-1'])
    expect(unreachable).toEqual([{ worker: 'w-2', reason: 'no address' }])
  })

  it('falls back to this worker alone when the workers list has no current worker', () => {
    expect(fanOutTargets([]).targets).toEqual([{ worker: '', base: '' }])
  })
})

describe('fanOut', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const targets: FanOutTarget[] = [
    { worker: 'w-1', base: '' },
    { worker: 'w-2', base: 'http://w-2:8080' },
    { worker: 'w-3', base: 'http://w-3:8080' },
    { worker: 'w-4', base: 'http://w-4:8080' },
  ]

  it('keeps the answers of the workers that answered and names the others', async () => {
    const out = await fanOut(targets, async (target) => {
      if (target.worker === 'w-2') throw new HttpError('GET', '/debug/trace', 404, '')
      if (target.worker === 'w-3') throw new TypeError('Failed to fetch')
      if (target.worker === 'w-4') throw new HttpError('GET', '/debug/trace', 500, 'boom')
      return [target.worker]
    })

    expect(out.results).toEqual([{ worker: 'w-1', base: '', value: ['w-1'] }])
    expect(out.unreachable).toEqual([
      { worker: 'w-2', reason: 'not available on this worker' },
      { worker: 'w-3', reason: 'unreachable' },
      { worker: 'w-4', reason: 'HTTP 500' },
    ])
  })

  it('gives up on a worker that does not answer in time and keeps the rest', async () => {
    vi.useFakeTimers()
    const pending = fanOut(
      targets.slice(0, 2),
      (target, signal) =>
        target.worker === 'w-1'
          ? Promise.resolve('fast')
          : new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              )
            }),
      1000,
    )

    await vi.advanceTimersByTimeAsync(1000)
    const out = await pending

    expect(out.results.map((r) => r.value)).toEqual(['fast'])
    expect(out.unreachable).toEqual([{ worker: 'w-2', reason: 'timed out' }])
  })
})

describe('fanOut concurrency', () => {
  it('keeps at most `concurrency` calls in flight and the targets order', async () => {
    const targets: FanOutTarget[] = Array.from({ length: 14 }, (_, i) => ({
      worker: `w-${i}`,
      base: `http://w-${i}`,
    }))
    let inFlight = 0
    let peak = 0
    const answer = await fanOut(
      targets,
      async (t) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight--
        return t.worker
      },
      1000,
      6,
    )

    expect(peak).toBe(6)
    expect(answer.results.map((r) => r.value)).toEqual(targets.map((t) => t.worker))
  })

  it('defaults to 6 calls at once', async () => {
    const targets: FanOutTarget[] = Array.from({ length: 10 }, (_, i) => ({
      worker: `w-${i}`,
      base: `http://w-${i}`,
    }))
    let inFlight = 0
    let peak = 0
    await fanOut(targets, async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
    })

    expect(peak).toBe(6)
  })
})
