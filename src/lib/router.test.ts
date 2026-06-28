import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'
import { currentPath, search, hash, navigate, setHash, setQuery, link } from './router'

// Reset the happy-dom location between tests and resync the module's stores
// through the same popstate path the browser would take.
function resetLocation(to = '/'): void {
  window.history.replaceState({}, '', to)
  window.dispatchEvent(new Event('popstate'))
}

beforeEach(() => {
  resetLocation('/')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('navigate', () => {
  it('updates location and all three stores from a compound target', () => {
    navigate('/partitions/3?page=2#h')
    expect(window.location.pathname).toBe('/partitions/3')
    expect(get(currentPath)).toBe('/partitions/3')
    expect(get(search)).toBe('?page=2')
    expect(get(hash)).toBe('#h')
  })

  it('pushes a history entry for a real change', () => {
    const push = vi.spyOn(window.history, 'pushState')
    navigate('/live')
    expect(push).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when already at the target (no duplicate history entries)', () => {
    navigate('/live')
    const push = vi.spyOn(window.history, 'pushState')
    navigate('/live')
    expect(push).not.toHaveBeenCalled()
  })
})

describe('setHash', () => {
  it('updates only the fragment, keeping path and query', () => {
    navigate('/debug?tab=1')
    setHash('#trace/5/42')
    expect(get(hash)).toBe('#trace/5/42')
    expect(window.location.pathname).toBe('/debug')
    expect(window.location.search).toBe('?tab=1')
  })

  it('replaces instead of pushing when asked', () => {
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    setHash('#probe', { replace: true })
    expect(push).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledTimes(1)
    expect(get(hash)).toBe('#probe')
  })
})

describe('setQuery', () => {
  it('prefixes a bare query with "?"', () => {
    setQuery('page=3')
    expect(get(search)).toBe('?page=3')
    expect(window.location.search).toBe('?page=3')
  })

  it('accepts an already-prefixed query', () => {
    setQuery('?x=1')
    expect(get(search)).toBe('?x=1')
  })

  it('clears the query with an empty string', () => {
    setQuery('page=3')
    setQuery('')
    expect(get(search)).toBe('')
    expect(window.location.search).toBe('')
  })
})

describe('popstate', () => {
  it('resyncs the stores on browser back/forward', () => {
    navigate('/live')
    window.history.replaceState({}, '', '/history?limit=10#frag')
    window.dispatchEvent(new Event('popstate'))
    expect(get(currentPath)).toBe('/history')
    expect(get(search)).toBe('?limit=10')
    expect(get(hash)).toBe('#frag')
  })
})

describe('link action', () => {
  // Clicks an anchor and reports whether the router claimed the event. A
  // sentinel listener (registered after the action's) always prevents the
  // final default so happy-dom never actually navigates away.
  function click(node: HTMLAnchorElement, init: MouseEventInit = {}): boolean {
    let claimed = false
    const sentinel = (e: Event) => {
      claimed = e.defaultPrevented
      e.preventDefault()
    }
    node.addEventListener('click', sentinel)
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
    node.removeEventListener('click', sentinel)
    return claimed
  }

  function anchor(href: string): HTMLAnchorElement {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    document.body.appendChild(a)
    return a
  }

  it('routes internal links client-side', () => {
    const a = anchor('/sinks')
    link(a)
    expect(click(a)).toBe(true)
    expect(get(currentPath)).toBe('/sinks')
  })

  it('lets modified clicks fall through to the browser', () => {
    const a = anchor('/sinks')
    link(a)
    expect(click(a, { ctrlKey: true })).toBe(false)
    expect(get(currentPath)).toBe('/')
  })

  it('lets external links fall through to the browser', () => {
    const a = anchor('https://example.com/dash')
    link(a)
    expect(click(a)).toBe(false)
    expect(get(currentPath)).toBe('/')
  })

  it('stops intercepting after destroy', () => {
    const a = anchor('/sinks')
    const action = link(a)
    action.destroy()
    expect(click(a)).toBe(false)
    expect(get(currentPath)).toBe('/')
  })
})
