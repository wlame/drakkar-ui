import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clusterEvents,
  eventContentKey,
  EVENT_LABEL_PX_PER_CHAR,
  eventFromWsEvent,
  eventGeometry,
  eventsFromHistory,
  layoutTrack,
  loadEventVisibility,
  matchesEventMatch,
  qualifyingEventTracks,
  resolveEventLink,
  resolveEventVisibility,
  saveEventVisibility,
  trackHeight,
  TRACK_BASE_HEIGHT_PX,
  TRACK_TALL_HEIGHT_PX,
  trimLabelForVertical,
  VERTICAL_LABEL_MAX_CHARS,
  withUniqueKeys,
  type TimelineEventView,
} from './timelineEvents'
import type { TimelineEventDecl, WsEvent } from './types'
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
    spawn_ms: null,
    queue_wait_ms: null,
    ...overrides,
  }
}

function wsEvent(overrides: Partial<WsEvent> = {}): WsEvent {
  return {
    event: 'annotation',
    ts: 1000,
    partition: 0,
    ...overrides,
  }
}

function eventView(overrides: Partial<TimelineEventView> = {}): TimelineEventView {
  return {
    type: 'deployment_marker',
    ts: 1000,
    endTs: null,
    text: 'v2.1 deployed',
    values: {},
    match: null,
    partition: 0,
    ...overrides,
  }
}

const decl = (overrides: Partial<TimelineEventDecl> = {}): TimelineEventDecl => ({
  name: 'deployment_marker',
  kind: 'marker',
  color: 'purple',
  show: true,
  action: 'none',
  ...overrides,
})

describe('eventFromWsEvent', () => {
  const envelope = (data: Record<string, unknown>) =>
    JSON.stringify({
      kind: 'timeline_event',
      scope: 'window',
      hook: 'on_message_complete',
      window_id: 41,
      offsets: [1200, 1201],
      data,
    })

  it('parses a point event from an annotation WS frame', () => {
    const e = wsEvent({
      partition: 2,
      metadata: envelope({
        type: 'deployment_marker',
        ts_ms: 1756350000000,
        end_ts_ms: null,
        text: 'v2.1 deployed',
        values: { sha: 'ab12f' },
        match: null,
      }),
    })
    expect(eventFromWsEvent(e)).toEqual({
      type: 'deployment_marker',
      ts: 1756350000,
      endTs: null,
      text: 'v2.1 deployed',
      values: { sha: 'ab12f' },
      match: null,
      partition: 2,
    })
  })

  it('parses a range event with a non-null end_ts_ms', () => {
    const e = wsEvent({
      metadata: envelope({
        type: 'maintenance_window',
        ts_ms: 1000000,
        end_ts_ms: 1005000,
        text: 'window',
        values: {},
        match: null,
      }),
    })
    const ev = eventFromWsEvent(e)
    expect(ev?.ts).toBe(1000)
    expect(ev?.endTs).toBe(1005)
  })

  it('parses the three match variants', () => {
    const windowMatch = eventFromWsEvent(
      wsEvent({
        metadata: envelope({ type: 't', ts_ms: 1000, match: { window_id: 41 } }),
      }),
    )
    expect(windowMatch?.match).toEqual({ window_id: 41 })

    const offsetsMatch = eventFromWsEvent(
      wsEvent({
        metadata: envelope({
          type: 't',
          ts_ms: 1000,
          match: {
            offsets: [
              [0, 1200],
              [0, 1201],
            ],
          },
        }),
      }),
    )
    expect(offsetsMatch?.match).toEqual({
      offsets: [
        [0, 1200],
        [0, 1201],
      ],
    })

    const labelMatch = eventFromWsEvent(
      wsEvent({
        metadata: envelope({ type: 't', ts_ms: 1000, match: { label: ['request', 'req-123'] } }),
      }),
    )
    expect(labelMatch?.match).toEqual({ label: ['request', 'req-123'] })
  })

  it('returns null for a non-annotation event', () => {
    const e = wsEvent({ event: 'task_started', metadata: envelope({ type: 't', ts_ms: 1000 }) })
    expect(eventFromWsEvent(e)).toBeNull()
  })

  it('returns null for absent metadata', () => {
    expect(eventFromWsEvent(wsEvent({ metadata: undefined }))).toBeNull()
  })

  it('returns null for malformed metadata JSON', () => {
    expect(eventFromWsEvent(wsEvent({ metadata: 'not json' }))).toBeNull()
  })

  it('returns null when the envelope kind is not timeline_event', () => {
    const other = JSON.stringify({
      kind: 'input_selection',
      data: { type: 't', ts_ms: 1000 },
    })
    expect(eventFromWsEvent(wsEvent({ metadata: other }))).toBeNull()
  })

  it('returns null when data.type is missing', () => {
    expect(eventFromWsEvent(wsEvent({ metadata: envelope({ ts_ms: 1000 }) }))).toBeNull()
  })

  it('returns null when data.ts_ms is missing or not numeric', () => {
    expect(eventFromWsEvent(wsEvent({ metadata: envelope({ type: 't' }) }))).toBeNull()
    expect(
      eventFromWsEvent(wsEvent({ metadata: envelope({ type: 't', ts_ms: '1000' }) })),
    ).toBeNull()
  })

  it('returns null when data is missing or not an object', () => {
    const noData = JSON.stringify({ kind: 'timeline_event' })
    expect(eventFromWsEvent(wsEvent({ metadata: noData }))).toBeNull()
  })

  it('defaults text/values/partition when absent', () => {
    const e = wsEvent({ partition: undefined, metadata: envelope({ type: 't', ts_ms: 1000 }) })
    const ev = eventFromWsEvent(e)
    expect(ev?.text).toBe('')
    expect(ev?.values).toEqual({})
    expect(ev?.partition).toBe(-1)
  })
})

