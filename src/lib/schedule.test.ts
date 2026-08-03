import { describe, it, expect } from 'vitest'
import { dueJobs, type PollJob } from './schedule'

const JOBS: PollJob[] = [
  { name: 'sinks', everyTicks: 4, offsetTicks: 0 },
  { name: 'dashboard', everyTicks: 10, offsetTicks: 1 },
  { name: 'partitions', everyTicks: 10, offsetTicks: 3 },
]

describe('dueJobs', () => {
  it('fires a job on its offset tick', () => {
    expect(dueJobs(JOBS, 0)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 1)).toEqual(['dashboard'])
    expect(dueJobs(JOBS, 3)).toEqual(['partitions'])
  })

  it('repeats a job every everyTicks after its offset', () => {
    expect(dueJobs(JOBS, 4)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 8)).toEqual(['sinks'])
    expect(dueJobs(JOBS, 11)).toEqual(['dashboard'])
    expect(dueJobs(JOBS, 13)).toEqual(['partitions'])
  })

  it('never fires a job before its offset tick', () => {
    expect(dueJobs(JOBS, 2)).toEqual([])
    // partitions has offset 3, so tick 2 must not match even though
    // (2 - 3) % 10 is non-zero only by sign in some languages.
    expect(dueJobs(JOBS, 2)).not.toContain('partitions')
  })

  it('returns an empty list on a tick where nothing is due', () => {
    expect(dueJobs(JOBS, 2)).toEqual([])
    expect(dueJobs(JOBS, 5)).toEqual([])
    expect(dueJobs(JOBS, 6)).toEqual([])
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
})
