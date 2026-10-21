// DLQ tab: NDJSON window listing over the kafka-read API (alias 'dlq'),
// rendered against a stubbed fetch. Covers the auto-loaded default window,
// the row shape, the truncated-stream error banner, the empty state, and
// the side panel's "Probe this message" deep-link hash, the dk- header table
// above the value and the source headers below it, and the probe button that
// is off for a record the probe cannot take as text.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DlqTab from './DlqTab.svelte'
import type { KafkaReadHeader, KafkaReadMessage } from '../../lib/types'

function headers(pairs: [string, string][]): KafkaReadHeader[] {
  return pairs.map(([key, value]) => ({ key, value, value_encoding: 'utf-8' }))
}

const LONG_ERROR = 'exit code 2: ' + 'segmentation fault in the scorer; '.repeat(40)

const RECORD_HEADERS = headers([
  ['traceparent', '00-4bf92f3577b34da6-01'],
  ['dk-record-version', '1'],
  ['dk-stage', 'execute'],
  ['dk-error', LONG_ERROR],
  ['dk-task-id', 't-7f3a9c'],
  ['dk-source-topic', 'orders'],
  ['dk-source-partition', '0'],
  ['dk-source-offset', '0'],
])

function dlqMessage(overrides: Partial<KafkaReadMessage> = {}): KafkaReadMessage {
  return {
    alias: 'dlq',
    partition: 0,
    offset: 41,
    timestamp_ms: 1_755_600_000_000,
    key: 'task-8842',
    key_encoding: 'utf-8',
    payload: '{"error": "parse failure"}',
    payload_encoding: 'utf-8',
    payload_size_bytes: 26,
    headers: [],
    ...overrides,
  }
}

// The stream endpoint answers NDJSON — one JSON object per line.
function ndjson(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : '')
}

function stubFetch(body: string, status = 200) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/debug/kafka/dlq/messages')) {
      return new Response(body, { status })
    }
    return new Response('{}', { status: 200 })
  })
}