describe('eventsFromHistory', () => {
  function envelope(overrides: Record<string, unknown> = {}) {
    return {
      kind: 'timeline_event',
      scope: 'window',
      hook: 'on_message_complete',
      window_id: 41,
      offsets: [1200, 1201],
      data: { type: 'deployment_marker', ts_ms: 1756350000000, end_ts_ms: null, text: 'x' },
      ts: 1756350000.5,
      partition: 3,
      ...overrides,
    }
  }

  it('parses a valid {events, unavailable} payload', () => {
    const out = eventsFromHistory({ events: [envelope()], unavailable: false })
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({
      type: 'deployment_marker',
      ts: 1756350000,
      endTs: null,
      text: 'x',
      values: {},
      match: null,
      partition: 3,
    })
  })

  it('returns [] for garbage payloads', () => {
    expect(eventsFromHistory(null)).toEqual([])
    expect(eventsFromHistory(undefined)).toEqual([])
    expect(eventsFromHistory('nope')).toEqual([])
    expect(eventsFromHistory([])).toEqual([])
    expect(eventsFromHistory({})).toEqual([])
    expect(eventsFromHistory({ events: 'not-an-array' })).toEqual([])
  })

  it('skips individual malformed entries but keeps the valid ones', () => {
    const out = eventsFromHistory({
      events: [envelope(), { garbage: true }, envelope({ data: { type: 't2', ts_ms: 2000 } })],
    })
    expect(out).toHaveLength(2)
  })

  it('treats unavailable:true as still parseable (an empty events list)', () => {
    expect(eventsFromHistory({ events: [], unavailable: true })).toEqual([])
  })
})

describe('eventGeometry', () => {
  it('positions a point event with a null width', () => {
    const g = eventGeometry(eventView({ ts: 1010, endTs: null }), 1000, 8)
    expect(g).toEqual({ left: 80, width: null })
  })

  it('computes a range event width', () => {
    const g = eventGeometry(eventView({ ts: 1000, endTs: 1005 }), 990, 8)
    expect(g.left).toBe(80)
    expect(g.width).toBe(40)
  })

  it('clamps a very short range width to at least 1px', () => {
    const g = eventGeometry(eventView({ ts: 1000, endTs: 1000.01 }), 1000, 8)
    expect(g.width).toBe(1)
  })
})

