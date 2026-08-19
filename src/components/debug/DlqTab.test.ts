// DLQ tab: NDJSON window listing over the kafka-read API (alias 'dlq'),
// rendered against a stubbed fetch. Covers the auto-loaded default window,
// the row shape, the truncated-stream error banner, the empty state, and
// the side panel's "Probe this message" deep-link hash.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DlqTab from './DlqTab.svelte'
import type { KafkaReadMessage } from '../../lib/types'

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

  it('renders the base64 caveat for binary payloads in the panel', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch(ndjson([dlqMessage({ payload: 'AP8B', payload_encoding: 'base64' })])),
    )
    const { target, cleanup } = renderMounted()
    await settled()

    ;(target.querySelector('tbody tr') as HTMLElement).click()
    flushSync()
    expect(document.body.textContent).toContain('binary payload — shown base64-encoded')
    cleanup()
  })
})
