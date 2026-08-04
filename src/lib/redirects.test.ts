import { describe, it, expect } from 'vitest'
import { resolveRedirect } from './redirects'
import { resolve } from './routes'
import NotFound from '../pages/NotFound.svelte'

describe('resolveRedirect', () => {
  it('sends removed list pages to the dashboard', () => {
    expect(resolveRedirect('/partitions')).toBe('/')
    expect(resolveRedirect('/sinks')).toBe('/')
  })

  it('sends the removed partition detail page to the dashboard', () => {
    expect(resolveRedirect('/partitions/3')).toBe('/')
    expect(resolveRedirect('/partitions/0')).toBe('/')
  })

  it('ignores a trailing slash', () => {
    expect(resolveRedirect('/partitions/')).toBe('/')
    expect(resolveRedirect('/sinks/')).toBe('/')
    expect(resolveRedirect('/partitions/3/')).toBe('/')
  })

  it('returns null for routes that still exist', () => {
    expect(resolveRedirect('/')).toBeNull()
    expect(resolveRedirect('/live')).toBeNull()
    expect(resolveRedirect('/debug')).toBeNull()
    expect(resolveRedirect('/history')).toBeNull()
    expect(resolveRedirect('/task/abc')).toBeNull()
  })

  it('returns null for an unknown path so NotFound still renders', () => {
    expect(resolveRedirect('/nope')).toBeNull()
    // A deeper path under a removed route is not a bookmark we ever produced.
    expect(resolveRedirect('/partitions/3/extra')).toBeNull()
  })

  it('redirects exactly the paths the route table would otherwise send to NotFound', () => {
    // App.svelte hides the page component whenever resolveRedirect() is non-null,
    // so a redirected path only ever hides NotFound, never a real page — that is
    // what keeps a bookmark from flashing NotFound before the replace lands. If a
    // rule here ever names a path the route table still resolves to a real
    // component, this pins that regression before it ships.
    const redirectedPaths = ['/partitions', '/partitions/3', '/sinks']
    for (const path of redirectedPaths) {
      expect(resolveRedirect(path)).not.toBeNull()
      expect(resolve(path).component).toBe(NotFound)
    }
  })
})
