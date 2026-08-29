// App shell: the docs nav entry and the single docs drawer the whole UI opens
// through the openDocsAnchor store. Mounted on an unrouted path so the shell
// renders NotFound rather than a data-hungry page — the header chrome under
// test is the same either way, and the boot fetches are stubbed away.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import App from './App.svelte'
import { identity, setIdentity } from './lib/config'
import { navigate } from './lib/router'
import { openDocsAnchor, setDocsConfig } from './lib/docsAnchors'
import type { Identity } from './lib/types'

const baseIdentity: Identity = {
  worker_id: 'worker-a',
  cluster: 'kafka-prod-01',
  config_summary: 'workers=4',
}

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

function renderTracked() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(App, { target, props: {} })
  mounted.push({ target, component })
  flushSync()
  return target
}

function navLinks(target: HTMLElement): HTMLAnchorElement[] {
  return Array.from(target.querySelectorAll('nav a'))
}

beforeEach(() => {
  // navigate(), not history.replaceState(): the path store is what the shell
  // resolves against, and only navigate() updates it.
  navigate('/no-such-page', { replace: true })
  // Every boot fetch (overview, identity, pages, sinks, workers) resolves to
  // an empty document; the tests set the identity store directly instead.
  // The list endpoints must answer with a list — the nav maps over the pages
  // response, so an object there throws inside a floating promise.
  const LIST_ENDPOINTS = ['/pages', '/sinks', '/workers']
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const body = LIST_ENDPOINTS.some((p) => url.includes(p)) ? '[]' : '{}'
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
    }),
  )
})

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  vi.unstubAllGlobals()
  localStorage.removeItem('drakkar_token')
  identity.set(null)
  setDocsConfig(null)
  openDocsAnchor.set(null)
  navigate('/', { replace: true })
})

describe('docs nav entry', () => {
  it('is absent on a backend that serves no docs site', () => {
    setIdentity(baseIdentity)
    const target = renderTracked()
    expect(navLinks(target).map((a) => a.textContent?.trim())).not.toContain('Operator handbook')
  })

  it('renders the docs title as an external link to the docs mount', () => {
    setIdentity({ ...baseIdentity, docs: { title: 'Operator handbook', anchors: [] } })
    const target = renderTracked()
    const docsLink = navLinks(target).find((a) => a.textContent?.trim() === 'Operator handbook')
    expect(docsLink).toBeDefined()
    expect(docsLink?.getAttribute('href')).toBe('/docs/')
    expect(docsLink?.getAttribute('target')).toBe('_blank')
    expect(docsLink?.getAttribute('rel')).toBe('noopener')
  })

  it('carries the auth token on a gated worker', () => {
    // Same reason as the drawer's iframe: a plain <a> cannot send the
    // Authorization header, and /docs/ is gated like the SPA.
    localStorage.setItem('drakkar_token', 'sekret')
    setIdentity({ ...baseIdentity, docs: { title: 'Operator handbook', anchors: [] } })
    const target = renderTracked()
    const docsLink = navLinks(target).find((a) => a.textContent?.trim() === 'Operator handbook')
    expect(docsLink?.getAttribute('href')).toBe('/docs/?token=sekret')
  })

  it('comes after the built-in nav entries', () => {
    setIdentity({ ...baseIdentity, docs: { title: 'Operator handbook', anchors: [] } })
    const target = renderTracked()
    const labels = navLinks(target).map((a) => a.textContent?.trim())
    expect(labels[labels.length - 1]).toBe('Operator handbook')
  })
})

describe('docs drawer', () => {
  it('stays closed until an anchor is published to the store', () => {
    setIdentity(baseIdentity)
    const target = renderTracked()
    expect(document.querySelector('iframe[title="Documentation"]')).toBeNull()
    expect(target.querySelector('.panel')).toBeNull()
  })

  it('opens on the published anchor and closes again from the panel', () => {
    setIdentity({ ...baseIdentity, docs: { title: 'Operator handbook', anchors: [] } })
    renderTracked()
    openDocsAnchor.set({ match: { page: 'throughput' }, path: 'pages/throughput.html' })
    flushSync()
    const frame = document.querySelector('iframe[title="Documentation"]') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('/docs/pages/throughput.html')
    ;(document.querySelector('.panel .head .x') as HTMLButtonElement).click()
    flushSync()
    expect(document.querySelector('iframe[title="Documentation"]')).toBeNull()
  })
})
