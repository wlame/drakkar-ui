import { describe, expect, it, vi } from 'vitest'
import type { EventRow, MetricFamily, TaskResult, UIPageWidget } from './types'

vi.mock('./api', () => ({
  api: {
    events: vi.fn(),
    liveTaskResults: vi.fn(),
    debugMetrics: vi.fn(),
  },
}))

import { api } from './api'
import { fetchStatValue, fetchWidgetRows, refreshEventTypes, scalarValue } from './widgets'

function eventRow(overrides: Partial<EventRow> = {}): EventRow {
  return {
    id: 1,
    ts: 1000,
    dt: '',
    event: 'annotation',
    partition: null,
    offset: null,
    task_id: null,
    args: null,
    stdout_size: 0,
    stdout: null,
    stderr: null,
    exit_code: null,
    duration: null,
    output_topic: null,
    metadata: null,
    pid: null,
    labels: null,
    origin: 'kafka',
    client_name: null,
    request_id: null,
    ...overrides,
  }
}

const widget = (source: UIPageWidget['source']): UIPageWidget => ({
  title: 'W',
  view: 'table',
  source,
})

describe('fetchWidgetRows', () => {
  it('events source passes joined event_types and limit through to api.events', async () => {
    const rows = [eventRow({ event: 'task_failed' })]
    vi.mocked(api.events).mockResolvedValue(rows)

    const result = await fetchWidgetRows(
      widget({ kind: 'events', event_types: ['task_failed', 'task_completed'], limit: 50 }),
    )

    expect(api.events).toHaveBeenCalledWith({
      event_types: 'task_failed,task_completed',
      limit: 50,
    })
    expect(result).toBe(rows)
  })

  it('annotations source parses metadata, stamps ts/kind, filters by prefix', async () => {
    vi.mocked(api.events).mockResolvedValue([
      eventRow({ ts: 10, metadata: JSON.stringify({ kind: 'order.created', data: { id: 1 } }) }),
      eventRow({ ts: 20, metadata: JSON.stringify({ kind: 'order.shipped', data: { id: 2 } }) }),
      eventRow({ ts: 30, metadata: JSON.stringify({ kind: 'build.started', data: { id: 3 } }) }),
    ])

    const result = await fetchWidgetRows(
      widget({ kind: 'annotations', kind_prefix: 'order.', limit: 100 }),
    )

    expect(api.events).toHaveBeenCalledWith({ event_types: 'annotation', limit: 100 })
    expect(result).toEqual([
      { kind: 'order.created', data: { id: 1 }, ts: 10 },
      { kind: 'order.shipped', data: { id: 2 }, ts: 20 },
    ])
  })

  it('annotations source survives malformed metadata JSON', async () => {
    vi.mocked(api.events).mockResolvedValue([eventRow({ ts: 10, metadata: '{not json' })])

    const result = await fetchWidgetRows(
      widget({ kind: 'annotations', kind_prefix: '', limit: 100 }),
    )

    expect(result).toEqual([{ ts: 10, kind: '' }])
  })

  it('tasks source returns liveTaskResults rows as-is', async () => {
    const rows: TaskResult[] = [
      {
        ts: 1,
        task_id: 't-1',
        partition: 0,
        source_offsets: null,
        hook_duration: null,
        exec_duration: null,
        status: 'completed',
        exit_code: 0,
        output_message_count: 0,
      },
    ]
    vi.mocked(api.liveTaskResults).mockResolvedValue(rows)

    const result = await fetchWidgetRows(widget({ kind: 'tasks', limit: 25 }))

    expect(api.liveTaskResults).toHaveBeenCalledWith(25)
    expect(result).toBe(rows)
  })

  it('metrics source returns an empty row list (stat uses fetchStatValue instead)', async () => {
    const result = await fetchWidgetRows(widget({ kind: 'metrics', metric: 'drakkar_tasks_total' }))
    expect(result).toEqual([])
  })

  it('unknown source kind returns null', async () => {
    const result = await fetchWidgetRows(widget({ kind: 'sparkline' }))
    expect(result).toBeNull()
  })
})

describe('scalarValue', () => {
  it('takes the newest (first) row and handles missing fields', () => {
    const rows = [{ status: 'ok' }, { status: 'stale' }]
    expect(scalarValue(rows, 'status')).toBe('ok')
    expect(scalarValue(rows, 'missing')).toBeNull()
    expect(scalarValue([], 'status')).toBeNull()
  })
})

describe('fetchStatValue', () => {
  const families: MetricFamily[] = [
    {
      name: 'drakkar_tasks_total',
      type: 'counter',
      help: '',
      source: 'framework',
      samples: [
        { name: 'drakkar_tasks_total', labels: { partition: '0' }, value: 3 },
        { name: 'drakkar_tasks_total', labels: { partition: '1' }, value: 4 },
      ],
    },
  ]

  it('sums the samples of the named metric family', async () => {
    vi.mocked(api.debugMetrics).mockResolvedValue(families)
    expect(await fetchStatValue('drakkar_tasks_total')).toBe(7)
  })

  it('returns null for a missing family', async () => {
    vi.mocked(api.debugMetrics).mockResolvedValue(families)
    expect(await fetchStatValue('nonexistent_metric')).toBeNull()
  })
})

describe('refreshEventTypes', () => {
  it('maps each source kind', () => {
    expect(refreshEventTypes(widget({ kind: 'events', event_types: ['task_failed'] }))).toEqual([
      'task_failed',
    ])
    expect(refreshEventTypes(widget({ kind: 'annotations', kind_prefix: '' }))).toEqual([
      'annotation',
    ])
    expect(refreshEventTypes(widget({ kind: 'tasks' }))).toEqual([
      'task_complete',
      'task_completed',
      'task_failed',
    ])
    expect(refreshEventTypes(widget({ kind: 'metrics', metric: 'x' }))).toEqual([])
    expect(refreshEventTypes(widget({ kind: 'sparkline' }))).toEqual([])
  })
})
