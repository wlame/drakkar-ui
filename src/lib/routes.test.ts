// Route matching (matchPattern via its public surface, resolve): literal
// segments, :param capture + decoding, trailing slashes, and the NotFound
// fallback for non-matches.
import { describe, it, expect } from 'vitest'
import { resolve } from './routes'
import Dashboard from '../pages/Dashboard.svelte'
import Partitions from '../pages/Partitions.svelte'
import PartitionDetail from '../pages/PartitionDetail.svelte'
import TaskDetail from '../pages/TaskDetail.svelte'
import Live from '../pages/Live.svelte'
import NotFound from '../pages/NotFound.svelte'

describe('resolve', () => {
  it('matches the root exactly', () => {
    const m = resolve('/')
    expect(m.component).toBe(Dashboard)
    expect(m.params).toEqual({})
  })

  it('matches literal routes', () => {
    expect(resolve('/partitions').component).toBe(Partitions)
    expect(resolve('/live').component).toBe(Live)
  })

  it('captures :param segments', () => {
    const m = resolve('/partitions/42')
    expect(m.component).toBe(PartitionDetail)
    expect(m.params).toEqual({ id: '42' })
  })

  it('URL-decodes captured params (task ids can contain slashes when encoded)', () => {
    const m = resolve('/task/job%2F7:r1719878400')
    expect(m.component).toBe(TaskDetail)
    expect(m.params).toEqual({ id: 'job/7:r1719878400' })
  })

  it('ignores a trailing slash on non-root paths', () => {
    expect(resolve('/live/').component).toBe(Live)
    expect(resolve('/partitions/42/').params).toEqual({ id: '42' })
  })

  it('does not match when a literal segment differs', () => {
    expect(resolve('/nope').component).toBe(NotFound)
    expect(resolve('/nope').params).toEqual({})
  })

  it('does not match on a different segment count', () => {
    expect(resolve('/task/1/2').component).toBe(NotFound)
    expect(resolve('/partitions/1/extra').component).toBe(NotFound)
  })

  it('does not let a bare prefix match a param route', () => {
    // "/task/" normalizes to "/task", which has no :id segment to fill.
    expect(resolve('/task/').component).toBe(NotFound)
    expect(resolve('/task').component).toBe(NotFound)
  })
})
