import { afterEach, describe, expect, it } from 'vitest'
import { api } from './api'
import { isOffsetsText, parseDbView, writeDbView } from './dbview'
import {
  EMPTY_SLICE_FORM,
  buildSliceRequest,
  clusterPlan,
  fromLocalInput,
  perWorkerLinks,
  providerOf,
  resolveBuilder,
  resolveRange,
  sliceFileName,
  sourcesFor,
  toLocalInput,
  validateSliceRequest,
  canSliceCluster,
  type WorkerView,
} from './slices'
import type { OwnDb, SliceRequest } from './types'

const NOW = 1760432460
const base: SliceRequest = { from: 1000, to: 2000 }

const memoryRow = { kind: 'memory' } as OwnDb
const liveRow = { kind: 'live' } as OwnDb
const noHistory = { folders: [] }

describe('slice filters in the URL', () => {
  it('round trips every filter through the db_ keys into the request', () => {
    const query = writeDbView('token=abc', {
      from: 1760430000,
      to: 1760431000,
      scope: 'worker',
      sources: ['files', 'history'],
      types: ['task_failed', 'task_completed'],
      partition: 3,
      offsets: '100-200',
      labelKey: 'tenant',
    })
    const state = parseDbView(query)
    const request = buildSliceRequest(
      state,
      { ...EMPTY_SLICE_FORM, taskId: 't-1', labelValue: 'a' },
      NOW,
    )
    expect(request).toEqual({
      from: 1760430000,
      to: 1760431000,
      scope: 'worker',
      sources: ['files', 'history'],
      partition: 3,
      offset_from: '100',
      offset_to: '200',
      task_id: 't-1',
      events: ['task_failed', 'task_completed'],
      label_key: 'tenant',
      label_value: 'a',
    })
  })

  it('keeps the task id and the label value out of the URL', () => {
    expect(writeDbView('', { labelKey: 'tenant' })).toBe('db_label_key=tenant')
  })

  it('counts a preset range back from now and prefers an explicit from and to', () => {
    expect(resolveRange({ range: '1h', from: null, to: null }, NOW)).toEqual({
      from: NOW - 3600,
      to: NOW,
    })
    expect(resolveRange({ range: '1h', from: 5, to: 9 }, NOW)).toEqual({ from: 5, to: 9 })
  })

  it('sends no sources for a whole-cluster request and the output, rows and compress options when set', () => {
    const state = parseDbView('db_scope=cluster&db_sources=files')
    const form = { ...EMPTY_SLICE_FORM, output: false, maxRows: 500, compress: true }
    const request = buildSliceRequest(state, form, NOW)
    expect(request.sources).toBeUndefined()
    expect(request).toMatchObject({
      scope: 'cluster',
      output: false,
      max_rows: 500,
      compress: 'gzip',
    })
  })
})

describe('slice links', () => {
  afterEach(() => localStorage.clear())

  it('builds the link of the own worker on the page origin', () => {
    const request: SliceRequest = {
      ...base,
      scope: 'worker',
      sources: ['memory', 'files'],
      events: ['task_failed'],
    }
    expect(api.debugSliceUrl('', request)).toBe(
      '/api/v1/debug/slice?from=1000&to=2000&scope=worker&sources=memory%2Cfiles&events=task_failed',
    )
  })

  it('builds the link of a peer on its own origin with the token', () => {
    localStorage.setItem('drakkar_token', 'tok')
    const url = api.debugSliceUrl('http://w-2:8080', { ...base, output: false, compress: 'gzip' })
    expect(url).toBe(
      'http://w-2:8080/api/v1/debug/slice?from=1000&to=2000&output=0&compress=gzip&token=tok',
    )
  })

  it('names the file by scope and compression', () => {
    const range = { from: 1760430000, to: 1760431000 }
    expect(sliceFileName({ ...range, scope: 'worker' }, { worker: 'w 1', cluster: 'c' })).toBe(
      'w_1-slice-2025-10-14_08-20-00__2025-10-14_08-36-40.db',
    )
    expect(
      sliceFileName(
        { ...range, scope: 'cluster', compress: 'gzip' },
        { worker: 'w-1', cluster: null },
      ),
    ).toBe('default-cluster-slice-2025-10-14_08-20-00__2025-10-14_08-36-40.db.gz')
  })

  it('picks the builder: the picked worker, else this one, nothing for an unknown name', () => {
    const own = { worker: 'w-1', base: '' }
    const targets = [own, { worker: 'w-2', base: 'http://w-2:8080' }]
    expect(resolveBuilder(null, own, targets)).toBe(own)
    expect(resolveBuilder('w-2', own, targets)).toBe(targets[1])
    expect(resolveBuilder('w-9', own, targets)).toBeNull()
  })

  it('gives each worker its own part of a request', () => {
    const targets = [
      { worker: 'w-1', base: '' },
      { worker: 'w-2', base: 'http://w-2:8080' },
    ]
    const links = perWorkerLinks({ ...base, scope: 'cluster' }, targets)
    expect(links.map((l) => [l.worker, l.base, l.request.scope])).toEqual([
      ['w-1', '', 'worker'],
      ['w-2', 'http://w-2:8080', 'worker'],
    ])
  })
})

