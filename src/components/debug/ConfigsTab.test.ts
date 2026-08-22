// Configs tab group headers: the optional user-defined `app` group
// (contract v1.17) gets a "user-defined" chip next to its title, framework
// groups do not, and each header's docs link resolves its doc_anchor —
// config-reference fragment for framework groups, standalone /app-config/
// page for the app group. Rendered against a stubbed fetch, same pattern as
// DatabasesTab.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import ConfigsTab from './ConfigsTab.svelte'
import type { ConfigReferenceGroup } from '../../lib/types'

const kafkaGroup: ConfigReferenceGroup = {
  key: 'kafka',
  title: 'Kafka',
  doc_anchor: 'kafka',
  entries: [
    {
      path: 'kafka.brokers',
      env: 'DK_KAFKA__BROKERS',
      description: 'Broker list',
      full_description: 'Comma-separated list of Kafka bootstrap brokers.',
      type: 'string',
      value: 'localhost:9092',
      default: 'localhost:9092',
      is_default: true,
      secret: false,
    },
  ],
}

// The v1.17 app group: user-chosen env prefix, doc_anchor is a page slug.
const appGroup: ConfigReferenceGroup = {
  key: 'app',
  title: 'Application',
  doc_anchor: 'app-config',
  entries: [
    {
      path: 'app.scoring.url',
      env: 'MYAPP_SCORING__URL',
      description: 'Scoring service URL',
      full_description: 'Endpoint of the deployment-owned scoring service.',
      type: 'string',
      value: 'http://scoring:9000',
      default: null,
      is_default: false,
      secret: false,
    },
  ],
}

function stubFetch(groups: ConfigReferenceGroup[]) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/config-reference')) {
      return new Response(JSON.stringify({ groups }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

// Drains the onMount load() async chain (awaited fetch + json()).
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
  const app = mount(ConfigsTab, { target })
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

function headerFor(target: HTMLElement, title: string): HTMLElement | undefined {
  return [...target.querySelectorAll('.group-header')].find((h) =>
    h.querySelector('h3')?.textContent?.includes(title),
  ) as HTMLElement | undefined
}

describe('ConfigsTab group headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it('tags the app group title with a user-defined chip, and only that group', async () => {
    vi.stubGlobal('fetch', stubFetch([kafkaGroup, appGroup]))
    const { target, cleanup } = renderMounted()
    await settled()

    const appHeader = headerFor(target, 'Application')
    expect(appHeader).not.toBeUndefined()
    expect(appHeader!.querySelector('h3 .chip')?.textContent?.trim()).toBe('user-defined')

    const kafkaHeader = headerFor(target, 'Kafka')
    expect(kafkaHeader).not.toBeUndefined()
    expect(kafkaHeader!.querySelector('h3 .chip')).toBeNull()
    cleanup()
  })

  it('links the app group docs to the standalone /app-config/ page', async () => {
    vi.stubGlobal('fetch', stubFetch([kafkaGroup, appGroup]))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(headerFor(target, 'Application')!.querySelector('a')?.getAttribute('href')).toBe(
      'https://wlame.github.io/drakkar/app-config/',
    )
    expect(headerFor(target, 'Kafka')!.querySelector('a')?.getAttribute('href')).toBe(
      'https://wlame.github.io/drakkar/config-reference/#kafka',
    )
    cleanup()
  })

  it('renders no app group or chip when the backend omits it', async () => {
    vi.stubGlobal('fetch', stubFetch([kafkaGroup]))
    const { target, cleanup } = renderMounted()
    await settled()

    expect(headerFor(target, 'Application')).toBeUndefined()
    expect(target.querySelector('h3 .chip')).toBeNull()
    cleanup()
  })
})
