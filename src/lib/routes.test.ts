// Route matching (matchPattern via its public surface, resolve): literal
// segments, :param capture + decoding, trailing slashes, and the NotFound
// fallback for non-matches.
import { describe, it, expect } from 'vitest'
import { resolve } from './routes'
import Dashboard from '../pages/Dashboard.svelte'
import TaskDetail from '../pages/TaskDetail.svelte'
import History from '../pages/History.svelte'
import Live from '../pages/Live.svelte'
import UserPage from '../pages/UserPage.svelte'
import NotFound from '../pages/NotFound.svelte'

describe('resolve', () => {
  it('matches the root exactly', () => {
    const m = resolve('/')
    expect(m.component).toBe(Dashboard)
    expect(m.params).toEqual({})
  })

  it('matches literal routes', () => {
    expect(resolve('/live').component).toBe(Live)
    expect(resolve('/history').component).toBe(History)
  })

  it('captures :param segments', () => {
    const m = resolve('/task/abc')
    expect(m.component).toBe(TaskDetail)
    expect(m.params).toEqual({ id: 'abc' })
  })

  it('resolves a declared page by slug', () => {
    const m = resolve('/p/orders')
    expect(m.component).toBe(UserPage)
    expect(m.params).toEqual({ slug: 'orders' })
  })

  it('no longer resolves the removed routes', () => {
    // These paths are handled by resolveRedirect before a component is chosen;
    // the route table itself must not know them.
    expect(resolve('/partitions').component).toBe(NotFound)
    expect(resolve('/partitions/42').component).toBe(NotFound)
    expect(resolve('/sinks').component).toBe(NotFound)
  })

  it('URL-decodes captured params (task ids can contain slashes when encoded)', () => {
    const m = resolve('/task/job%2F7:r1719878400')
    expect(m.component).toBe(TaskDetail)
    expect(m.params).toEqual({ id: 'job/7:r1719878400' })
  })

  it('ignores a trailing slash on non-root paths', () => {
    expect(resolve('/live/').component).toBe(Live)
    expect(resolve('/task/42/').params).toEqual({ id: '42' })
  })

  it('does not match when a literal segment differs', () => {
    expect(resolve('/nope').component).toBe(NotFound)
    expect(resolve('/nope').params).toEqual({})
  })

  it('does not match on a different segment count', () => {
    expect(resolve('/task/1/2').component).toBe(NotFound)
    expect(resolve('/live/1/extra').component).toBe(NotFound)
  })

  it('does not let a bare prefix match a param route', () => {
    // "/task/" normalizes to "/task", which has no :id segment to fill.
    expect(resolve('/task/').component).toBe(NotFound)
    expect(resolve('/task').component).toBe(NotFound)
  })
})
