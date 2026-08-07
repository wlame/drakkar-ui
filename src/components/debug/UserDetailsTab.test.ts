// Mounts the real User-defined tab with a 'tables' entry: one declared
// field, a runtime-determined number of sub-tables (one per group key).
import { describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import UserDetailsTab from './UserDetailsTab.svelte'
import type { ProbeUserDetails } from '../../lib/types'

const details: ProbeUserDetails = {
  model: 'FileImportDetails',
  layout: {
    sections: [
      {
        title: 'Files',
        entries: [
          {
            key: 'per_file_rows',
            label: 'Per file rows',
            view: 'tables',
            columns: [
              { key: 'item_id', label: 'Item id' },
              { key: 'score', label: 'Score' },
            ],
          },
        ],
      },
    ],
  },
  data: {
    per_file_rows: {
      'first_input_file.csv': [
        { item_id: 'a', score: 1 },
        { item_id: 'b', score: 2 },
      ],
      'second_input_file.csv': [{ item_id: 'c', score: 3 }],
    },
  },
  writes: [{ field: 'per_file_rows', op: 'append', origin_stage: 'arrange', ms_since_start: 1 }],
}

describe('UserDetailsTab tables view', () => {
  it('renders one sub-table per group, in first-append order', () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserDetailsTab, { target, props: { details } })
    flushSync()

    const headings = [...target.querySelectorAll('h5.group')].map((h) => h.textContent ?? '')
    expect(headings).toHaveLength(2)
    expect(headings[0]).toContain('first_input_file.csv')
    expect(headings[0]).toContain('2 rows')
    expect(headings[1]).toContain('second_input_file.csv')
    expect(headings[1]).toContain('1 rows')

    const tables = target.querySelectorAll('table')
    expect(tables).toHaveLength(2)
    expect(tables[0].textContent).toContain('a')
    expect(tables[1].textContent).toContain('c')

    unmount(app)
    target.remove()
  })
})
