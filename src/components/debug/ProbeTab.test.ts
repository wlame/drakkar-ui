// Probe tab prefill from a Kafka record (#probe/<alias>/<p>/<o>), against a
// stubbed fetch. A DLQ record carries the source coordinates in its
// dk-source-* headers; the form takes them from there, falls back to the
// record's own coordinates without them, and stays off for a binary record.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import ProbeTab from './ProbeTab.svelte'
import { setConfig } from '../../lib/config'
import type { KafkaReadHeader, KafkaReadMessage } from '../../lib/types'

function headers(pairs: [string, string][]): KafkaReadHeader[] {
  return pairs.map(([key, value]) => ({ key, value, value_encoding: 'utf-8' }))
}

const SOURCE_HEADERS = headers([
  ['dk-record-version', '1'],
  ['dk-stage', 'sink'],
  ['dk-source-topic', 'orders'],
  ['dk-source-partition', '1'],
  ['dk-source-offset', '77'],
  ['dk-source-timestamp', '1793000000789'],
])

function dlqRecord(overrides: Partial<KafkaReadMessage> = {}): KafkaReadMessage {
  return {
    alias: 'dlq',
    partition: 4,
    offset: 9,
    timestamp_ms: 1_793_000_005_000,
    key: 'order-18',
    key_encoding: 'utf-8',
    payload: '{"id": 18}',
    payload_encoding: 'utf-8',
    payload_size_bytes: 10,
    headers: SOURCE_HEADERS,
    ...overrides,
  }
}

// Answers the record read with `record`; the probe run itself answers 500,
// because these tests assert the request body, not the report.
function stubFetch(record: KafkaReadMessage) {
  // `init` is declared so the recorded calls carry the request body.
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/debug/kafka/dlq/message')) {
      return new Response(JSON.stringify(record), { status: 200 })
    }
    return new Response('{"detail":"not in this test"}', { status: 500 })
  })
}

async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

async function renderPrefilled(record: KafkaReadMessage) {
  const fetchStub = stubFetch(record)
  vi.stubGlobal('fetch', fetchStub)
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(ProbeTab, {
    target,
    props: { prefill: { alias: 'dlq', partition: record.partition, offset: record.offset } },
  })
  await settled()
  return {
    target,
    fetchStub,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

function field(target: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...target.querySelectorAll('form label')].find((l) =>
    l.textContent?.trim().startsWith(label),
  )
  const control = found?.querySelector('input, textarea')
  expect(control, `form field ${label}`).not.toBeNull()
  return control as HTMLInputElement | HTMLTextAreaElement
}

function runButton(target: HTMLElement): HTMLButtonElement {
  return target.querySelector('form button[type="submit"]') as HTMLButtonElement
}

describe('ProbeTab prefill', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setConfig({ kafkaSourceTopic: '' })
  })

  it('fills value, key, topic, partition, offset and timestamp from the dk-source headers', async () => {
    const { target, fetchStub, cleanup } = await renderPrefilled(dlqRecord())

    expect(field(target, 'Value').value).toBe('{"id": 18}')
    expect(field(target, 'Key').value).toBe('order-18')
    expect(field(target, 'Topic').value).toBe('orders')
    expect(field(target, 'Partition').value).toBe('1')
    expect(field(target, 'Offset').value).toBe('77')
    expect(field(target, 'Timestamp').value).toBe('1793000000789')
    expect(target.querySelector('.prefill-note')?.textContent).toContain(
      'topic, partition, offset, timestamp from its dk-source-* headers',
    )

    runButton(target).click()
    await settled()
    const probeCall = fetchStub.mock.calls.find((c) => String(c[0]).includes('/debug/probe'))
    expect(probeCall).not.toBeUndefined()
    expect(JSON.parse(String(probeCall![1]?.body))).toEqual({
      value: '{"id": 18}',
      key: 'order-18',
      partition: 1,
      offset: 77,
      topic: 'orders',
      timestamp: 1_793_000_000_789,
      use_cache: false,
    })
    cleanup()
  })

  it('falls back to the record coordinates and the source topic for an old-format record', async () => {
    setConfig({ kafkaSourceTopic: 'orders-live' })
    const { target, cleanup } = await renderPrefilled(dlqRecord({ headers: [] }))

    expect(field(target, 'Topic').value).toBe('orders-live')
    expect(field(target, 'Partition').value).toBe('4')
    expect(field(target, 'Offset').value).toBe('9')
    expect(field(target, 'Timestamp').value).toBe('1793000005000')
    expect(runButton(target).disabled).toBe(false)
    expect(target.querySelector('.prefill-note')?.textContent).not.toContain('dk-source')
    cleanup()
  })

  it('names only the timestamp in the note for an HTTP record', async () => {
    const httpHeaders = headers([
      ['dk-record-version', '1'],
      ['dk-stage', 'sink'],
      ['dk-source-timestamp', '1793000001000'],
      ['dk-request-id', 'req_20261105T101530_0042'],
    ])
    const { target, cleanup } = await renderPrefilled(dlqRecord({ headers: httpHeaders }))

    expect(field(target, 'Partition').value).toBe('4')
    expect(field(target, 'Timestamp').value).toBe('1793000001000')
    const note = target.querySelector('.prefill-note')?.textContent ?? ''
    expect(note).toContain('— timestamp from its dk-source-* headers')
    expect(note).not.toContain('partition')
    cleanup()
  })

  it.each([
    ['value', { payload: 'AP8B', payload_encoding: 'base64' as const }, 'the value is binary'],
    ['key', { key: 'AP8=', key_encoding: 'base64' as const }, 'the key is binary'],
  ])('turns the probe off with a note when the %s is base64', async (_part, overrides, note) => {
    const { target, fetchStub, cleanup } = await renderPrefilled(dlqRecord(overrides))

    expect(runButton(target).disabled).toBe(true)
    const reason = target.querySelector('.probe-off')
    expect(reason?.textContent).toContain(note)
    expect(reason?.id).toBeTruthy()
    expect(runButton(target).getAttribute('aria-describedby')).toBe(reason?.id)

    // Enter in a field submits the form even with the button off.
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settled()
    expect(fetchStub.mock.calls.some((c) => String(c[0]).includes('/debug/probe'))).toBe(false)
    cleanup()
  })
})

