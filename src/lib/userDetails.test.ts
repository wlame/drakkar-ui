import { describe, expect, test } from 'vitest'
import type { ProbeDetailsWrite } from './types'
import {
  columnNumeric,
  groupedRows,
  normalizeStage,
  stageBadges,
  tableAccessors,
  touchedFields,
} from './userDetails'

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
  test('yields [group, rows] pairs in key insertion order', () => {
    const value = {
      'first_input_file.csv': [{ item_id: 'a' }],
      'second_input_file.csv': [{ item_id: 'b' }, { item_id: 'c' }],
    }
    expect(groupedRows(value)).toEqual([
      ['first_input_file.csv', [{ item_id: 'a' }]],
      ['second_input_file.csv', [{ item_id: 'b' }, { item_id: 'c' }]],
    ])
  })
  test('degrades absent or malformed values to no groups', () => {
    expect(groupedRows(undefined)).toEqual([])
    expect(groupedRows(null)).toEqual([])
    expect(groupedRows('text')).toEqual([])
    expect(groupedRows([{ item_id: 'a' }])).toEqual([])
  })
  test('degrades a non-array group value to empty rows', () => {
    expect(groupedRows({ broken_group: 'oops' })).toEqual([['broken_group', []]])
  })
})