describe('whole-cluster plan (ruling DB-Q4)', () => {
  const own = { worker: 'w-1', base: '' }
  const targets = [own, { worker: 'w-2', base: 'http://w-2:8080' }]

  it('sqlite: the worker links for the unsealed parts first, then the cluster file', () => {
    const plan = clusterPlan('sqlite', base, own, targets)
    expect(plan.links.map((l) => [l.label, l.request.scope, l.request.sources])).toEqual([
      ['Unsealed part of w-1', 'worker', ['files']],
      ['Unsealed part of w-2', 'worker', ['files']],
      ['Cluster file', 'cluster', undefined],
    ])
  })

  it('postgres: one cluster file, no worker links, and a note about the newest seconds', () => {
    const plan = clusterPlan('postgres', base, own, targets)
    expect(plan.links.map((l) => l.label)).toEqual(['Cluster file'])
    expect(plan.notes.join(' ')).toContain('newest seconds may be missing')
  })

  it('recorder off: memory links per worker and no cluster file', () => {
    const plan = clusterPlan('none', base, own, targets)
    expect(plan.links.map((l) => [l.label, l.request.sources])).toEqual([
      ['Unsealed part of w-1', ['memory']],
      ['Unsealed part of w-2', ['memory']],
    ])
  })
})

describe('validation (messages and order of the server)', () => {
  const sources = ['memory', 'files', 'history']
  const cases: [string, SliceRequest, string][] = [
    ['not finite', { from: NaN, to: 5 }, 'from and to must be finite numbers of epoch seconds'],
    ['to not after from', { from: 5, to: 5 }, 'to must be greater than from'],
    ['more than 7 days', { from: 0, to: 604801 }, 'the time range is at most 168h'],
    [
      'unknown source',
      { ...base, sources: ['postgres'] },
      "source 'postgres' is not available on this worker; available: files, history, memory",
    ],
    [
      'bad partition',
      { ...base, partition: -1 },
      'partition must be a whole number from 0 to 2147483647',
    ],
    [
      'offsets without partition',
      { ...base, offset_from: '1', offset_to: '2' },
      'offset_from and offset_to need partition',
    ],
    [
      'offsets reversed',
      {
        ...base,
        partition: 0,
        offset_from: '9223372036854775807',
        offset_to: '9223372036854775806',
      },
      'offset_from must not be greater than offset_to',
    ],
    [
      'offset not a whole number',
      { ...base, partition: 0, offset_from: '1.5' },
      'offset_from and offset_to must be whole numbers from -9223372036854775808 to 9223372036854775807',
    ],
    [
      'offset past signed 64 bits',
      { ...base, partition: 0, offset_to: '9223372036854775808' },
      'offset_from and offset_to must be whole numbers from -9223372036854775808 to 9223372036854775807',
    ],
    ['empty task id', { ...base, task_id: '' }, 'task_id must be 1 to 256 characters'],
    [
      'more than 40 events',
      { ...base, events: Array(41).fill('consumed') },
      'events must name at most 40 event types',
    ],
    [
      'bad event',
      { ...base, events: ['Bad Event'] },
      "event 'Bad Event' is not a recorder event type",
    ],
    ['label key alone', { ...base, label_key: 'k' }, 'give label_key and label_value together'],
    [
      'label key with a quote',
      { ...base, label_key: 'a"b', label_value: 'v' },
      'label_key must be 1 to 128 characters without " or \\',
    ],
    [
      'empty label value',
      { ...base, label_key: 'k', label_value: '' },
      'label_value must be 1 to 1024 characters',
    ],
    [
      'too many rows',
      { ...base, max_rows: 1000001 },
      'max_rows must be a whole number from 1 to 1000000',
    ],
  ]
  it.each(cases)('%s', (_name, request, message) => {
    expect(validateSliceRequest(request, sources)).toBe(message)
  })

  it('refuses a bound outside the years a file name can spell', () => {
    expect(validateSliceRequest({ from: -1, to: 10 }, sources)).toBe(
      'from and to must be finite numbers of epoch seconds',
    )
    expect(validateSliceRequest({ from: 253402300000, to: 253402300800 }, sources)).toBe(
      'from and to must be finite numbers of epoch seconds',
    )
    expect(validateSliceRequest({ from: 253402300000, to: 253402300799 }, sources)).toBeNull()
  })

  it('counts characters, not UTF-16 units, as the server does', () => {
    const emoji = '\u{1F600}'
    expect(validateSliceRequest({ ...base, task_id: emoji.repeat(256) }, sources)).toBeNull()
    expect(validateSliceRequest({ ...base, task_id: emoji.repeat(257) }, sources)).toBe(
      'task_id must be 1 to 256 characters',
    )
    expect(
      validateSliceRequest(
        { ...base, label_key: emoji.repeat(128), label_value: emoji.repeat(1024) },
        sources,
      ),
    ).toBeNull()
  })

  it('says none when the worker has no source', () => {
    expect(validateSliceRequest({ ...base, sources: ['memory'] }, [])).toBe(
      "source 'memory' is not available on this worker; available: none",
    )
  })

  it('accepts a good request, and checks sources only for the worker scope', () => {
    expect(validateSliceRequest({ ...base, sources: ['files'] }, sources)).toBeNull()
    expect(
      validateSliceRequest({ ...base, scope: 'cluster', sources: ['postgres'] }, sources),
    ).toBeNull()
  })

  it('reports the first broken rule when several break', () => {
    expect(validateSliceRequest({ from: 5, to: 1, partition: -1 }, sources)).toBe(
      'to must be greater than from',
    )
  })
})