describe('resolveEventLink', () => {
  const baseEv = eventView({
    ts: 1000,
    endTs: 1005,
    text: 'v2.1 deployed',
    values: { sha: 'ab12f' },
  })

  it('substitutes ts_ms, end_ts_ms, and linkBases raw, but percent-encodes text and values keys', () => {
    const link = decl({
      link: '{grafana}/d/deploys?from={ts_ms}&to={end_ts_ms}&text={text}&sha={sha}',
      action: 'link',
    })
    expect(resolveEventLink(link, baseEv, { grafana: 'https://g.example' })).toBe(
      'https://g.example/d/deploys?from=1000000&to=1005000&text=v2.1%20deployed&sha=ab12f',
    )
  })

  it('percent-encodes a values entry so it cannot inject query params or break the URL', () => {
    // A handler-supplied value containing "&", "#", and a space must not be
    // able to add its own query params, truncate the template into the
    // fragment, or otherwise corrupt the resolved URL.
    const ev = eventView({ values: { sha: 'abc&admin=1#frag with space' } })
    const link = decl({ link: '{grafana}/d/deploys?sha={sha}', action: 'link' })
    expect(resolveEventLink(link, ev, { grafana: 'https://g.example' })).toBe(
      'https://g.example/d/deploys?sha=abc%26admin%3D1%23frag%20with%20space',
    )
  })

  it('returns null when link is absent', () => {
    expect(resolveEventLink(decl({ link: undefined }), baseEv, {})).toBeNull()
  })

  it('returns null when a variable is unresolved', () => {
    const link = decl({ link: '{grafana}/x?missing={not_a_real_var}', action: 'link' })
    expect(resolveEventLink(link, baseEv, { grafana: 'https://g.example' })).toBeNull()
  })

  it('returns null when {end_ts_ms} is used but the event has no end', () => {
    const link = decl({ link: 'x?to={end_ts_ms}', action: 'link' })
    expect(resolveEventLink(link, eventView({ endTs: null }), {})).toBeNull()
  })
})

describe('matchesEventMatch', () => {
  it('window_id variant always returns false — TaskView carries no window id', () => {
    expect(matchesEventMatch(task(), { window_id: 41 })).toBe(false)
  })

  it('offsets variant matches on (task.partition, an entry in source_offsets)', () => {
    const t = task({ partition: 0, source_offsets: [1200, 1201] })
    expect(
      matchesEventMatch(t, {
        offsets: [
          [0, 1200],
          [0, 1201],
        ],
      }),
    ).toBe(true)
  })

  it('offsets variant is false when the partition matches but no offset does', () => {
    const t = task({ partition: 0, source_offsets: [9999] })
    expect(matchesEventMatch(t, { offsets: [[0, 1200]] })).toBe(false)
  })

  it('offsets variant is false when source_offsets is null', () => {
    const t = task({ partition: 0, source_offsets: null })
    expect(matchesEventMatch(t, { offsets: [[0, 1200]] })).toBe(false)
  })

  it('label variant matches on task.labels[key] === value', () => {
    const t = task({ labels: { request: 'req-123' } })
    expect(matchesEventMatch(t, { label: ['request', 'req-123'] })).toBe(true)
  })

  it('label variant is false on a mismatched value or missing labels', () => {
    expect(
      matchesEventMatch(task({ labels: { request: 'other' } }), { label: ['request', 'req-123'] }),
    ).toBe(false)
    expect(matchesEventMatch(task({ labels: null }), { label: ['request', 'req-123'] })).toBe(false)
  })
})

