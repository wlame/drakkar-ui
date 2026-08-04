// Client-side table sorting.
//
// Every table in this UI renders an array the page already holds, so sorting is
// a pure view concern: no request, no server round trip. Two rules shape the
// implementation.
//
// The sort NEVER mutates the source array. Several tables re-render from a poll
// or a WebSocket frame while the user is looking at them, and an in-place
// `.sort()` would reorder the live buffer under the code that appends to it.
// Sorting a copy also means clearing the sort restores the original order for
// free — which, for an event feed, is the meaningful order.
//
// Comparison is type-aware rather than string-based. `stdout` sizes and
// durations are numbers, and lexicographic order puts 10 before 9. Nullish
// values always sort last regardless of direction, because "unknown" is not
// smaller than every number — it is absent, and absent belongs at the end where
// it does not interrupt the ranking the user asked for.

export type SortDirection = 'asc' | 'desc'

export interface SortState {
  /** Column key currently sorted, or null for the source order. */
  key: string | null
  direction: SortDirection
}

/** A comparable cell value. Anything else is compared by its string form. */
export type SortValue = string | number | boolean | null | undefined

/** Reads the sortable value out of a row for a given column key. */
export type SortAccessor<T> = (row: T) => SortValue

export const NO_SORT: SortState = { key: null, direction: 'asc' }

/**
 * Advance the sort state for a header click.
 *
 * Clicking a new column sorts it ascending. Clicking the active column flips to
 * descending, and clicking once more clears the sort and returns the table to
 * its source order. That third state matters here: for the live feeds, arrival
 * order carries information no column does, so the user must be able to get
 * back to it without a reload.
 */
export function nextSortState(current: SortState, key: string): SortState {
  if (current.key !== key) return { key, direction: 'asc' }
  if (current.direction === 'asc') return { key, direction: 'desc' }
  return NO_SORT
}

function isEmpty(v: SortValue): boolean {
  return v === null || v === undefined || v === ''
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  // localeCompare with numeric collation keeps "task-9" before "task-10",
  // which plain string order gets wrong and which task ids hit constantly.
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Return a sorted COPY of `rows`, or `rows` itself when no sort is active.
 *
 * `accessors` maps a column key to the value that column displays. A key with
 * no accessor leaves the order untouched rather than throwing, so a header
 * added without its accessor degrades to "not sortable" instead of breaking
 * the page.
 */
export function sortRows<T>(
  rows: readonly T[],
  state: SortState,
  accessors: Record<string, SortAccessor<T>>,
): readonly T[] {
  if (!state.key) return rows
  const accessor = accessors[state.key]
  if (!accessor) return rows

  const sign = state.direction === 'asc' ? 1 : -1
  // Decorate with the original index so equal keys keep their source order.
  // Array.prototype.sort is stable in modern engines, but the tie-break is
  // stated explicitly because the guarantee is what the live views rely on.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const a = accessor(x.row)
      const b = accessor(y.row)
      // Emptiness is decided BEFORE the direction sign is applied, so absent
      // values stay at the end whichever way the column is sorted. Folding
      // this into compare() and multiplying by sign flips them to the front on
      // a descending sort, which is what the tests caught.
      const aEmpty = isEmpty(a)
      const bEmpty = isEmpty(b)
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) return x.index - y.index
        return aEmpty ? 1 : -1
      }
      const result = compare(a, b) * sign
      return result !== 0 ? result : x.index - y.index
    })
    .map((entry) => entry.row)
}

/** The `aria-sort` value for a header cell, for screen readers. */
export function ariaSort(state: SortState, key: string): 'ascending' | 'descending' | 'none' {
  if (state.key !== key) return 'none'
  return state.direction === 'asc' ? 'ascending' : 'descending'
}
