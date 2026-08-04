import { describe, it, expect } from 'vitest'
import { NO_SORT, ariaSort, nextSortState, sortRows, type SortAccessor } from './sort'

interface Row {
  id: string
  size: number | null
  ok: boolean
}

const ROWS: Row[] = [
  { id: 'task-9', size: 30, ok: true },
  { id: 'task-10', size: null, ok: false },
  { id: 'task-2', size: 5, ok: true },
]

const ACCESSORS: Record<string, SortAccessor<Row>> = {
  id: (r) => r.id,
  size: (r) => r.size,
  ok: (r) => r.ok,
}

const ids = (rows: readonly Row[]) => rows.map((r) => r.id)

describe('nextSortState', () => {
  it('sorts a newly clicked column ascending', () => {
    expect(nextSortState(NO_SORT, 'size')).toEqual({ key: 'size', direction: 'asc' })
    expect(nextSortState({ key: 'id', direction: 'desc' }, 'size')).toEqual({
      key: 'size',
      direction: 'asc',
    })
  })

  it('cycles the active column asc then desc then off', () => {
    const first = nextSortState(NO_SORT, 'id')
    expect(first).toEqual({ key: 'id', direction: 'asc' })
    const second = nextSortState(first, 'id')
    expect(second).toEqual({ key: 'id', direction: 'desc' })
    // The third click restores source order, which is the meaningful order for
    // an arrival-ordered feed.
    expect(nextSortState(second, 'id')).toEqual(NO_SORT)
  })
})

describe('sortRows', () => {
  it('returns the source array unchanged when no sort is active', () => {
    expect(sortRows(ROWS, NO_SORT, ACCESSORS)).toBe(ROWS)
  })

  it('never mutates the source array', () => {
    const before = ids(ROWS).join(',')
    sortRows(ROWS, { key: 'size', direction: 'desc' }, ACCESSORS)
    expect(ids(ROWS).join(',')).toBe(before)
  })

  it('compares numbers numerically, not as strings', () => {
    const sorted = sortRows(ROWS, { key: 'size', direction: 'asc' }, ACCESSORS)
    // 5 before 30; string order would put "30" first.
    expect(ids(sorted).slice(0, 2)).toEqual(['task-2', 'task-9'])
  })

  it('puts nullish values last in both directions', () => {
    const asc = sortRows(ROWS, { key: 'size', direction: 'asc' }, ACCESSORS)
    const desc = sortRows(ROWS, { key: 'size', direction: 'desc' }, ACCESSORS)
    expect(ids(asc).at(-1)).toBe('task-10')
    expect(ids(desc).at(-1)).toBe('task-10')
  })

  it('orders embedded numbers naturally, so task-9 precedes task-10', () => {
    const sorted = sortRows(ROWS, { key: 'id', direction: 'asc' }, ACCESSORS)
    expect(ids(sorted)).toEqual(['task-2', 'task-9', 'task-10'])
  })

  it('sorts booleans false before true ascending', () => {
    const sorted = sortRows(ROWS, { key: 'ok', direction: 'asc' }, ACCESSORS)
    expect(sorted[0].ok).toBe(false)
  })

  it('keeps source order for rows that compare equal', () => {
    const tied: Row[] = [
      { id: 'b', size: 1, ok: true },
      { id: 'a', size: 1, ok: true },
    ]
    const sorted = sortRows(tied, { key: 'size', direction: 'asc' }, ACCESSORS)
    expect(ids(sorted)).toEqual(['b', 'a'])
  })

  it('leaves the order untouched for a key with no accessor', () => {
    const sorted = sortRows(ROWS, { key: 'nope', direction: 'asc' }, ACCESSORS)
    expect(sorted).toBe(ROWS)
  })

  it('handles an empty array', () => {
    expect(sortRows([], { key: 'id', direction: 'asc' }, ACCESSORS)).toEqual([])
  })
})

describe('ariaSort', () => {
  it('reports the direction only for the active column', () => {
    expect(ariaSort({ key: 'id', direction: 'asc' }, 'id')).toBe('ascending')
    expect(ariaSort({ key: 'id', direction: 'desc' }, 'id')).toBe('descending')
    expect(ariaSort({ key: 'id', direction: 'asc' }, 'size')).toBe('none')
    expect(ariaSort(NO_SORT, 'id')).toBe('none')
  })
})
