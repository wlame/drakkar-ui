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

describe('UserDetailsTab detail panel', () => {
  afterEach(() => setLinkBases({}))

  function orderDetails(): ProbeUserDetails {
    return {
      model: 'OrderDetails',
      layout: {
        sections: [
          {
            title: 'Orders',
            entries: [
              {
                key: 'orders',
                label: 'Orders',
                view: 'table',
                columns: [
                  { key: 'order_id', label: 'Order id' },
                  // Build link is present so a click on it can be checked
                  // against the row's own click handler (propagation must
                  // stop, or the link click would also open the panel).
                  { key: 'build_id', label: 'Build id', link_template: '{jenkins}/job/{value}' },
                ],
                detail: {
                  title: 'Order {row.order_id}',
                  elements: [
                    { view: 'keyvalue', field: 'customer' },
                    {
                      view: 'links',
                      links: [{ label: 'Jira ticket', template: '{jira}/browse/{row.ticket}' }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
      data: {
        orders: [
          {
            order_id: 'o 1',
            build_id: 'b-1',
            ticket: 'DK-7',
            customer: { name: 'ACME GmbH', tier: 'gold' },
          },
        ],
      },
      writes: [{ field: 'orders', op: 'set', origin_stage: 'arrange', ms_since_start: 1 }],
    }
  }

  it('opens the detail panel on row click and renders declared elements', () => {
    setLinkBases({ jira: 'https://jira.internal.example.com' })
    const { target, cleanup } = renderTab(orderDetails())

    expect(target.querySelector('.panel')).toBeNull()

    const row = [...target.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('o 1'),
    )
    expect(row?.className).toContain('clickable')
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()

    expect(target.querySelector('.panel .title')?.textContent).toBe('Order o 1')
    expect(target.textContent).toContain('ACME GmbH')
    const link = [...target.querySelectorAll('.panel a')].find(
      (a) => a.textContent === 'Jira ticket',
    )
    expect(link?.getAttribute('href')).toBe('https://jira.internal.example.com/browse/DK-7')

    cleanup()
  })

  it('does not open the panel when the click lands on a cell link', () => {
    setLinkBases({ jenkins: 'https://jenkins.internal.example.com' })
    const { target, cleanup } = renderTab(orderDetails())

    const link = [...target.querySelectorAll('tbody a')].find((a) => a.textContent === 'b-1')
    link!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()

    expect(target.querySelector('.panel')).toBeNull()

    cleanup()
  })

  it('closes the panel on the close button', () => {
    const { target, cleanup } = renderTab(orderDetails())

    const row = [...target.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('o 1'),
    )
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()
    expect(target.querySelector('.panel')).not.toBeNull()

    const closeButton = target.querySelector('.panel button.x') as HTMLButtonElement
    closeButton.click()
    flushSync()
    expect(target.querySelector('.panel')).toBeNull()

    cleanup()
  })

  it('falls back to the entry label when no title template is declared', () => {
    const noTitleDetails = orderDetails()
    const entry = noTitleDetails.layout.sections[0].entries[0]
    // detail.title omitted entirely — resolveDetailTitle must fall back to
    // the entry's own label rather than showing a blank header.
    entry.detail = { elements: entry.detail!.elements }
    const { target, cleanup } = renderTab(noTitleDetails)

    const row = [...target.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes('o 1'),
    )
    row!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    flushSync()

    expect(target.querySelector('.panel .title')?.textContent).toBe('Orders')

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
