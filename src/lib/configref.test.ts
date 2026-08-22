import { describe, it, expect } from 'vitest'
import { changedCount, docsUrl, filterGroups, fmtValue } from './configref'
import type { ConfigReferenceEntry, ConfigReferenceGroup } from './types'

function entry(overrides: Partial<ConfigReferenceEntry> = {}): ConfigReferenceEntry {
  return {
    path: 'kafka.brokers',
    env: 'DRAKKAR_KAFKA_BROKERS',
    description: 'Broker list',
    full_description: 'Comma-separated list of Kafka bootstrap brokers.',
    type: 'string',
    value: 'localhost:9092',
    default: 'localhost:9092',
    is_default: true,
    secret: false,
    ...overrides,
  }
}

function group(overrides: Partial<ConfigReferenceGroup> = {}): ConfigReferenceGroup {
  return {
    key: 'kafka',
    title: 'Kafka',
    doc_anchor: 'kafka',
    entries: [entry()],
    ...overrides,
  }
}

describe('filterGroups', () => {
  it('returns every group unchanged (structurally) when query is empty and changedOnly is off', () => {
    const groups = [group()]
    const result = filterGroups(groups, '', false)
    expect(result).toEqual(groups)
  })

  it('matches a query against the path', () => {
    const groups = [
      group({
        entries: [
          entry({ path: 'kafka.brokers' }),
          entry({
            path: 'ui.port',
            env: 'DRAKKAR_UI_PORT',
            description: 'Port',
            full_description: 'HTTP port.',
          }),
        ],
      }),
    ]
    const result = filterGroups(groups, 'brokers', false)
    expect(result[0].entries.map((e) => e.path)).toEqual(['kafka.brokers'])
  })

  it('matches a query against the env var', () => {
    const groups = [
      group({
        entries: [
          entry({ path: 'a', env: 'DRAKKAR_KAFKA_BROKERS' }),
          entry({ path: 'b', env: 'DRAKKAR_UI_PORT' }),
        ],
      }),
    ]
    const result = filterGroups(groups, 'ui_port', false)
    expect(result[0].entries.map((e) => e.path)).toEqual(['b'])
  })

  it('matches a query against description and full_description', () => {
    const groups = [
      group({
        entries: [
          entry({ path: 'a', description: 'Broker list', full_description: 'nothing special' }),
          entry({
            path: 'b',
            description: 'irrelevant',
            full_description: 'Contains a rare marker word.',
          }),
        ],
      }),
    ]
    expect(filterGroups(groups, 'broker list', false)[0].entries.map((e) => e.path)).toEqual(['a'])
    expect(filterGroups(groups, 'rare marker', false)[0].entries.map((e) => e.path)).toEqual(['b'])
  })

  it('matches case-insensitively', () => {
    const groups = [group({ entries: [entry({ path: 'Kafka.Brokers' })] })]
    expect(filterGroups(groups, 'KAFKA.brokers', false)).toHaveLength(1)
    expect(filterGroups(groups, 'kafka.BROKERS', false)[0].entries).toHaveLength(1)
  })

  it('handles a null env without throwing and without matching an unrelated query', () => {
    const groups = [group({ entries: [entry({ path: 'sinks.kafka.*.topic', env: null })] })]
    expect(() => filterGroups(groups, 'anything', false)).not.toThrow()
    expect(filterGroups(groups, 'topic', false)).toHaveLength(1)
  })

  it('changedOnly keeps only entries with is_default === false', () => {
    const groups = [
      group({
        entries: [
          entry({ path: 'a', is_default: true }),
          entry({ path: 'b', is_default: false }),
          entry({ path: 'c', is_default: true }),
        ],
      }),
    ]
    const result = filterGroups(groups, '', true)
    expect(result[0].entries.map((e) => e.path)).toEqual(['b'])
  })

  it('drops a group whose every entry is filtered out', () => {
    const groups = [
      group({ key: 'kafka', entries: [entry({ path: 'a', is_default: true })] }),
      group({ key: 'ui', entries: [entry({ path: 'b', is_default: false })] }),
    ]
    const result = filterGroups(groups, '', true)
    expect(result.map((g) => g.key)).toEqual(['ui'])
  })

  it('combines a search query with changedOnly', () => {
    const groups = [
      group({
        entries: [
          entry({ path: 'kafka.brokers', is_default: false }),
          entry({ path: 'kafka.timeout', is_default: true }),
          entry({
            path: 'ui.port',
            is_default: false,
            env: 'DRAKKAR_UI_PORT',
            description: 'Port',
            full_description: 'HTTP port.',
          }),
        ],
      }),
    ]
    const result = filterGroups(groups, 'kafka', true)
    expect(result[0].entries.map((e) => e.path)).toEqual(['kafka.brokers'])
  })

  it('never mutates the input groups or entries', () => {
    const original = [
      group({ entries: [entry({ path: 'a' }), entry({ path: 'b', is_default: false })] }),
    ]
    const snapshot = JSON.parse(JSON.stringify(original))
    filterGroups(original, 'a', true)
    expect(original).toEqual(snapshot)
  })
})

