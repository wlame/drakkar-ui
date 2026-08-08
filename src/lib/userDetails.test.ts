import { describe, expect, test } from 'vitest'
import type { ProbeDetailsWrite } from './types'
import {
  buildTree,
  columnNumeric,
  groupedRows,
  normalizeStage,
  renderCell,
  stageBadges,
  tableAccessors,
  touchedFields,
  valueColumns,
} from './userDetails'

const bases = { jenkins: 'https://jenkins.internal.example.com' }

const w = (field: string, stage: string): ProbeDetailsWrite => ({
  field,
  op: 'set',
  origin_stage: stage,
  ms_since_start: 1,
})

describe('normalizeStage', () => {
  test('strips per-task suffix from task_complete stages', () => {
    expect(normalizeStage('task_complete:t-abc')).toBe('task_complete')
  })
  test('keeps plain stages untouched', () => {
    expect(normalizeStage('arrange')).toBe('arrange')
  })
})

describe('stageBadges', () => {
  test('groups by normalized stage, counts, first-appearance order', () => {
    const writes = [
      w('f', 'arrange'),
      w('f', 'task_complete:t-1'),
      w('f', 'task_complete:t-2'),
      w('g', 'window_complete'),
    ]
    expect(stageBadges(writes, 'f')).toEqual([
      { stage: 'arrange', count: 1 },
      { stage: 'task_complete', count: 2 },
    ])
  })
  test('returns empty list for untouched field', () => {
    expect(stageBadges([w('other', 'arrange')], 'f')).toEqual([])
  })
})

describe('touchedFields', () => {
  test('collects the set of written field names', () => {
    expect(touchedFields([w('a', 's'), w('b', 's'), w('a', 's')])).toEqual(new Set(['a', 'b']))
  })
})

describe('table helpers', () => {
  const rows = [
    { item_id: 'b', score: 2 },
    { item_id: 'a', score: 10 },
  ]
  test('tableAccessors reads cell values by column key', () => {
    const acc = tableAccessors([
      { key: 'item_id', label: 'Item id' },
      { key: 'score', label: 'Score' },
    ])
    expect(acc.item_id(rows[0])).toBe('b')
    expect(acc.score(rows[1])).toBe(10)
  })
  test('columnNumeric detects numeric columns from row values', () => {
    expect(columnNumeric(rows, 'score')).toBe(true)
    expect(columnNumeric(rows, 'item_id')).toBe(false)
    expect(columnNumeric([], 'score')).toBe(false)
  })
})

describe('groupedRows', () => {
  test('yields [group, rows] pairs in wire order', () => {
    const value = [
      ['first_input_file.csv', [{ item_id: 'a' }]],
      ['second_input_file.csv', [{ item_id: 'b' }, { item_id: 'c' }]],
    ]
    expect(groupedRows(value)).toEqual([
      ['first_input_file.csv', [{ item_id: 'a' }]],
      ['second_input_file.csv', [{ item_id: 'b' }, { item_id: 'c' }]],
    ])
  })
  test('keeps wire order for integer-like group names', () => {
    // The reason the wire format is a pair array: a JSON object would make
    // JS enumerate "12" before "3" regardless of backend append order.
    const value = [
      ['12', [{ item_id: 'a' }]],
      ['3', [{ item_id: 'b' }]],
    ]
    expect(groupedRows(value).map(([group]) => group)).toEqual(['12', '3'])
  })
  test('degrades absent or malformed values to no groups', () => {
    expect(groupedRows(undefined)).toEqual([])
    expect(groupedRows(null)).toEqual([])
    expect(groupedRows('text')).toEqual([])
    expect(groupedRows({ legacy_object: [{ item_id: 'a' }] })).toEqual([])
    expect(groupedRows([{ item_id: 'a' }])).toEqual([])
  })
  test('degrades a pair with non-array rows to empty rows', () => {
    expect(groupedRows([['broken_group', 'oops']])).toEqual([['broken_group', []]])
  })
})

