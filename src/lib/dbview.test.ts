// URL state of the Databases tab: parse with defaults, drop bad values,
// write while keeping foreign keys such as the token.
import { describe, expect, it } from 'vitest'
import { DB_DEFAULTS, isPartitionText, isPushChange, parseDbView, writeDbView } from './dbview'

describe('parseDbView', () => {
  it('gives the defaults for an empty query', () => {
    expect(parseDbView('')).toEqual(DB_DEFAULTS)
  })

  it('reads the owned keys and ignores the others', () => {
    const state = parseDbView(
      '?token=t&db_view=slice&db_worker=w-2&db_history_worker=w-3&db_range=1h&db_types=task_failed,task_completed&db_partition=7&db_offsets=10-20&db_scope=cluster&db_sources=memory,files',
    )
    expect(state).toMatchObject({
      view: 'slice',
      worker: 'w-2',
      historyWorker: 'w-3',
      range: '1h',
      types: ['task_failed', 'task_completed'],
      partition: 7,
      offsets: '10-20',
      scope: 'cluster',
      sources: ['memory', 'files'],
    })
  })

  it('drops a bad value to its default', () => {
    const state = parseDbView(
      'db_view=nope&db_range=3d&db_from=abc&db_to=5&db_types=ok,Bad Type&db_partition=-1&db_offsets=5-&db_sources=memory,tape&db_history_worker=',
    )
    expect(state).toEqual(DB_DEFAULTS)
  })

  it('keeps from and to only as a pair with to after from', () => {
    expect(parseDbView('db_from=100&db_to=200')).toMatchObject({ from: 100, to: 200 })
    expect(parseDbView('db_from=100')).toMatchObject({ from: null, to: null })
    expect(parseDbView('db_from=200&db_to=100')).toMatchObject({ from: null, to: null })
  })
})

describe('writeDbView', () => {
  it('sets keys and keeps the token and unknown keys', () => {
    expect(writeDbView('?token=t&x=1', { worker: 'w-2' })).toBe('token=t&x=1&db_worker=w-2')
  })

  it('clears a key set to null or to its default', () => {
    expect(writeDbView('db_worker=w-2&db_view=slice', { worker: null, view: 'files' })).toBe('')
  })

  it('writes a list as a comma list', () => {
    expect(writeDbView('', { types: ['a', 'b'] })).toBe('db_types=a%2Cb')
  })

  it('writes the history worker filter as a replace, not a push', () => {
    expect(writeDbView('db_view=files', { historyWorker: 'w-3' })).toBe(
      'db_view=files&db_history_worker=w-3',
    )
    expect(isPushChange({ historyWorker: 'w-3' })).toBe(false)
  })

  it('round-trips through parse', () => {
    const query = writeDbView('', { view: 'slice', worker: '*', partition: 3 })
    expect(parseDbView(query)).toMatchObject({ view: 'slice', worker: '*', partition: 3 })
  })
})

describe('isPartitionText', () => {
  it('takes a whole number from 0 to 2147483647 only', () => {
    expect(isPartitionText('0')).toBe(true)
    expect(isPartitionText('2147483647')).toBe(true)
    expect(isPartitionText('2147483648')).toBe(false)
    expect(isPartitionText('1.5')).toBe(false)
    expect(isPartitionText('-1')).toBe(false)
    expect(isPartitionText('')).toBe(false)
  })
})

describe('isPushChange', () => {
  it('pushes for the view and the worker, replaces for the rest', () => {
    expect(isPushChange({ view: 'slice' })).toBe(true)
    expect(isPushChange({ worker: 'w-2' })).toBe(true)
    expect(isPushChange({ range: '1h' })).toBe(false)
    expect(isPushChange({ types: ['a'] })).toBe(false)
  })
})