describe('what a worker has', () => {
  const view = (provider: 'none' | 'sqlite' | 'postgres' | null, own: OwnDb[]): WorkerView => ({
    own,
    history: noHistory,
    recorder: provider
      ? { enabled: provider !== 'none', provider, memory: null, sqlite: null, postgres: null }
      : undefined,
  })

  it.each([
    ['sqlite', ['memory', 'files', 'history']],
    ['postgres', ['memory', 'postgres']],
  ] as const)('worker-scope sources with the %s recorder', (provider, expected) => {
    expect(sourcesFor(view(provider, []))).toEqual(expected)
  })

  it('offers memory alone with the recorder off, and nothing without a memory store', () => {
    expect(sourcesFor(view('none', [memoryRow]))).toEqual(['memory'])
    expect(sourcesFor(view('none', []))).toEqual([])
  })

  it('reads the provider from the rows when the answer has no recorder block', () => {
    expect(providerOf(view(null, [liveRow]))).toBe('sqlite')
    expect(providerOf(view(null, [memoryRow]))).toBe('none')
    expect(canSliceCluster(view('none', [memoryRow]))).toBe(false)
    expect(canSliceCluster(view('postgres', []))).toBe(true)
  })
})

describe('local time inputs', () => {
  it('round trips epoch seconds through a datetime-local text', () => {
    const text = toLocalInput(1760432400)
    expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(fromLocalInput(text)).toBe(1760432400)
    expect(fromLocalInput('not a time')).toBeNull()
  })
})

describe('offset text', () => {
  it('takes offsets up to the signed 64-bit maximum and refuses larger ones', () => {
    expect(isOffsetsText('1-9223372036854775807')).toBe(true)
    expect(isOffsetsText('1-9223372036854775808')).toBe(false)
    expect(isOffsetsText('5-')).toBe(false)
  })
})
