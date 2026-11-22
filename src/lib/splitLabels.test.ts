import { describe, expect, it } from 'vitest'
import { parseTraceLabelHash, splitTaskKind, traceLabelHash } from './splitLabels'

describe('splitTaskKind', () => {
  it.each([
    [{ split_part: '12' }, 'part'],
    [{ split_part: 'local' }, 'local'],
    [{ split_part: 'x' }, null],
    [{ other: '1' }, null],
    [null, null],
    [undefined, null],
  ])('%j is %s', (labels, expected) => {
    expect(splitTaskKind(labels)).toBe(expected)
  })
})

describe('trace label hash', () => {
  it('encodes the value', () => {
    expect(traceLabelHash('split_job', '7:500')).toBe('#trace-label/split_job=7%3A500')
  })
  it('round-trips', () => {
    expect(parseTraceLabelHash(traceLabelHash('split_job', '7:500'))).toEqual({
      key: 'split_job',
      value: '7:500',
    })
    expect(parseTraceLabelHash(traceLabelHash('k', 'a=b&c'))).toEqual({ key: 'k', value: 'a=b&c' })
  })
  it.each(['#trace/1/2', '#trace-label/novalue', '#trace-label/k=', '#trace-label/k=%E0%A4%A'])(
    'refuses %s',
    (fragment) => {
      expect(parseTraceLabelHash(fragment)).toBeNull()
    },
  )
})
