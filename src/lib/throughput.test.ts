import { describe, expect, it } from 'vitest'
import {
  fmtCost,
  fmtSpeed,
  pushThroughputSample,
  sampleAt,
  throughputFromEvent,
} from './throughput'

function frame(ts: number, value = 100) {
  const win = (v: number) => ({ throughput: v, task_rate: 1.5, tasks: 9 })
  return {
    ts,
    metadata: JSON.stringify({
      windows: {
        '1': win(value),
        '5': win(value),
        '30': win(value),
        '60': win(value),
        '300': win(value),
      },
    }),
  }
}

describe('throughputFromEvent', () => {
  it('parses a full frame', () => {
    const sample = throughputFromEvent(frame(1700000000, 41.25e6))
    expect(sample).not.toBeNull()
    expect(sample?.ts).toBe(1700000000)
    expect(sample?.windows['60']).toEqual({ throughput: 41.25e6, task_rate: 1.5, tasks: 9 })
  })

  it('rejects frames missing a pinned window', () => {
    const partial = {
      ts: 1,
      metadata: JSON.stringify({ windows: { '1': { throughput: 1, task_rate: 1, tasks: 1 } } }),
    }
    expect(throughputFromEvent(partial)).toBeNull()
  })

  it('rejects malformed metadata and window entries', () => {
    expect(throughputFromEvent({ ts: 1, metadata: 'not json' })).toBeNull()
    expect(throughputFromEvent({ ts: 1, metadata: null })).toBeNull()
    const badEntry = {
      ts: 1,
      metadata: JSON.stringify({
        windows: { '1': 'oops', '5': {}, '30': {}, '60': {}, '300': {} },
      }),
    }
    expect(throughputFromEvent(badEntry)).toBeNull()
  })
})

describe('pushThroughputSample', () => {
  it('appends and trims past the max age', () => {
    let samples = [throughputFromEvent(frame(1000))!, throughputFromEvent(frame(1500))!]
    samples = pushThroughputSample(samples, throughputFromEvent(frame(2000))!, 600)
    expect(samples.map((s) => s.ts)).toEqual([1500, 2000])
  })
})

describe('sampleAt', () => {
  const samples = [frame(100), frame(200), frame(300)].map((f) => throughputFromEvent(f)!)

  it('returns the newest sample at or before the timestamp', () => {
    expect(sampleAt(samples, 250)?.ts).toBe(200)
    expect(sampleAt(samples, 300)?.ts).toBe(300)
  })

  it('returns null before the first sample', () => {
    expect(sampleAt(samples, 50)).toBeNull()
  })
})

describe('fmtCost / fmtSpeed', () => {
  it('uses SI suffixes with one decimal', () => {
    expect(fmtCost(41_250_000)).toBe('41.3M')
    expect(fmtCost(950_000)).toBe('950.0k')
    expect(fmtCost(2_500_000_000)).toBe('2.5G')
    expect(fmtCost(12)).toBe('12')
    expect(fmtCost(0.5)).toBe('0.5')
    expect(fmtSpeed(4_194_304)).toBe('4.2M/s')
  })
})
