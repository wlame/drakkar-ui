import { describe, it, expect } from 'vitest'
import { COLOR, EVENT_COLORS, EVENT_TYPES, eventColor, statusColor, durationColor } from './events'

describe('eventColor', () => {
  it('maps known recorder events to their accent color', () => {
    expect(eventColor('consumed')).toBe(COLOR.blue)
    expect(eventColor('task_failed')).toBe(COLOR.red)
    expect(eventColor('produced')).toBe(COLOR.magenta)
    expect(eventColor('committed')).toBe(COLOR.gray)
  })

  it('falls back to muted gray for unknown events', () => {
    expect(eventColor('brand_new_event')).toBe(COLOR.gray)
    expect(eventColor('')).toBe(COLOR.gray)
  })

  it('covers every History filter type (the two tables cannot drift)', () => {
    for (const t of EVENT_TYPES) {
      expect(EVENT_COLORS, `missing color for ${t}`).toHaveProperty(t)
    }
  })
})

describe('statusColor', () => {
  it('maps the three live statuses', () => {
    expect(statusColor('completed')).toBe(COLOR.emerald)
    expect(statusColor('failed')).toBe(COLOR.red)
    expect(statusColor('running')).toBe(COLOR.amber)
  })

  it('mutes everything else, including nullish', () => {
    expect(statusColor('unknown')).toBe(COLOR.gray)
    expect(statusColor(null)).toBe(COLOR.gray)
    expect(statusColor(undefined)).toBe(COLOR.gray)
  })
})

describe('durationColor', () => {
  it('flags slow durations at the >1s and >0.1s thresholds', () => {
    expect(durationColor(1.01)).toBe(COLOR.red)
    expect(durationColor(0.2)).toBe(COLOR.amber)
    expect(durationColor(0.05)).toBe(COLOR.emerald)
  })

  it('treats the thresholds themselves as the slower bucket boundary (exclusive)', () => {
    expect(durationColor(1)).toBe(COLOR.amber) // 1s is not > 1s
    expect(durationColor(0.1)).toBe(COLOR.emerald) // 0.1s is not > 0.1s
    expect(durationColor(0)).toBe(COLOR.emerald)
  })

  it('mutes nullish durations', () => {
    expect(durationColor(null)).toBe(COLOR.gray)
    expect(durationColor(undefined)).toBe(COLOR.gray)
  })
})
