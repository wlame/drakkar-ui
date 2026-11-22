import { describe, expect, it } from 'vitest'
import { partitionLabel } from './partitions'

describe('partitionLabel', () => {
  it.each([
    [1000003, 1000000, 'parts 3'],
    [1000000, 1000000, 'parts 0'],
    [7, 1000000, '7'],
    [1000003, null, '1000003'],
    [1000003, undefined, '1000003'],
    [-1, 1000000, '-1'],
  ])('partitionLabel(%s, %s) is %s', (partition, base, expected) => {
    expect(partitionLabel(partition, base)).toBe(expected)
  })
})