describe('visibility storage', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('loadEventVisibility returns {} when nothing is stored', () => {
    expect(loadEventVisibility('worker-a')).toEqual({})
  })

  it('round-trips a saved override through localStorage', () => {
    saveEventVisibility('worker-a', 'deployment_marker', false)
    expect(loadEventVisibility('worker-a')).toEqual({ deployment_marker: false })
  })

  it('accumulates multiple overrides for the same worker', () => {
    saveEventVisibility('worker-a', 'deployment_marker', false)
    saveEventVisibility('worker-a', 'maintenance_window', true)
    expect(loadEventVisibility('worker-a')).toEqual({
      deployment_marker: false,
      maintenance_window: true,
    })
  })

  it('keeps overrides for different workers independent', () => {
    saveEventVisibility('worker-a', 'deployment_marker', false)
    saveEventVisibility('worker-b', 'deployment_marker', true)
    expect(loadEventVisibility('worker-a')).toEqual({ deployment_marker: false })
    expect(loadEventVisibility('worker-b')).toEqual({ deployment_marker: true })
  })

  it('returns {} for corrupted JSON', () => {
    localStorage.setItem('dk.timeline.events.worker-a', '{not valid json')
    expect(loadEventVisibility('worker-a')).toEqual({})
  })

  describe('storage access failures (private-mode denial)', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('loadEventVisibility returns {} when getItem throws', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('denied')
      })
      expect(loadEventVisibility('worker-a')).toEqual({})
    })

    it('saveEventVisibility does not throw when setItem throws', () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('denied')
      })
      expect(() => saveEventVisibility('worker-a', 'deployment_marker', true)).not.toThrow()
    })
  })
})

describe('resolveEventVisibility', () => {
  it("defaults to each declaration's show flag when there is no override", () => {
    const decls = [decl({ name: 'a', show: true }), decl({ name: 'b', show: false })]
    expect(resolveEventVisibility(decls, {})).toEqual({ a: true, b: false })
  })

  it('an override takes precedence over the declared default', () => {
    const decls = [decl({ name: 'a', show: true })]
    expect(resolveEventVisibility(decls, { a: false })).toEqual({ a: false })
  })

  it('ignores overrides for names with no matching declaration', () => {
    const decls = [decl({ name: 'a', show: true })]
    expect(resolveEventVisibility(decls, { a: true, ghost: false })).toEqual({ a: true })
  })
})

describe('clusterEvents', () => {
  it('keeps far-apart items as separate single-member clusters', () => {
    const items = [{ left: 0 }, { left: 100 }, { left: 250 }]
    const clusters = clusterEvents(items, 12)
    expect(clusters).toHaveLength(3)
    expect(clusters.map((c) => c.members.length)).toEqual([1, 1, 1])
  })

  it('merges items within collapsePx of the cluster anchor into one cluster', () => {
    const items = [{ left: 0 }, { left: 5 }, { left: 11 }]
    const clusters = clusterEvents(items, 12)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].left).toBe(0)
    expect(clusters[0].members).toHaveLength(3)
  })

  it('merges relative to the cluster anchor, not the previous member', () => {
    // 0, 10, 20: each consecutive gap is 10 (<=12), but 20 is 20px from the
    // anchor (0) — anchor-relative merge (mirroring deriveMarkers) keeps 20
    // out of the first cluster rather than chaining it in.
    const items = [{ left: 0 }, { left: 10 }, { left: 20 }]
    const clusters = clusterEvents(items, 12)
    expect(clusters).toHaveLength(2)
    expect(clusters[0].members).toHaveLength(2)
    expect(clusters[1].members).toHaveLength(1)
  })

  it('sorts unsorted input by left before clustering', () => {
    const items = [{ left: 250 }, { left: 0 }, { left: 100 }]
    const clusters = clusterEvents(items, 12)
    expect(clusters.map((c) => c.left)).toEqual([0, 100, 250])
  })

  it('returns [] for an empty input', () => {
    expect(clusterEvents([], 12)).toEqual([])
  })
})