// A probe report as the backend sends it; `extra` adds or replaces keys.
function probeReport(extra: Record<string, unknown> = {}) {
  return {
    input: {
      value: '{}',
      key: null,
      partition: 0,
      offset: 5,
      topic: 'orders',
      timestamp: null,
      use_cache: false,
    },
    deserialize_error: null,
    parsed_payload: {},
    message_label: '0:5',
    arrange: { duration_seconds: 0.01, collect_result: null, error: null },
    tasks: [],
    on_message_complete: { duration_seconds: 0.001, collect_result: null, error: null },
    on_window_complete: null,
    planned_sink_payloads: [],
    cache_calls: [],
    cache_summary: { calls: 0, hits: 0, misses: 0, writes_suppressed: 0 },
    timing: {},
    errors: [],
    truncated: false,
    user_details: null,
    ...extra,
  }
}

function probeGroup(index: number, extra: Record<string, unknown> = {}) {
  return {
    index,
    task_count: 2,
    succeeded: 2,
    failed: 0,
    replaced: 0,
    labels: { kind: [`k${index}`, `j${index}`] },
    notes: { seen: 2 },
    skipped_deliveries: {},
    hook: { duration_seconds: 0.002, collect_result: { kafka: [{}] }, error: null },
    ...extra,
  }
}

async function renderReport(report: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(report), { status: 200 })),
  )
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(ProbeTab, { target, props: {} })
  await settled()
  const value = field(target, 'Value')
  value.value = '{}'
  value.dispatchEvent(new Event('input', { bubbles: true }))
  flushSync()
  runButton(target).click()
  await settled()
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('ProbeTab stream groups', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lists the groups with their counters, labels, notes and hook outcome', async () => {
    const { target, cleanup } = await renderReport(
      probeReport({
        groups: [probeGroup(0), probeGroup(1, { failed: 1, succeeded: 1, hook: null })],
        stream_truncated: false,
      }),
    )

    const section = target.querySelector('.probe-groups')
    expect(section?.querySelector('h3')?.textContent).toBe('Groups (2)')
    const rows = [...section!.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)
    const first = [...rows[0].querySelectorAll('td')].map((td) => td.textContent?.trim())
    expect(first.slice(0, 8)).toEqual(['0', '2', '2', '0', '0', 'kind=k0 j0', 'seen=2', ''])
    expect(first[8]).toContain('kafka: 1')
    expect(rows[1].querySelector('.group-hook')?.textContent).toContain('not overridden')
    expect(target.querySelector('.stream-truncated')).toBeNull()
    expect(target.textContent).toContain('arrange_stream')
    cleanup()
  })

  it('says the probe ran the first 5 groups only when the stream was cut', async () => {
    const groups = [0, 1, 2, 3, 4].map((index) => probeGroup(index))
    const { target, cleanup } = await renderReport(probeReport({ groups, stream_truncated: true }))

    expect(target.querySelector('.stream-truncated')?.textContent).toContain(
      'The probe ran the first 5 groups only',
    )
    cleanup()
  })

  it('shows the stream error on the arrange stage and keeps the groups that ran', async () => {
    const { target, cleanup } = await renderReport(
      probeReport({
        arrange: {
          duration_seconds: 0.01,
          collect_result: null,
          error: 'RuntimeError: stream broke',
        },
        on_message_complete: null,
        groups: [probeGroup(0)],
        stream_truncated: false,
      }),
    )

    expect(target.textContent).toContain('arrange_stream raised: RuntimeError: stream broke')
    expect(target.querySelectorAll('.probe-groups tbody tr')).toHaveLength(1)
    cleanup()
  })

  it('shows no groups for a handler that uses arrange', async () => {
    const { target, cleanup } = await renderReport(probeReport())

    expect(target.querySelector('.probe-groups')).toBeNull()
    expect(target.textContent).toContain('arrange returned no tasks')
    cleanup()
  })
})
