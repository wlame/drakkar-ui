import { describe, expect, it } from 'vitest'
import { isPartsPartition, partitionLabel, prefixedPartitionLabel } from './partitions'

describe('partitionLabel', () => {
  it.each([
    [1000003, 1000000, 'parts 3'],
    [1000000, 1000000, 'parts 0'],
    [7, 1000000, '7'],
    [1000003, null, '1000003'],
    [1000003, undefined, '1000003'],
    [-1, 1000000, '-1'],
    [3, 0, '3'],
  ])('partitionLabel(%s, %s) is %s', (partition, base, expected) => {
    expect(partitionLabel(partition, base)).toBe(expected)
  })
})

describe('prefixedPartitionLabel', () => {
  it.each([
    [5, 1000000, 'p', 'p5'],
    [1000003, 1000000, 'p', 'parts 3'],
    [1000003, 1000000, 'P', 'parts 3'],
    [1000003, null, 'P', 'P1000003'],
  ])('prefixedPartitionLabel(%s, %s, %s) is %s', (partition, base, prefix, expected) => {
    expect(prefixedPartitionLabel(partition, base, prefix)).toBe(expected)
  })
})

describe('isPartsPartition', () => {
  it.each([
    [1000003, 1000000, true],
    [1000000, 1000000, true],
    [7, 1000000, false],
    [1000003, null, false],
    [1000003, undefined, false],
    [3, 0, false],
  ])('isPartsPartition(%s, %s) is %s', (partition, base, expected) => {
    expect(isPartsPartition(partition, base)).toBe(expected)
  })
})
