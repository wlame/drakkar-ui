import { describe, it, expect } from 'vitest'
import { distStats, numericLabelKeys, numericLabelValues, taskDurations } from './stats'
import type { TaskView } from './live'

function task(over: Partial<TaskView>): TaskView {
  return {
    task_id: 't',
    partition: 0,
    start_ts: 100,
    end_ts: 105,
    duration: 5,
    status: 'completed',
    exit_code: 0,
    args: null,
    pid: null,
    slot: 0,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
    stdout_size: null,
    stdout_lines: null,
    stdin_lines: null,
    stdin_size: null,
    env: null,
    source_offsets: null,
    spawn_ms: null,
    ...over,
  }
}

describe('distStats', () => {
  it('returns null for an empty sample', () => {
    expect(distStats([])).toBeNull()
  })

  it('collapses a single value onto every statistic', () => {
    expect(distStats([7])).toEqual({ count: 1, avg: 7, p50: 7, p90: 7, p99: 7 })
  })

  it('computes avg and interpolated percentiles', () => {
    const s = distStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(s).not.toBeNull()
    expect(s?.count).toBe(10)
    expect(s?.avg).toBeCloseTo(5.5)
    expect(s?.p50).toBeCloseTo(5.5)
    expect(s?.p90).toBeCloseTo(9.1)
    expect(s?.p99).toBeCloseTo(9.91)
  })

  it('does not mutate the input array', () => {
    const values = [3, 1, 2]
    distStats(values)
    expect(values).toEqual([3, 1, 2])
  })
})

describe('taskDurations', () => {
  it('takes finished tasks only, skipping running ones and null durations', () => {
    const durations = taskDurations([
      task({ duration: 1 }),
      task({ duration: 2, status: 'failed' }),
      task({ duration: null, status: 'running', end_ts: null }),
      task({ duration: null }),
    ])
    expect(durations).toEqual([1, 2])
  })
})

describe('numericLabelValues', () => {
  const tasks = [
    task({ labels: { file_size_bytes: '20480', request: '0:41' } }),
    task({ labels: { file_size_bytes: ' 512 ' } }),
    task({ labels: { file_size_bytes: '1.2K' } }),
    task({ labels: { other: '3' } }),
    task({ labels: null }),
  ]

  it('parses strictly: whole-string numbers only, whitespace tolerated', () => {
    expect(numericLabelValues(tasks, 'file_size_bytes')).toEqual([20480, 512])
  })

  it('never treats an empty or non-numeric value as zero', () => {
    expect(numericLabelValues([task({ labels: { k: '' } })], 'k')).toEqual([])
    expect(numericLabelValues([task({ labels: { k: '0:41' } })], 'k')).toEqual([])
  })
})

describe('numericLabelKeys', () => {
  it('lists keys with at least one numeric value, sorted', () => {
    const keys = numericLabelKeys([
      task({ labels: { zeta: '1', request: '0:41' } }),
      task({ labels: { alpha: '2.5', name: 'file.csv' } }),
    ])
    expect(keys).toEqual(['alpha', 'zeta'])
  })
})