async function settled() {
  for (let i = 0; i < 4; i++) {
    flushSync()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  flushSync()
}

function renderMounted() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(DlqTab, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('DlqTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
    window.history.replaceState({}, '', '/debug')
  })

  it('auto-loads the default window and renders one row per message', async () => {
    const fetchStub = stubFetch(
      ndjson([dlqMessage(), dlqMessage({ offset: 42, key: 'task-9001' })]),
    )
    vi.stubGlobal('fetch', fetchStub)
    const { target, cleanup } = renderMounted()
    await settled()

    const rows = [...target.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('P0:41')
    expect(rows[0].textContent).toContain('task-8842')
    expect(rows[1].textContent).toContain('P0:42')

    // The auto-load asked the dlq alias with a from_ts and the default limit.
    const url = String(fetchStub.mock.calls[0][0])
    expect(url).toContain('/debug/kafka/dlq/messages')
    expect(url).toContain('from_ts=')
    expect(url).toContain('limit=200')
    cleanup()
  })

  it('surfaces a mid-stream error line as an incomplete-listing banner', async () => {
    vi.stubGlobal('fetch', stubFetch(ndjson([dlqMessage(), { error: 'brokers went away' }])))
    const { target, cleanup } = renderMounted()
    await settled()

    expect([...target.querySelectorAll('tbody tr')]).toHaveLength(1)
    const banner = target.querySelector('.error')
    expect(banner?.textContent).toContain('incomplete')
    expect(banner?.textContent).toContain('brokers went away')
    cleanup()
  })

  it('shows the empty state when the window has no messages', async () => {
    vi.stubGlobal('fetch', stubFetch(''))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(target.querySelector('tbody')).toBeNull()
    expect(target.textContent).toContain('No DLQ messages in this window')
    cleanup()
  })

  it('row click opens the panel; its probe button deep-links #probe/dlq/<p>/<o>', async () => {
    vi.stubGlobal('fetch', stubFetch(ndjson([dlqMessage({ partition: 3, offset: 77 })])))
    const { target, cleanup } = renderMounted()
    await settled()

    ;(target.querySelector('tbody tr') as HTMLElement).click()
    flushSync()
    const panelButtons = [...document.body.querySelectorAll('button')]
    const probeBtn = panelButtons.find((b) => b.textContent?.includes('Probe this message'))
    expect(probeBtn).not.toBeUndefined()
    probeBtn!.click()
    flushSync()
    expect(window.location.hash).toBe('#probe/dlq/3/77')
    cleanup()
  })

  async function openPanel(message: KafkaReadMessage) {
    vi.stubGlobal('fetch', stubFetch(ndjson([message])))
    const mounted = renderMounted()
    await settled()
    ;(mounted.target.querySelector('tbody tr') as HTMLElement).click()
    flushSync()
    return mounted
  }

  function probeButton(): HTMLButtonElement {
    const found = [...document.body.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Probe this message'),
    )
    expect(found).not.toBeUndefined()
    return found as HTMLButtonElement
  }

  function follows(later: Element, earlier: Element): boolean {
    return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
  }

  it('shows the dk- headers as a table above the value and the source headers below it', async () => {
    const { cleanup } = await openPanel(dlqMessage({ headers: RECORD_HEADERS }))

    const dkTable = document.body.querySelector('table.dk-headers')
    expect(dkTable).not.toBeNull()
    const dkRows = [...dkTable!.querySelectorAll('tbody tr')].map((r) =>
      [...r.querySelectorAll('td')].map((c) => c.textContent),
    )
    expect(dkRows.map((r) => r[0])).toEqual([
      'dk-record-version',
      'dk-stage',
      'dk-error',
      'dk-task-id',
      'dk-source-topic',
      'dk-source-partition',
      'dk-source-offset',
    ])
    expect(dkRows[2][1]).toBe(LONG_ERROR)
    expect(dkTable!.querySelectorAll('td.wrap')).toHaveLength(dkRows.length)

    const value = document.body.querySelector('.dlq-value')
    const sourceHeaders = document.body.querySelector('.source-headers')
    expect(value).not.toBeNull()
    expect(sourceHeaders).not.toBeNull()
    expect(sourceHeaders!.textContent).toContain('traceparent')
    expect(sourceHeaders!.textContent).not.toContain('dk-stage')
    expect(follows(value!, dkTable!)).toBe(true)
    expect(follows(sourceHeaders!, value!)).toBe(true)
    cleanup()
  })

  it('shows no dk- table for a record without dk- headers', async () => {
    const { cleanup } = await openPanel(dlqMessage({ headers: headers([['x-trace', '1']]) }))

    expect(document.body.querySelector('table.dk-headers')).toBeNull()
    expect(document.body.querySelector('.source-headers')?.textContent).toContain('x-trace')
    cleanup()
  })

  it('pretty-prints a JSON value and shows any other text as it is', async () => {
    const first = await openPanel(dlqMessage({ payload: '{"id":17,"ok":true}' }))
    expect(document.body.querySelector('.dlq-value')?.textContent).toContain('"id": 17')
    first.cleanup()

    const second = await openPanel(dlqMessage({ payload: 'not json {' }))
    expect(document.body.querySelector('.dlq-value')?.textContent).toContain('not json {')
    second.cleanup()
  })

  it('labels a binary value as base64 and does not parse it as JSON', async () => {
    // "1234" is valid JSON; a base64 value must not be pretty-printed as a number.
    const { cleanup } = await openPanel(dlqMessage({ payload: '1234', payload_encoding: 'base64' }))

    expect(document.body.textContent).toContain('binary, base64')
    expect(document.body.querySelector('.dlq-value')?.textContent).toContain('1234')
    cleanup()
  })

  it.each([
    ['value', { payload: 'AP8B', payload_encoding: 'base64' as const }, 'the value is binary'],
    ['key', { key: 'AP8=', key_encoding: 'base64' as const }, 'the key is binary'],
  ])(
    'disables the probe button with a note when the %s is base64',
    async (_part, overrides, note) => {
      const { cleanup } = await openPanel(dlqMessage(overrides))

      expect(probeButton().disabled).toBe(true)
      const reason = document.body.querySelector('.probe-off')
      expect(reason?.textContent).toContain(note)
      expect(reason?.id).toBeTruthy()
      expect(probeButton().getAttribute('aria-describedby')).toBe(reason?.id)
      cleanup()
    },
  )

  it('keeps the probe button on and shows no note for a text record', async () => {
    const { cleanup } = await openPanel(dlqMessage())

    expect(probeButton().disabled).toBe(false)
    expect(probeButton().hasAttribute('aria-describedby')).toBe(false)
    expect(document.body.querySelector('.probe-off')).toBeNull()
    cleanup()
  })
})
