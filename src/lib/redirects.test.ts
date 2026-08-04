import { describe, it, expect } from 'vitest'
import { resolveRedirect } from './redirects'

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
})
