// The in-UI docs drawer: an iframe onto the backend-served docs site, opened
// from a BookIcon anywhere in the app. The drawer only has to point at the
// right URL and close cleanly — the docs page itself is the backend's.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import DocsDrawer from './DocsDrawer.svelte'
import { setDocsConfig } from '../lib/docsAnchors'
import type { DocsAnchorWire } from '../lib/types'

const anchor: DocsAnchorWire = {
  match: { sink: 'analytics_postgres_sink' },
  path: 'sinks/postgres.html#batching',
  title: 'Postgres batching',
}

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

function renderTracked(props: { anchor: DocsAnchorWire; onclose: () => void }) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(DocsDrawer, { target, props })
  mounted.push({ target, component })
  flushSync()
  return target
}

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  setDocsConfig(null)
  localStorage.clear()
})

describe('DocsDrawer', () => {
  it('frames the anchor path under the docs mount, fragment included', () => {
    const target = renderTracked({ anchor, onclose: () => {} })
    const frame = target.querySelector('iframe') as HTMLIFrameElement
    expect(frame.getAttribute('src')).toBe('/docs/sinks/postgres.html#batching')
    expect(frame.getAttribute('title')).toBe('Documentation')
  })

  it('offers the same page as an external link', () => {
    const target = renderTracked({ anchor, onclose: () => {} })
    const out = target.querySelector('.docs-bar a') as HTMLAnchorElement
    expect(out.getAttribute('href')).toBe('/docs/sinks/postgres.html#batching')
    expect(out.getAttribute('target')).toBe('_blank')
    expect(out.getAttribute('rel')).toBe('noopener')
  })

  it('titles the panel with the anchor title', () => {
    const target = renderTracked({ anchor, onclose: () => {} })
    expect(target.querySelector('.head .title')?.textContent).toBe('Postgres batching')
  })

  it('falls back to the docs site title when the anchor has none', () => {
    setDocsConfig({ title: 'Operator handbook', anchors: [] })
    const target = renderTracked({
      anchor: { match: { sink: 'analytics_postgres_sink' }, path: 'sinks/postgres.html' },
      onclose: () => {},
    })
    expect(target.querySelector('.head .title')?.textContent).toBe('Operator handbook')
  })

  it('closes on Escape pressed outside the iframe', () => {
    const onclose = vi.fn()
    renderTracked({ anchor, onclose })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onclose = vi.fn()
    renderTracked({ anchor, onclose })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    expect(onclose).not.toHaveBeenCalled()
  })

  it('closes from the panel close button', () => {
    const onclose = vi.fn()
    const target = renderTracked({ anchor, onclose })
    ;(target.querySelector('.head .x') as HTMLButtonElement).click()
    flushSync()
    expect(onclose).toHaveBeenCalledTimes(1)
  })

  it('stops listening for Escape once unmounted', () => {
    const onclose = vi.fn()
    renderTracked({ anchor, onclose })
    for (const { target, component } of mounted.splice(0)) {
      unmount(component)
      target.remove()
    }
    flushSync()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(onclose).not.toHaveBeenCalled()
  })
})
