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
    expect(target.querySelector('.prefill-note')?.textContent).toContain('dk-source')

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
    cleanup()
  })

  it.each([
    ['value', { payload: 'AP8B', payload_encoding: 'base64' as const }, 'the value is binary'],
    ['key', { key: 'AP8=', key_encoding: 'base64' as const }, 'the key is binary'],
  ])('turns the probe off with a note when the %s is base64', async (_part, overrides, note) => {
    const { target, fetchStub, cleanup } = await renderPrefilled(dlqRecord(overrides))

    expect(runButton(target).disabled).toBe(true)
    expect(target.querySelector('.probe-off')?.textContent).toContain(note)

    // Enter in a field submits the form even with the button off.
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settled()
    expect(fetchStub.mock.calls.some((c) => String(c[0]).includes('/debug/probe'))).toBe(false)
    cleanup()
  })
})
