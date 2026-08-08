import { describe, expect, it } from 'vitest'
import { pageBySlug } from './pages'
import type { UIPage } from './types'

const pages: UIPage[] = [
  { slug: 'orders', title: 'Orders', widgets: [] },
  { slug: 'builds', title: 'Builds', widgets: [] },
]

describe('pageBySlug', () => {
  it('finds a page by slug', () => {
    expect(pageBySlug(pages, 'builds')?.title).toBe('Builds')
  })
  it('returns null for unknown slugs', () => {
    expect(pageBySlug(pages, 'nope')).toBeNull()
  })
})
