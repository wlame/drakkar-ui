import { describe, it, expect } from 'vitest'
import { dueJobs, type PollJob } from './schedule'

// The job set the Dashboard actually runs, kept in step with Dashboard.svelte.
const JOBS: PollJob[] = [
  { name: 'sinks', everyTicks: 4, offsetTicks: 4 },
  { name: 'dashboard', everyTicks: 10, offsetTicks: 11 },
  { name: 'partitions', everyTicks: 10, offsetTicks: 13 },
]

describe('dueJobs', () => {
  it('fires a job on its offset tick', () => {
    expect(dueJobs(JOBS, 4)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 11)).toEqual(['dashboard'])
    expect(dueJobs(JOBS, 13)).toEqual(['partitions'])
  })

  it('repeats a job every everyTicks after its offset', () => {
    expect(dueJobs(JOBS, 8)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 12)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 21)).toEqual(['dashboard'])
    expect(dueJobs(JOBS, 23)).toEqual(['partitions'])
  })

  it('never fires a job before its offset tick', () => {
    expect(dueJobs(JOBS, 2)).toEqual([])
    // partitions has offset 13, so tick 3 must not match even though
    // (3 - 13) % 10 is 0 in a language with a truncating modulo.
    expect(dueJobs(JOBS, 3)).not.toContain('partitions')
  })

  it('fires nothing before tick 4 for the default job set', () => {
    // The page fills itself once on mount; every offset sits a full period
    // past that, so the first scheduled run cannot re-fetch what it just got.
    for (let t = 0; t < 4; t++) {
      expect(dueJobs(JOBS, t)).toEqual([])
    }
    expect(dueJobs(JOBS, 4)).toEqual(['sinks'])
  })

  it('returns an empty list on a tick where nothing is due', () => {
    expect(dueJobs(JOBS, 5)).toEqual([])
    expect(dueJobs(JOBS, 6)).toEqual([])
    expect(dueJobs(JOBS, 14)).toEqual([])
  })

  it('never puts two jobs on the same tick for the default job set', () => {
    // The offsets are chosen so the three jobs cannot collide: sinks is always
    // on an even tick, dashboard on ticks ≡ 1 (mod 10), partitions on ≡ 3.
    for (let t = 0; t < 200; t++) {
      expect(dueJobs(JOBS, t).length).toBeLessThanOrEqual(1)
    }
  })

  it('handles an empty job list', () => {
    expect(dueJobs([], 7)).toEqual([])
  })

  it.each([0, -1, 2.5, NaN])('rejects everyTicks=%s instead of silently never firing', (every) => {
    const bad: PollJob[] = [{ name: 'broken', everyTicks: every, offsetTicks: 0 }]
    expect(() => dueJobs(bad, 0)).toThrow(/broken/)
  })
})