describe('changedCount', () => {
  it('counts entries with is_default === false across all groups', () => {
    const groups = [
      group({ key: 'kafka', entries: [entry({ is_default: false }), entry({ is_default: true })] }),
      group({ key: 'ui', entries: [entry({ is_default: false }), entry({ is_default: false })] }),
    ]
    expect(changedCount(groups)).toBe(3)
  })

  it('returns 0 for no groups or all-default groups', () => {
    expect(changedCount([])).toBe(0)
    expect(changedCount([group({ entries: [entry({ is_default: true })] })])).toBe(0)
  })

  it('treats a template entry (is_default true) as not changed', () => {
    const groups = [
      group({ entries: [entry({ path: 'sinks.kafka.*.topic', value: null, is_default: true })] }),
    ]
    expect(changedCount(groups)).toBe(0)
  })
})

describe('fmtValue', () => {
  it('renders null and undefined as an em dash', () => {
    expect(fmtValue(null)).toBe('—')
    expect(fmtValue(undefined)).toBe('—')
  })

  it('renders a short string verbatim, unquoted', () => {
    expect(fmtValue('localhost:9092')).toBe('localhost:9092')
  })

  it('renders numbers and booleans via JSON.stringify', () => {
    expect(fmtValue(42)).toBe('42')
    expect(fmtValue(true)).toBe('true')
  })

  it('renders an object as compact JSON', () => {
    expect(fmtValue({ a: 1, b: [1, 2, 3] })).toBe('{"a":1,"b":[1,2,3]}')
  })

  it('truncates a long string at ~120 chars with an ellipsis', () => {
    const long = 'x'.repeat(200)
    const result = fmtValue(long)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBe(121) // 120 chars + the ellipsis marker
  })

  it('does not truncate a value at or under the limit', () => {
    const exact = 'x'.repeat(120)
    expect(fmtValue(exact)).toBe(exact)
  })

  it('truncates a long JSON-serialized object too', () => {
    const bigDict = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`key${i}`, i]))
    const result = fmtValue(bigDict)
    expect(result.endsWith('…')).toBe(true)
    expect(result.length).toBe(121)
  })
})

describe('docsUrl', () => {
  it('builds the config-reference doc-site anchor link', () => {
    expect(docsUrl('kafka')).toBe('https://wlame.github.io/drakkar/config-reference/#kafka')
  })

  it('passes an arbitrary anchor through unmodified', () => {
    expect(docsUrl('sinks-mongo')).toBe(
      'https://wlame.github.io/drakkar/config-reference/#sinks-mongo',
    )
  })

  it('links the app group anchor to the standalone app-config page (v1.17)', () => {
    expect(docsUrl('app-config')).toBe('https://wlame.github.io/drakkar/app-config/')
  })
})