describe('layoutTrack', () => {
  function item(left: number, label: string) {
    return { left, label }
  }

  it('renders a lone chip horizontally regardless of label length', () => {
    const longLabel = 'a'.repeat(40)
    const out = layoutTrack([item(0, longLabel)], 12)
    expect(out).toHaveLength(1)
    expect(out[0].mode).toBe('horizontal')
    expect(out[0].displayLabel).toBe(longLabel)
  })

  it('renders a multi-member cluster as a "+N" glyph, not text labels', () => {
    const out = layoutTrack([item(0, 'a'), item(5, 'b'), item(10, 'c')], 12)
    expect(out).toHaveLength(1)
    expect(out[0].mode).toBe('cluster')
    expect(out[0].members).toHaveLength(3)
    expect(out[0].displayLabel).toBe('+3')
  })

  it('keeps a short label horizontal when it fits before the next cluster', () => {
    const gapPx = 4 * EVENT_LABEL_PX_PER_CHAR + 20
    const out = layoutTrack([item(0, 'abcd'), item(gapPx, 'x')], 12)
    expect(out[0].mode).toBe('horizontal')
    expect(out[0].displayLabel).toBe('abcd')
  })

  it('degrades a label that cannot fit to a bare glyph by default (vertical text is opt-in)', () => {
    const longLabel = 'deployment-marker-event'
    const tightGapPx = 5 // far tighter than the label needs at any px/char estimate
    const out = layoutTrack([item(0, longLabel), item(tightGapPx, 'x')], 1)
    expect(out[0].mode).toBe('glyph')
    expect(out[0].displayLabel).toBe('')
  })

  it('degrades to glyph the same way when verticalEnabled is explicitly false', () => {
    const longLabel = 'deployment-marker-event'
    const tightGapPx = 5
    const out = layoutTrack([item(0, longLabel), item(tightGapPx, 'x')], 1, false)
    expect(out[0].mode).toBe('glyph')
    expect(out[0].displayLabel).toBe('')
  })

  it('switches a label to trimmed vertical text when verticalEnabled is true and it cannot fit', () => {
    const longLabel = 'deployment-marker-event'
    const tightGapPx = 5 // far tighter than the label needs at any px/char estimate
    const out = layoutTrack([item(0, longLabel), item(tightGapPx, 'x')], 1, true)
    expect(out[0].mode).toBe('vertical')
    expect(out[0].displayLabel).toBe(trimLabelForVertical(longLabel))
    expect(out[0].displayLabel.length).toBeLessThanOrEqual(VERTICAL_LABEL_MAX_CHARS)
  })

  it('is a no-op on an empty track', () => {
    expect(layoutTrack([], 12)).toEqual([])
  })
})

describe('trimLabelForVertical', () => {
  it('leaves a label at or under the char cap untouched', () => {
    expect(trimLabelForVertical('abcdef')).toBe('abcdef')
    expect(trimLabelForVertical('abc')).toBe('abc')
  })

  it('trims a longer label to the cap with a trailing ellipsis', () => {
    const trimmed = trimLabelForVertical('deployment_marker')
    expect(trimmed).toBe('deplo…')
    expect(trimmed.length).toBe(VERTICAL_LABEL_MAX_CHARS)
  })

  it('respects a custom char cap', () => {
    expect(trimLabelForVertical('abcdefgh', 3)).toBe('ab…')
  })
})

describe('trackHeight', () => {
  it('is the base height when no visible chip is vertical', () => {
    expect(trackHeight([{ mode: 'horizontal' }, { mode: 'cluster' }])).toBe(TRACK_BASE_HEIGHT_PX)
  })

  it('grows to the tall height once any visible chip is vertical', () => {
    expect(trackHeight([{ mode: 'horizontal' }, { mode: 'vertical' }])).toBe(TRACK_TALL_HEIGHT_PX)
  })

  it('is the base height for an empty (fully culled) track', () => {
    expect(trackHeight([])).toBe(TRACK_BASE_HEIGHT_PX)
  })
})

