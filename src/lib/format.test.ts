import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  fmtTime,
  fmtTimeMs,
  fmtTimeFull,
  fmtDateTimeMs,
  durSec,
  dur2,
  dur3,
  fmtLatency,
  fmtBytes,
  fmtUptime,
  fmtAgo,
  safeJsonParse,
} from './format'

// 2024-01-02 03:04:05.678 UTC — epoch seconds (contract) and milliseconds (cache).
const TS_MS = Date.UTC(2024, 0, 2, 3, 4, 5, 678)
const TS_SEC = TS_MS / 1000

describe('fmtTime', () => {
  it('renders epoch seconds as UTC HH:MM:SS', () => {
    expect(fmtTime(TS_SEC)).toBe('03:04:05')
  })

  it('renders the epoch itself', () => {
    expect(fmtTime(0)).toBe('00:00:00')
  })

  it('is empty for nullish input', () => {
    expect(fmtTime(null)).toBe('')
    expect(fmtTime(undefined)).toBe('')
  })
})

describe('fmtTimeMs', () => {
  it('keeps millisecond precision', () => {
    expect(fmtTimeMs(TS_SEC)).toBe('03:04:05.678')
  })

  it('is empty for nullish input', () => {
    expect(fmtTimeMs(null)).toBe('')
  })
})

describe('fmtTimeFull', () => {
  it('renders UTC date + time with milliseconds', () => {
    expect(fmtTimeFull(TS_SEC)).toBe('2024-01-02 03:04:05.678')
  })

  it('is empty for nullish input', () => {
    expect(fmtTimeFull(undefined)).toBe('')
  })
})

describe('fmtDateTimeMs', () => {
  it('renders epoch milliseconds without the fractional part', () => {
    expect(fmtDateTimeMs(TS_MS)).toBe('2024-01-02 03:04:05')
  })

  it('is a dash for nullish input', () => {
    expect(fmtDateTimeMs(null)).toBe('-')
  })
})

describe('durSec', () => {
  it('renders sub-second durations as whole milliseconds', () => {
    expect(durSec(0.5)).toBe('500ms')
    expect(durSec(0.9994)).toBe('999ms')
    expect(durSec(0)).toBe('0ms')
  })

  it('renders one second and above with two decimals', () => {
    expect(durSec(1)).toBe('1.00s')
    expect(durSec(2.346)).toBe('2.35s')
  })

  it('is a dash for nullish input', () => {
    expect(durSec(null)).toBe('-')
    expect(durSec(undefined)).toBe('-')
  })
})

describe('dur2 / dur3', () => {
  it('fixes to two and three decimals respectively', () => {
    expect(dur2(1.234)).toBe('1.23s')
    expect(dur3(0.1234)).toBe('0.123s')
  })

  it('is a dash for nullish input', () => {
    expect(dur2(null)).toBe('-')
    expect(dur3(undefined)).toBe('-')
  })
})

describe('fmtLatency', () => {
  it('scales ms → s → m at the 1s and 60s boundaries', () => {
    expect(fmtLatency(0.25)).toBe('250ms')
    expect(fmtLatency(1)).toBe('1.0s')
    expect(fmtLatency(59.94)).toBe('59.9s')
    expect(fmtLatency(60)).toBe('1.0m')
    expect(fmtLatency(90)).toBe('1.5m')
  })

  it('never scales past minutes', () => {
    expect(fmtLatency(3600)).toBe('60.0m')
  })

  it('is a dash for nullish input', () => {
    expect(fmtLatency(null)).toBe('-')
  })
})

describe('fmtBytes', () => {
  it('renders bytes below 1 KiB unscaled', () => {
    expect(fmtBytes(0)).toBe('0 B')
    expect(fmtBytes(1023)).toBe('1023 B')
  })

  it('scales KB and MB with one decimal', () => {
    expect(fmtBytes(1024)).toBe('1.0 KB')
    expect(fmtBytes(1536)).toBe('1.5 KB')
    expect(fmtBytes(1024 * 1024)).toBe('1.0 MB')
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })

  it('is a dash for nullish input', () => {
    expect(fmtBytes(null)).toBe('-')
  })
})

describe('fmtUptime', () => {
  it('floors fractional seconds', () => {
    expect(fmtUptime(59.9)).toBe('59s')
  })

  it('uses the two largest units at each scale', () => {
    expect(fmtUptime(0)).toBe('0s')
    expect(fmtUptime(90)).toBe('1m 30s')
    expect(fmtUptime(3600)).toBe('1h 0m')
    expect(fmtUptime(2 * 3600 + 35 * 60)).toBe('2h 35m')
    expect(fmtUptime(86400 + 3 * 3600)).toBe('1d 3h')
    expect(fmtUptime(45 * 86400)).toBe('1mo 15d')
    expect(fmtUptime(400 * 86400)).toBe('1y 1mo')
  })
})

describe('fmtAgo', () => {
  const NOW = new Date('2024-01-02T00:00:00Z')
  const nowSec = NOW.getTime() / 1000

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the most significant unit', () => {
    expect(fmtAgo(nowSec - 30)).toBe('30s ago')
    expect(fmtAgo(nowSec - 90)).toBe('1m ago')
    expect(fmtAgo(nowSec - 7200)).toBe('2h ago')
    expect(fmtAgo(nowSec - 3 * 86400)).toBe('3d ago')
  })

  it('is a dash for nullish or zero timestamps', () => {
    expect(fmtAgo(null)).toBe('-')
    expect(fmtAgo(undefined)).toBe('-')
    expect(fmtAgo(0)).toBe('-')
  })
})

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 })
    expect(safeJsonParse('[1,2]', [])).toEqual([1, 2])
  })

  it('returns the fallback for malformed JSON', () => {
    expect(safeJsonParse('not json', { fb: true })).toEqual({ fb: true })
  })

  it('returns the fallback for nullish input', () => {
    expect(safeJsonParse(null, 'fb')).toBe('fb')
    expect(safeJsonParse(undefined, 'fb')).toBe('fb')
  })

  it('passes a parsed JSON null through (only nullish INPUT hits the fallback)', () => {
    expect(safeJsonParse<string | null>('null', 'fb')).toBeNull()
  })
})