describe('buildTree', () => {
  const rows = [
    { file: 'a.csv', section: 'header', rule: 'r1', score: 1 },
    { file: 'a.csv', section: 'body', rule: 'r2', score: 2 },
    { file: 'b.csv', section: 'header', rule: 'r3', score: 3 },
    { file: 'a.csv', section: 'header', rule: 'r4', score: 4 },
  ]

  test('groups by successive keys in first-appearance order', () => {
    const tree = buildTree(rows, ['file', 'section'])
    expect(tree.map((n) => n.key)).toEqual(['a.csv', 'b.csv'])
    expect(tree[0].count).toBe(3)
    expect(tree[0].children!.map((n) => n.key)).toEqual(['header', 'body'])
    expect(tree[0].children![0].rows.map((r) => r.rule)).toEqual(['r1', 'r4'])
    expect(tree[1].children![0].rows.map((r) => r.rule)).toEqual(['r3'])
  })

  test('single key yields one level of leaves', () => {
    const tree = buildTree(rows, ['file'])
    expect(tree).toHaveLength(2)
    expect(tree[0].children).toBeNull()
    expect(tree[0].rows).toHaveLength(3)
  })

  test('missing key values group under the empty string', () => {
    const tree = buildTree([{ rule: 'r1' }], ['file'])
    expect(tree[0].key).toBe('')
    expect(tree[0].rows).toHaveLength(1)
  })

  test('empty groupBy yields no nodes', () => {
    expect(buildTree(rows, [])).toEqual([])
  })
})

describe('renderCell', () => {
  test('resolves a link cell to an href and encoded value text', () => {
    const cell = renderCell('b1', undefined, { link_template: '{jenkins}/job/{value}' }, bases)
    expect(cell.href).toBe('https://jenkins.internal.example.com/job/b1')
    expect(cell.text).toBe('b1')
    expect(cell.title).toBeNull()
  })

  test('falls back to null href when the template cannot resolve (missing base)', () => {
    const cell = renderCell('DK-1', undefined, { link_template: '{jira}/browse/{value}' }, bases)
    expect(cell.href).toBeNull()
    expect(cell.text).toBe('DK-1')
  })

  test('falls back to null href when a referenced row field is missing', () => {
    const cell = renderCell(
      'b1',
      { job_name: undefined },
      { link_template: '{jenkins}/job/{row.job_name}/{value}' },
      bases,
    )
    expect(cell.href).toBeNull()
  })

  test('maps a badge value through its color map', () => {
    const cell = renderCell(
      'shipped',
      undefined,
      { badge_colors: { shipped: 'green', '*': 'gray' } },
      bases,
    )
    expect(cell.badge).toBe('green')
  })

  test('falls back to the wildcard badge color for an unmapped value', () => {
    const cell = renderCell(
      'unknown',
      undefined,
      { badge_colors: { shipped: 'green', '*': 'gray' } },
      bases,
    )
    expect(cell.badge).toBe('gray')
  })

  test('returns a null badge for an unmapped value with no wildcard', () => {
    const cell = renderCell('unknown', undefined, { badge_colors: { shipped: 'green' } }, bases)
    expect(cell.badge).toBeNull()
  })

  test('leaves badge null when no badge_colors are configured', () => {
    const cell = renderCell('shipped', undefined, {}, bases)
    expect(cell.badge).toBeNull()
  })

  test('formats the display text and puts the raw value in the title when there is no hint', () => {
    const cell = renderCell(1536, undefined, { format: 'bytes' }, bases)
    expect(cell.text).toBe('1.5 KiB')
    expect(cell.title).toBe('1536')
  })

  test('resolves a hint template into the title, taking priority over the format fallback', () => {
    const cell = renderCell(
      1536,
      { origin: 'upload station' },
      { format: 'bytes', hint: 'from {row.origin}' },
      bases,
    )
    // The hint is plain text, not a URL — the space must survive unencoded.
    expect(cell.title).toBe('from upload station')
  })

  test('omits the title when the hint template does not resolve', () => {
    const cell = renderCell('b1', undefined, { hint: '{jenkins}/job/{row.missing}' }, bases)
    expect(cell.title).toBeNull()
  })

  test('has no title when there is neither a hint nor a format', () => {
    const cell = renderCell('plain', undefined, {}, bases)
    expect(cell.title).toBeNull()
    expect(cell.text).toBe('plain')
  })
})

describe('valueColumns', () => {
  test('filters out the grouping keys', () => {
    const columns = [
      { key: 'file', label: 'File' },
      { key: 'section', label: 'Section' },
      { key: 'score', label: 'Score' },
    ]
    expect(valueColumns(columns, ['file', 'section'])).toEqual([{ key: 'score', label: 'Score' }])
    expect(valueColumns(columns, [])).toEqual(columns)
  })
})
