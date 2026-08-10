import { describe, expect, it } from 'vitest'

import {
  TIMELINE_PALETTE,
  barColorFor,
  evalCondition,
  legendEntries,
  ruleHex,
} from './timelineRules'
import type { TimelineColorRule, TimelineCondition } from './types'
import type { TaskView } from './live'

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    task_id: 't1',
    partition: 0,
    start_ts: 1000,
    end_ts: 1005,
    duration: 5,
    status: 'completed',
    exit_code: 0,
    args: null,
    pid: null,
    slot: null,
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
    ...overrides,
  }
}

describe('evalCondition — label vs field targeting', () => {
  it('reads a label target from task.labels', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'eq', value: 'scanner' })).toBe(true)
  })

  it('reads a field target from the task itself', () => {
    const t = task({ status: 'failed' })
    expect(evalCondition(t, { field: 'status', op: 'eq', value: 'failed' })).toBe(true)
  })

  it('treats a missing label key as absent', () => {
    const t = task({ labels: { other: 'x' } })
    expect(evalCondition(t, { label: 'module', op: 'eq', value: 'x' })).toBe(false)
  })

  it('treats null labels map as absent for any label condition', () => {
    const t = task({ labels: null })
    expect(evalCondition(t, { label: 'module', op: 'exists' })).toBe(false)
  })
})

describe('evalCondition — exists / missing', () => {
  it('exists is true when the label is present', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'exists' })).toBe(true)
  })

  it('exists is false when the field is null', () => {
    const t = task({ exit_code: null })
    expect(evalCondition(t, { field: 'exit_code', op: 'exists' })).toBe(false)
  })

  it('missing is true when the field is null', () => {
    const t = task({ exit_code: null })
    expect(evalCondition(t, { field: 'exit_code', op: 'missing' })).toBe(true)
  })

  it('missing is false when the label is present', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'missing' })).toBe(false)
  })

  it('every other op fails on an absent value', () => {
    const t = task({ labels: {} })
    const ops = ['eq', 'ne', 'contains', 'prefix', 'gt', 'ge', 'lt', 'le']
    for (const op of ops) {
      expect(evalCondition(t, { label: 'gone', op, value: 'x' })).toBe(false)
    }
  })
})

describe('evalCondition — gt/ge/lt/le', () => {
  it('compares numerically via parseFloat on both sides', () => {
    const t = task({ labels: { file_size_bytes: '20000' } })
    expect(evalCondition(t, { label: 'file_size_bytes', op: 'gt', value: 10240 })).toBe(true)
    expect(evalCondition(t, { label: 'file_size_bytes', op: 'ge', value: 20000 })).toBe(true)
    expect(evalCondition(t, { label: 'file_size_bytes', op: 'lt', value: 20000 })).toBe(false)
    expect(evalCondition(t, { label: 'file_size_bytes', op: 'le', value: 20000 })).toBe(true)
  })

  it('numeric-label rule matches a parseable string and rejects an unparseable one', () => {
    const cond: TimelineCondition = { label: 'file_size_bytes', op: 'gt', value: 10240 }
    expect(evalCondition(task({ labels: { file_size_bytes: '20000' } }), cond)).toBe(true)
    expect(evalCondition(task({ labels: { file_size_bytes: 'oops' } }), cond)).toBe(false)
  })

  it('returns false when either side fails to parse as a number', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'gt', value: 5 })).toBe(false)
    expect(
      evalCondition(task({ duration: 5 }), { field: 'duration', op: 'gt', value: 'oops' }),
    ).toBe(false)
  })
})

describe('evalCondition — eq/ne', () => {
  it('compares numerically when both sides parse as finite numbers', () => {
    const t = task({ stdout_size: 0 })
    expect(evalCondition(t, { field: 'stdout_size', op: 'eq', value: 0 })).toBe(true)
    expect(evalCondition(t, { field: 'stdout_size', op: 'ne', value: 0 })).toBe(false)
  })

  it('stdout_size eq 0 matches a completed task and not a running task with null stdout_size', () => {
    const cond: TimelineCondition = { field: 'stdout_size', op: 'eq', value: 0 }
    expect(evalCondition(task({ status: 'completed', stdout_size: 0 }), cond)).toBe(true)
    expect(evalCondition(task({ status: 'running', stdout_size: null }), cond)).toBe(false)
  })

  it('falls back to strict string compare when either side is non-numeric', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'eq', value: 'scanner' })).toBe(true)
    expect(evalCondition(t, { label: 'module', op: 'eq', value: 'Scanner' })).toBe(false)
    expect(evalCondition(t, { label: 'module', op: 'ne', value: 'other' })).toBe(true)
  })

  it('ne is false for a numerically-equal pair', () => {
    const t = task({ stdout_size: 0 })
    expect(evalCondition(t, { field: 'stdout_size', op: 'ne', value: 0 })).toBe(false)
  })

  it('ne is true for a differing string pair', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'ne', value: 'other' })).toBe(true)
  })

  it('ne is the exact negation of eq', () => {
    const t = task({ labels: { module: 'scanner' } })
    for (const value of ['scanner', 'other', 5, '5']) {
      expect(evalCondition(t, { label: 'module', op: 'ne', value })).toBe(
        !evalCondition(t, { label: 'module', op: 'eq', value }),
      )
    }
  })
})