describe('qualifyingEventTracks', () => {
  it('keeps declaration order among qualifying types', () => {
    const decls = [decl({ name: 'c' }), decl({ name: 'a' }), decl({ name: 'b' })]
    const events = [eventView({ type: 'a' }), eventView({ type: 'b' }), eventView({ type: 'c' })]
    const out = qualifyingEventTracks(decls, events, { a: true, b: true, c: true })
    expect(out.map((d) => d.name)).toEqual(['c', 'a', 'b'])
  })

  it('drops a type with no instance in the buffer', () => {
    const decls = [decl({ name: 'a' }), decl({ name: 'b' })]
    const events = [eventView({ type: 'a' })]
    const out = qualifyingEventTracks(decls, events, { a: true, b: true })
    expect(out.map((d) => d.name)).toEqual(['a'])
  })

  it('drops a type hidden via the gear (visibility false)', () => {
    const decls = [decl({ name: 'a' })]
    const events = [eventView({ type: 'a' })]
    expect(qualifyingEventTracks(decls, events, { a: false })).toEqual([])
  })

  it('keeps a type with no visibility entry (treated as visible)', () => {
    const decls = [decl({ name: 'a' })]
    const events = [eventView({ type: 'a' })]
    expect(qualifyingEventTracks(decls, events, {}).map((d) => d.name)).toEqual(['a'])
  })
})

describe('eventContentKey', () => {
  it('collides on a bare type+ts+partition triple, same as the wire format can', () => {
    // The wire format truncates ts to whole milliseconds and stamps
    // partition from the emitting hook's own Kafka partition — two genuinely
    // different range instances of one type can share both, so a naive
    // type|ts|partition key is not unique. This pins the collision case
    // eventContentKey exists to resolve, via end_ts/text/values/match.
    const a = eventView({
      type: 'scan_window_processing_range',
      ts: 1000,
      partition: 11,
      text: '3 tasks',
      endTs: 1001,
    })
    const b = eventView({
      type: 'scan_window_processing_range',
      ts: 1000,
      partition: 11,
      text: '7 tasks',
      endTs: 1002,
    })
    expect(eventContentKey(a)).not.toBe(eventContentKey(b))
  })

  it('is stable for the same instance data', () => {
    const a = eventView({ values: { sha: 'abc' }, match: { label: ['k', 'v'] } })
    const b = eventView({ values: { sha: 'abc' }, match: { label: ['k', 'v'] } })
    expect(eventContentKey(a)).toBe(eventContentKey(b))
  })

  it('still collides for two byte-identical instances — the case withUniqueKeys handles', () => {
    const a = eventView({ text: 'dup' })
    const b = eventView({ text: 'dup' })
    expect(eventContentKey(a)).toBe(eventContentKey(b))
  })
})

describe('withUniqueKeys', () => {
  it('keeps a bare key for the first occurrence and every already-unique item', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const out = withUniqueKeys(items, (i) => i.id)
    expect(out.map((i) => i.key)).toEqual(['a', 'b', 'c'])
  })

  it('appends a deterministic #n suffix to every occurrence after the first', () => {
    const items = [{ id: 'x' }, { id: 'y' }, { id: 'x' }, { id: 'x' }]
    const out = withUniqueKeys(items, (i) => i.id)
    expect(out.map((i) => i.key)).toEqual(['x', 'y', 'x#2', 'x#3'])
    // Every key is unique, which is the actual invariant a keyed {#each} needs.
    expect(new Set(out.map((i) => i.key)).size).toBe(out.length)
  })

  it('is a no-op on an empty input', () => {
    expect(withUniqueKeys([], (i: { id: string }) => i.id)).toEqual([])
  })

  it('preserves the original item fields alongside the added key', () => {
    const out = withUniqueKeys([{ id: 'a', label: 'A' }], (i) => i.id)
    expect(out[0]).toEqual({ id: 'a', label: 'A', key: 'a' })
  })
})
