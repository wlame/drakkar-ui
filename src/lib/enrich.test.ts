import { describe, expect, it } from 'vitest'

import { badgeColor, formatValue, resolveTemplate, resolveText } from './enrich'

const bases = {
  jira: 'https://jira.internal.example.com',
  jenkins: 'https://jenkins.internal.example.com',
}

describe('resolveTemplate', () => {
  it('substitutes value, row fields, and bases with percent-encoding', () => {
    expect(
      resolveTemplate('{jenkins}/job/{row.job_name}/{value}', {
        value: 'build 42',
        row: { job_name: 'nightly/main' },
        bases,
      }),
    ).toBe('https://jenkins.internal.example.com/job/nightly%2Fmain/build%2042')
  })

  it('returns null when a base is missing', () => {
    expect(resolveTemplate('{wiki}/x/{value}', { value: 'a', bases })).toBeNull()
  })

  it('returns null when a row field is missing or null', () => {
    expect(resolveTemplate('{jira}/{row.gone}', { row: {}, bases })).toBeNull()
    expect(resolveTemplate('{jira}/{row.gone}', { row: { gone: null }, bases })).toBeNull()
  })

  it('returns null when value is missing', () => {
    expect(resolveTemplate('{jira}/{value}', { bases })).toBeNull()
  })

  it('does not encode the base itself', () => {
    expect(resolveTemplate('{jira}/browse/{value}', { value: 'DK-1', bases })).toBe(
      'https://jira.internal.example.com/browse/DK-1',
    )
  })
})

describe('resolveText', () => {
  it('substitutes value and row fields literally, without percent-encoding', () => {
    expect(
      resolveText('Order {row.order_id} ({value})', {
        value: 'o 1',
        row: { order_id: 'o 1' },
        bases,
      }),
    ).toBe('Order o 1 (o 1)')
  })

  it('does not encode the base either', () => {
    expect(resolveText('{jenkins}/job/{value}', { value: 'nightly main', bases })).toBe(
      'https://jenkins.internal.example.com/job/nightly main',
    )
  })

  it('returns null when a base is missing', () => {
    expect(resolveText('{wiki}/x/{value}', { value: 'a', bases })).toBeNull()
  })

  it('returns null when a row field is missing or null', () => {
    expect(resolveText('{jira}/{row.gone}', { row: {}, bases })).toBeNull()
    expect(resolveText('{jira}/{row.gone}', { row: { gone: null }, bases })).toBeNull()
  })

  it('returns null when value is missing', () => {
    expect(resolveText('{jira}/{value}', { bases })).toBeNull()
  })
})

describe('formatValue', () => {
  it('renders duration_ms human-readably', () => {
    expect(formatValue('duration_ms', 754)).toBe('754 ms')
    expect(formatValue('duration_ms', 65_000)).toBe('1 m 5 s')
  })
  it('renders sub-minute durations without a minutes component', () => {
    expect(formatValue('duration_ms', 45_000)).toBe('45 s')
  })
  it('renders bytes with binary units', () => {
    expect(formatValue('bytes', 1536)).toBe('1.5 KiB')
    expect(formatValue('bytes', 512)).toBe('512 B')
  })
  it('renders number with thousands separators', () => {
    expect(formatValue('number', 1234567)).toBe('1,234,567')
  })
  it('renders timestamp as canonical datetime', () => {
    expect(formatValue('timestamp', '2026-08-09T10:00:00Z')).toMatch(/2026-08-09/)
    expect(formatValue('timestamp', '2026-08-09T10:00:00Z')).toBe('2026-08-09 10:00:00.000')
  })
  it('passes through on unknown format or non-numeric input', () => {
    expect(formatValue('bytes', 'n/a')).toBe('n/a')
    expect(formatValue('fortnights', 5)).toBe('5')
    expect(formatValue(null, 'plain')).toBe('plain')
  })
})

describe('badgeColor', () => {
  const colors = { shipped: 'green', blocked: 'red', '*': 'gray' }
  it('maps known values', () => expect(badgeColor(colors, 'shipped')).toBe('green'))
  it('falls back to *', () => expect(badgeColor(colors, 'other')).toBe('gray'))
  it('returns null with no mapping and no fallback', () =>
    expect(badgeColor({ shipped: 'green' }, 'other')).toBeNull())
})
