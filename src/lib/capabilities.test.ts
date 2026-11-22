// Capability checks (contract v1.28): a missing key always means "on".
import { describe, expect, it } from 'vitest'
import {
  isAutodiscoverOn,
  isHistorySearchOn,
  isRecorderOff,
  isSplitEnabled,
  memoryWindowNote,
  splitPartsBase,
} from './capabilities'
import type { Capabilities } from './types'

describe('capability checks without capabilities', () => {
  it.each([null, undefined, {}])('treat %j as everything on', (caps) => {
    expect(isAutodiscoverOn(caps)).toBe(true)
    expect(isHistorySearchOn(caps)).toBe(true)
    expect(isRecorderOff(caps)).toBe(false)
    expect(memoryWindowNote(caps)).toBeNull()
  })
})

describe('capability checks with explicit values', () => {
  it('reads autodiscover.enabled', () => {
    expect(isAutodiscoverOn({ autodiscover: { enabled: false } })).toBe(false)
    expect(isAutodiscoverOn({ autodiscover: { enabled: true } })).toBe(true)
  })

  it('reads recorder.history_search', () => {
    expect(isHistorySearchOn({ recorder: { history_search: false } })).toBe(false)
    expect(isHistorySearchOn({ recorder: { enabled: true, history_search: true } })).toBe(true)
  })

  it.each([
    [120, 'last 2 minutes, in memory'],
    [60, 'last 1 minute, in memory'],
    [90, 'last 90 seconds, in memory'],
  ])('words a %i second window as "%s" when the recorder is off', (seconds, note) => {
    expect(
      memoryWindowNote({ recorder: { enabled: false }, memory: { window_seconds: seconds } }),
    ).toBe(note)
  })

  it('assumes two minutes when the memory window is not reported', () => {
    expect(memoryWindowNote({ recorder: { enabled: false } })).toBe('last 2 minutes, in memory')
  })

  it('gives no note while the recorder runs', () => {
    expect(
      memoryWindowNote({ recorder: { enabled: true }, memory: { window_seconds: 120 } }),
    ).toBeNull()
  })
})

describe('split capability', () => {
  it('is off when the key is missing, unlike the other capabilities', () => {
    expect(isSplitEnabled(null)).toBe(false)
    expect(isSplitEnabled({} as Capabilities)).toBe(false)
    expect(splitPartsBase({} as Capabilities)).toBeNull()
  })

  it('is on only when enabled, and gives the parts base', () => {
    const on = {
      split: { enabled: true, parts_topic: 'p', results_topic: 'r', parts_partition_base: 1000000 },
    } as Capabilities
    expect(isSplitEnabled(on)).toBe(true)
    expect(splitPartsBase(on)).toBe(1000000)
    const off = {
      split: { enabled: false, parts_topic: null, results_topic: null, parts_partition_base: null },
    } as Capabilities
    expect(isSplitEnabled(off)).toBe(false)
    expect(splitPartsBase(off)).toBeNull()
  })
})