describe('evalCondition — contains/prefix', () => {
  it('contains is case-sensitive substring match', () => {
    const t = task({ labels: { module: 'ripgrep-scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'contains', value: 'grep' })).toBe(true)
    expect(evalCondition(t, { label: 'module', op: 'contains', value: 'Grep' })).toBe(false)
  })

  it('prefix is case-sensitive startsWith match', () => {
    const t = task({ labels: { module: 'ripgrep-scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'prefix', value: 'ripgrep' })).toBe(true)
    expect(evalCondition(t, { label: 'module', op: 'prefix', value: 'Ripgrep' })).toBe(false)
  })
})

describe('evalCondition — unknown op', () => {
  it('returns false rather than throwing on an unrecognized op', () => {
    const t = task({ labels: { module: 'scanner' } })
    expect(evalCondition(t, { label: 'module', op: 'regex', value: 'sc.*' })).toBe(false)
  })
})

describe('barColorFor', () => {
  it('returns the color of the first matching rule', () => {
    const rules: TimelineColorRule[] = [
      {
        name: 'empty output',
        when: [{ field: 'stdout_size', op: 'eq', value: 0 }],
        color: 'lightgray',
      },
      {
        name: 'big file',
        when: [{ label: 'file_size_bytes', op: 'gt', value: 10240 }],
        color: 'blue',
      },
    ]
    const t = task({ stdout_size: 0, labels: { file_size_bytes: '20000' } })
    expect(barColorFor(t, rules)).toBe(TIMELINE_PALETTE.lightgray)
  })

  it('requires every condition in `when` to match (AND)', () => {
    const rules: TimelineColorRule[] = [
      {
        name: 'big finished file',
        when: [
          { label: 'file_size_bytes', op: 'gt', value: 10240 },
          { field: 'status', op: 'eq', value: 'completed' },
        ],
        color: 'blue',
      },
    ]
    const runningBigFile = task({ status: 'running', labels: { file_size_bytes: '20000' } })
    // Not blue (the rule needs status:completed too) — falls through to the
    // implicit status fallback for a running, non-http task: yellow.
    expect(barColorFor(runningBigFile, rules)).toBe(TIMELINE_PALETTE.yellow)

    const completedBigFile = task({ status: 'completed', labels: { file_size_bytes: '20000' } })
    expect(barColorFor(completedBigFile, rules)).toBe(TIMELINE_PALETTE.blue)
  })

  it('falls back to the http origin color when no rule matches', () => {
    const t = task({ origin: 'http', status: 'completed' })
    expect(barColorFor(t, [])).toBe('#9c27b0')
  })

  it('falls back to status colors when no rule matches and origin is not http', () => {
    expect(barColorFor(task({ origin: 'kafka', status: 'completed' }), [])).toBe(
      TIMELINE_PALETTE.green,
    )
    expect(barColorFor(task({ origin: 'kafka', status: 'failed' }), [])).toBe(TIMELINE_PALETTE.red)
    expect(barColorFor(task({ origin: 'kafka', status: 'running' }), [])).toBe(
      TIMELINE_PALETTE.yellow,
    )
  })

  it('prefers an explicit rule match over the implicit http fallback', () => {
    const rules: TimelineColorRule[] = [
      { name: '', when: [{ field: 'origin', op: 'eq', value: 'http' }], color: 'purple' },
    ]
    const t = task({ origin: 'http' })
    expect(barColorFor(t, rules)).toBe(TIMELINE_PALETTE.purple)
  })
})

describe('ruleHex', () => {
  it('maps every palette name to its exact hex', () => {
    expect(ruleHex('green')).toBe('#34d399')
    expect(ruleHex('red')).toBe('#f87171')
    expect(ruleHex('yellow')).toBe('#fbbf24')
    expect(ruleHex('blue')).toBe('#60a5fa')
    expect(ruleHex('gray')).toBe('#9ca3af')
    expect(ruleHex('lightgray')).toBe('#d1d5db')
    expect(ruleHex('purple')).toBe('#a78bfa')
    expect(ruleHex('orange')).toBe('#fb923c')
  })

  it('passes a #rrggbb hex through unchanged', () => {
    expect(ruleHex('#123abc')).toBe('#123abc')
  })

  it('falls back to gray for an unrecognized color', () => {
    expect(ruleHex('bogus')).toBe('#9ca3af')
  })
})

describe('legendEntries', () => {
  it('uses the rule name when present', () => {
    const rules: TimelineColorRule[] = [
      {
        name: 'empty output',
        when: [{ field: 'stdout_size', op: 'eq', value: 0 }],
        color: 'lightgray',
      },
    ]
    expect(legendEntries(rules)).toEqual([{ label: 'empty output', color: '#d1d5db' }])
  })

  it('generates condition text for an unnamed rule', () => {
    const rules: TimelineColorRule[] = [
      { name: '', when: [{ field: 'stdout_size', op: 'eq', value: 0 }], color: 'lightgray' },
    ]
    expect(legendEntries(rules)).toEqual([{ label: 'stdout_size eq 0', color: '#d1d5db' }])
  })

  it('generates condition text keyed on the label name for an unnamed label rule', () => {
    const rules: TimelineColorRule[] = [
      { name: '', when: [{ label: 'file_size_bytes', op: 'gt', value: 10240 }], color: 'blue' },
    ]
    expect(legendEntries(rules)).toEqual([{ label: 'file_size_bytes gt 10240', color: '#60a5fa' }])
  })

  it('maps colors through ruleHex, including unrecognized names', () => {
    const rules: TimelineColorRule[] = [{ name: 'weird', when: [], color: 'bogus' }]
    expect(legendEntries(rules)).toEqual([{ label: 'weird', color: '#9ca3af' }])
  })
})
