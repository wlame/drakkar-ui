// Mounts the real User-defined tab with a 'tables' entry: one declared
// field, a runtime-determined number of sub-tables (one per group key).
import { afterEach, describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import UserDetailsTab from './UserDetailsTab.svelte'
import type { ProbeUserDetails } from '../../lib/types'
import { setLinkBases } from '../../lib/enrich'

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
    per_file_rows: [
      [
        'first_input_file.csv',
        [
          { item_id: 'a', score: 1 },
          { item_id: 'b', score: 2 },
        ],
      ],
      ['second_input_file.csv', [{ item_id: 'c', score: 3 }]],
    ],
  },
  writes: [{ field: 'per_file_rows', op: 'append', origin_stage: 'arrange', ms_since_start: 1 }],
}

const treeDetails: ProbeUserDetails = {
  model: 'FileImportDetails',
  layout: {
    sections: [
      {
        title: 'Files',
        entries: [
          {
            key: 'matches',
            label: 'Matches',
            view: 'tree',
            columns: [
              { key: 'file', label: 'File' },
              { key: 'section', label: 'Section' },
              { key: 'rule', label: 'Rule' },
              { key: 'score', label: 'Score' },
            ],
            group_by: ['file', 'section'],
          },
        ],
      },
    ],
  },
  data: {
    matches: [
      { file: 'first_input_file.csv', section: 'header', rule: 'r1', score: 1 },
      { file: 'first_input_file.csv', section: 'body', rule: 'r2', score: 2 },
      { file: 'second_input_file.csv', section: 'header', rule: 'r3', score: 3 },
    ],
  },
  writes: [{ field: 'matches', op: 'append', origin_stage: 'arrange', ms_since_start: 1 }],
}

describe('UserDetailsTab tree view', () => {
  it('renders nested collapsible levels with leaf tables of value columns', () => {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const app = mount(UserDetailsTab, { target, props: { details: treeDetails } })
    flushSync()

    const topLevel = [...target.querySelectorAll('details.treenode')].filter(
      (d) => !d.parentElement?.closest('details.treenode'),
    )
    expect(topLevel).toHaveLength(2)
    expect(topLevel[0].querySelector('summary')?.textContent).toContain('first_input_file.csv')
    expect(topLevel[0].querySelector('summary')?.textContent).toContain('2 rows')

    const nested = topLevel[0].querySelectorAll('details.treenode')
    expect([...nested].map((d) => d.querySelector('summary')?.textContent ?? '')).toEqual([
      expect.stringContaining('header'),
      expect.stringContaining('body'),
    ])

    // leaf table shows only value columns (rule, score), not the key columns
    const leafHeaders = [...nested[0].querySelectorAll('th')].map((th) => th.textContent?.trim())
    expect(leafHeaders.join(' ')).toContain('Rule')
    expect(leafHeaders.join(' ')).not.toContain('File')

    unmount(app)
    target.remove()
  })
})

// Mounts `details` into a fresh container and returns it plus a teardown
// callback, matching the mount/flushSync/unmount/target.remove() sequence
// every describe block above repeats inline.
function renderTab(details: ProbeUserDetails) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(UserDetailsTab, { target, props: { details } })
  flushSync()
  return {
    target,
    cleanup: () => {
      unmount(app)
      target.remove()
    },
  }
}

describe('UserDetailsTab enrichment rendering', () => {
  afterEach(() => setLinkBases({}))

  it('renders a resolved link cell as an anchor and an unresolved one as text', () => {
    setLinkBases({ jenkins: 'https://jenkins.internal.example.com' })
    const linkDetails: ProbeUserDetails = {
      model: 'LinkDetails',
      layout: {
        sections: [
          {
            title: 'Section',
            entries: [
              {
                key: 'rows',
                label: 'Rows',
                view: 'table',
                columns: [
                  { key: 'build_id', label: 'Build id', link_template: '{jenkins}/job/{value}' },
                  // jira base is not configured — must degrade to plain text.
                  { key: 'ticket', label: 'Ticket', link_template: '{jira}/browse/{value}' },
                ],
              },
            ],
          },
        ],
      },
      data: { rows: [{ build_id: 'b1', ticket: 'DK-1' }] },
      writes: [{ field: 'rows', op: 'set', origin_stage: 'arrange', ms_since_start: 1 }],
    }
    const { target, cleanup } = renderTab(linkDetails)

    const link = [...target.querySelectorAll('a')].find((a) => a.textContent === 'b1')
    expect(link?.getAttribute('href')).toBe('https://jenkins.internal.example.com/job/b1')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')

    const ticketCell = [...target.querySelectorAll('td')].find((td) => td.textContent === 'DK-1')
    expect(ticketCell?.querySelector('a')).toBeNull()

    cleanup()
  })

  it('renders badge scalar entries with the mapped color class', () => {
    const badgeDetails: ProbeUserDetails = {
      model: 'BadgeDetails',
      layout: {
        sections: [
          {
            title: 'Section',
            entries: [
              {
                key: 'status',
                label: 'Status',
                view: 'badge',
                columns: null,
                badge_colors: { shipped: 'green', '*': 'gray' },
              },
            ],
          },
        ],
      },
      data: { status: 'shipped' },
      writes: [{ field: 'status', op: 'set', origin_stage: 'arrange', ms_since_start: 1 }],
    }
    const { target, cleanup } = renderTab(badgeDetails)

    const badge = [...target.querySelectorAll('.badge')].find((el) => el.textContent === 'shipped')
    expect(badge?.className).toContain('badge-green')

    cleanup()
  })
})

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
