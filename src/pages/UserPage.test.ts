// Regression: two widgets sharing a title must still render both cards. The
// wire contract (UIPageWidget) has no unique id and does not guarantee
// title uniqueness within a page, so the {#each} must key on the array
// index, not widget.title — keying on title throws Svelte's duplicate-key
// error the moment two widgets share one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import UserPage from './UserPage.svelte'
import { loadUiPages } from '../lib/pages'
import type { UIPage } from '../lib/types'

const fetchMock = vi.fn()

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('UserPage widget list', () => {
  it('renders both cards when two widgets share a title', async () => {
    const page: UIPage = {
      slug: 'orders',
      title: 'Orders',
      widgets: [
        { title: 'Summary', view: 'stat', source: { kind: 'field' } },
        { title: 'Summary', view: 'table', source: { kind: 'field' } },
      ],
    }
    fetchMock.mockResolvedValue(okJson([page]))
    await loadUiPages()

    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserPage, { target, props: { params: { slug: 'orders' } } })
    flushSync()

    const widgets = target.querySelectorAll('.widget')
    expect(widgets).toHaveLength(2)
    expect([...widgets].map((w) => w.querySelector('h2')?.textContent)).toEqual([
      'Summary',
      'Summary',
    ])

    unmount(app)
    target.remove()
  })
})
