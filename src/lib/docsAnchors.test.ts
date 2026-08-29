import { afterEach, describe, expect, it } from 'vitest'

import {
  anchorForEvent,
  anchorForLabel,
  anchorForPage,
  anchorForSink,
  docsUrl,
  getDocsConfig,
  setDocsConfig,
} from './docsAnchors'
import type { DocsConfig } from './types'

const config: DocsConfig = {
  title: 'Ranking Pipeline Docs',
  anchors: [
    { match: { label: 'module' }, path: 'architecture/modules/', title: 'Modules' },
    {
      match: { label: 'module', value: 'vendor' },
      path: 'architecture/scanners/#vendor-scanning',
      title: 'Vendor scanning',
    },
    { match: { sink: 'primary_results_topic' }, path: 'sinks/kafka.html' },
    { match: { event: 'task_failed' }, path: 'events/#task-failed' },
    { match: { page: 'throughput' }, path: 'pages/throughput/' },
  ],
}

afterEach(() => {
  setDocsConfig(null)
})

describe('setDocsConfig / getDocsConfig', () => {
  it('round-trips the stored config and resets to null', () => {
    setDocsConfig(config)
    expect(getDocsConfig()).toEqual(config)

    setDocsConfig(null)
    expect(getDocsConfig()).toBeNull()
  })

  it('replaces the previous index when a new config is set', () => {
    setDocsConfig(config)
    expect(anchorForSink('primary_results_topic')).not.toBeNull()

    setDocsConfig({ title: 'Other Docs', anchors: [{ match: { sink: 'other' }, path: 'o.html' }] })
    expect(anchorForSink('primary_results_topic')).toBeNull()
    expect(anchorForSink('other')?.path).toBe('o.html')
  })
})

describe('docsUrl', () => {
  it('prefixes the site mount and keeps the fragment', () => {
    expect(docsUrl('a/b.html#x')).toBe('/docs/a/b.html#x')
  })

  it('never emits a double slash for a path that already leads with one', () => {
    expect(docsUrl('/a/b')).toBe('/docs/a/b')
  })

  it('returns the bare mount for an empty path', () => {
    expect(docsUrl('')).toBe('/docs/')
  })
})

describe('anchorForLabel', () => {
  it('returns the key-wide anchor when no value is given', () => {
    setDocsConfig(config)
    expect(anchorForLabel('module')?.path).toBe('architecture/modules/')
  })

  it('prefers the value-specific anchor over the key-wide one', () => {
    setDocsConfig(config)
    expect(anchorForLabel('module', 'vendor')?.path).toBe('architecture/scanners/#vendor-scanning')
  })

  it('falls back to the key-wide anchor for an undeclared value', () => {
    setDocsConfig(config)
    expect(anchorForLabel('module', 'other')?.path).toBe('architecture/modules/')
  })

  it('returns null for an unknown label key', () => {
    setDocsConfig(config)
    expect(anchorForLabel('unknown_label')).toBeNull()
  })

  it('returns null when no config is set', () => {
    expect(anchorForLabel('module')).toBeNull()
  })

  it('returns null when only a value-specific anchor exists and no value is given', () => {
    setDocsConfig({
      title: 'Docs',
      anchors: [{ match: { label: 'module', value: 'vendor' }, path: 'v.html' }],
    })
    expect(anchorForLabel('module')).toBeNull()
    expect(anchorForLabel('module', 'vendor')?.path).toBe('v.html')
  })
})

describe('anchorForSink / anchorForEvent / anchorForPage', () => {
  it('resolves each single-key match kind', () => {
    setDocsConfig(config)
    expect(anchorForSink('primary_results_topic')?.path).toBe('sinks/kafka.html')
    expect(anchorForEvent('task_failed')?.path).toBe('events/#task-failed')
    expect(anchorForPage('throughput')?.path).toBe('pages/throughput/')
  })

  it('returns null for unknown names and for a null config', () => {
    setDocsConfig(config)
    expect(anchorForSink('nope')).toBeNull()
    expect(anchorForEvent('nope')).toBeNull()
    expect(anchorForPage('nope')).toBeNull()

    setDocsConfig(null)
    expect(anchorForSink('primary_results_topic')).toBeNull()
  })

  it('does not cross match kinds — a sink name never matches an event anchor', () => {
    setDocsConfig(config)
    expect(anchorForEvent('primary_results_topic')).toBeNull()
    expect(anchorForPage('task_failed')).toBeNull()
  })
})

describe('malformed entries', () => {
  it('skips entries without a usable path and keeps the good ones', () => {
    setDocsConfig({
      title: 'Docs',
      anchors: [
        { match: { sink: 'broken_sink' } },
        { match: { sink: 'blank_path_sink' }, path: '   ' },
        { match: { sink: 'wrong_path_type' }, path: 42 },
        { match: { sink: 'good_sink' }, path: 'sinks/good.html' },
      ] as unknown as DocsConfig['anchors'],
    })

    expect(anchorForSink('broken_sink')).toBeNull()
    expect(anchorForSink('blank_path_sink')).toBeNull()
    expect(anchorForSink('wrong_path_type')).toBeNull()
    expect(anchorForSink('good_sink')?.path).toBe('sinks/good.html')
  })

  it('skips an anchor whose path escapes the docs mount', () => {
    setDocsConfig({
      title: 'Docs',
      anchors: [
        { match: { sink: 'escaping_sink' }, path: '../../admin' },
        { match: { page: 'escaping_page' }, path: 'guide/../../etc/passwd' },
        { match: { event: 'contained_event' }, path: 'events/#task-failed' },
      ],
    })

    expect(anchorForSink('escaping_sink')).toBeNull()
    expect(anchorForPage('escaping_page')).toBeNull()
    expect(anchorForEvent('contained_event')?.path).toBe('events/#task-failed')
  })

  it('tolerates a missing or non-array anchors list and non-object entries', () => {
    setDocsConfig({ title: 'Docs' } as unknown as DocsConfig)
    expect(anchorForSink('any')).toBeNull()

    setDocsConfig({ title: 'Docs', anchors: [null, 'nope', { path: 'p.html' }] as never })
    expect(anchorForSink('any')).toBeNull()
    expect(anchorForLabel('any')).toBeNull()
  })
})
