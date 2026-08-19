// KafkaIcon action modes: plain Kafka-UI link when only kafka_ui_* is
// configured, direct probe deep-link when only the kafka-read API is
// served, a two-item popover when both are available, and nothing when
// neither is. The capability probe is driven through the shared
// kafkaRead store (reset between tests).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import KafkaIcon from './KafkaIcon.svelte'
import { setConfig } from '../lib/config'
import { kafkaReadAvailable, resetKafkaReadProbeForTests } from '../lib/kafkaRead'

type IconProps = { partition: number; offset: number; topic?: string; probeAlias?: string | null }

function renderMounted(props: IconProps) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(KafkaIcon, { target, props })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

const COORDS = { partition: 2, offset: 41337 }

describe('KafkaIcon', () => {
  beforeEach(() => {
    resetKafkaReadProbeForTests()
    // The component fires the capability probe on init; a benign stub keeps
    // it from hitting the network — each test then sets the store directly.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"topics":[]}', { status: 200 })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    setConfig({ kafkaUiBase: '', kafkaUiCluster: '', kafkaSourceTopic: '' })
    window.history.replaceState({}, '', '/')
  })

  it('renders nothing when neither Kafka-UI nor the read API is available', () => {
    kafkaReadAvailable.set(false)
    const { target, cleanup } = renderMounted(COORDS)
    flushSync()
    expect(target.querySelector('a, button')).toBeNull()
    cleanup()
  })

  it('is a plain external link when only Kafka-UI is configured', () => {
    setConfig({
      kafkaUiBase: 'http://kui:8080',
      kafkaUiCluster: 'main',
      kafkaSourceTopic: 'input-events',
    })
    kafkaReadAvailable.set(false)
    const { target, cleanup } = renderMounted(COORDS)
    flushSync()
    const link = target.querySelector('a')!
    expect(link.getAttribute('href')).toContain('seekTo=2%3A%3A41337')
    expect(target.querySelector('button')).toBeNull()
    cleanup()
  })

  it('deep-links straight to the probe when only the read API is available', () => {
    kafkaReadAvailable.set(true)
    const { target, cleanup } = renderMounted(COORDS)
    flushSync()
    const link = target.querySelector('a')!
    expect(link.getAttribute('href')).toBe('/debug#probe/source/2/41337')
    link.click()
    flushSync()
    expect(window.location.pathname + window.location.hash).toBe('/debug#probe/source/2/41337')
    cleanup()
  })

  it('opens a two-action popover when both are available', () => {
    setConfig({
      kafkaUiBase: 'http://kui:8080',
      kafkaUiCluster: 'main',
      kafkaSourceTopic: 'input-events',
    })
    kafkaReadAvailable.set(true)
    const { target, cleanup } = renderMounted(COORDS)
    flushSync()
    const trigger = target.querySelector('button')!
    trigger.click()
    flushSync()
    const items = [...target.querySelectorAll('.menu a')]
    expect(items.map((a) => a.textContent)).toEqual(['Open in Kafka-UI ↗', 'Probe this message'])
    expect(items[1].getAttribute('href')).toBe('/debug#probe/source/2/41337')
    cleanup()
  })

  it('probeAlias=null drops the probe action entirely', () => {
    setConfig({
      kafkaUiBase: 'http://kui:8080',
      kafkaUiCluster: 'main',
      kafkaSourceTopic: 'input-events',
    })
    kafkaReadAvailable.set(true)
    const { target, cleanup } = renderMounted({ ...COORDS, probeAlias: null })
    flushSync()
    // Only the plain Kafka-UI link — no popover trigger button.
    expect(target.querySelector('button')).toBeNull()
    expect(target.querySelector('a')!.getAttribute('href')).toContain('/all-topics/')
    cleanup()
  })
})
