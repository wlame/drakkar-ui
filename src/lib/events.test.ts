import { describe, it, expect } from 'vitest'
import {
  COLOR,
  EVENT_COLORS,
  EVENT_TYPES,
  durationColor,
  eventColor,
  parseAnnotation,
  statusColor,
} from './events'

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

describe('parseAnnotation', () => {
  const envelope = JSON.stringify({
    kind: 'input_selection',
    scope: 'message',
    hook: 'arrange',
    window_id: 7,
    offsets: [90, 91],
    data: { candidates: ['a', 'b'] },
  })

  it('reads the envelope from an annotation row', () => {
    const ann = parseAnnotation('annotation', envelope)
    expect(ann).not.toBeNull()
    expect(ann!.kind).toBe('input_selection')
    expect(ann!.scope).toBe('message')
    expect(ann!.hook).toBe('arrange')
    expect(ann!.window_id).toBe(7)
    expect(ann!.offsets).toEqual([90, 91])
    expect(ann!.data).toEqual({ candidates: ['a', 'b'] })
  })

  it('ignores rows that are not annotations', () => {
    expect(parseAnnotation('task_started', envelope)).toBeNull()
  })

  it('returns null for absent or malformed metadata', () => {
    expect(parseAnnotation('annotation', null)).toBeNull()
    expect(parseAnnotation('annotation', '')).toBeNull()
    expect(parseAnnotation('annotation', 'not json')).toBeNull()
    expect(parseAnnotation('annotation', '[]')).toBeNull()
    expect(parseAnnotation('annotation', '{"scope":"message"}')).toBeNull()
  })

  it('fills defaults for fields an older or newer backend omitted', () => {
    const ann = parseAnnotation('annotation', '{"kind":"k"}')
    expect(ann).toEqual({
      kind: 'k',
      scope: 'window',
      hook: '',
      window_id: null,
      offsets: [],
      data: {},
    })
  })

  it('passes through an unknown future scope rather than rejecting the row', () => {
    const ann = parseAnnotation('annotation', '{"kind":"k","scope":"partition"}')
    expect(ann!.scope).toBe('partition')
  })
})
