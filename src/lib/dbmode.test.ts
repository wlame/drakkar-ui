import { describe, expect, it } from 'vitest'
import { fmtSpan, historyCleanupNote, modeStrip } from './dbmode'
import type { RecorderStatus } from './types'

const clock = (ts: number) => `@${ts}`

function sqliteRecorder(
  archive: Partial<NonNullable<RecorderStatus['sqlite']>['archive']> = {},
): RecorderStatus {
  return {
    enabled: true,
    provider: 'sqlite',
    memory: { window_seconds: 120, max_rows: 12000, max_bytes: 268435456 },
    sqlite: {
      rotation_interval_seconds: 3600,
      archive: {
        enabled: true,
        scope: 'cluster',
        next_slot_ts: 1760432400,
        window_seconds: 86400,
        due_after_seconds: 172800,
        retention_days: 30,
        merged_retention_days: 7,
        ...archive,
      },
    },
    postgres: null,
  }
}

const postgresRecorder: RecorderStatus = {
  enabled: true,
  provider: 'postgres',
  memory: { window_seconds: 90, max_rows: 1000, max_bytes: 1024 },
  sqlite: null,
  postgres: {
    connection: 'main',
    schema: 'drakkar',
    table: 'fast_recorder_events',
    initial_retention_hours: 6,
    max_size_bytes: 0,
    store_completed_output: false,
    writer: null,
  },
}

const worker = { name: 'w-2', cluster: 'search', instance: '0123456789abcdef' }

describe('fmtSpan', () => {
  it.each([
    [3600, '1h'],
    [7200, '2h'],
    [1800, '30m'],
    [120, '2m'],
    [90, '90s'],
    [0, '0s'],
  ])('writes %i seconds as %s', (seconds, text) => {
    expect(fmtSpan(seconds)).toBe(text)
  })
})

describe('modeStrip', () => {
  it('names the worker, its cluster, the recorder, the archive and the autodiscover provider', () => {
    const caps = { autodiscover: { enabled: true, provider: 'consul' } }
    expect(modeStrip({ worker, recorder: sqliteRecorder() }, caps, clock)).toBe(
      'w-2 · cluster search · recorder sqlite (memory 2m, rotation 1h) · archive: cluster scope, next @1760432400 · autodiscover consul',
    )
  })

  it('says the archive is off when no pass runs', () => {
    const recorder = sqliteRecorder({ scope: null, next_slot_ts: null })
    expect(modeStrip({ worker, recorder }, null, clock)).toBe(
      'w-2 · cluster search · recorder sqlite (memory 2m, rotation 1h) · archive: off',
    )
  })

  it('shows the Postgres table and no archive', () => {
    const caps = { autodiscover: { enabled: false, provider: null } }
    expect(
      modeStrip({ worker: { ...worker, cluster: null }, recorder: postgresRecorder }, caps, clock),
    ).toBe(
      'w-2 · recorder postgres (memory 90s, table drakkar.fast_recorder_events) · autodiscover off',
    )
  })

  it('says the recorder is off', () => {
    const recorder: RecorderStatus = {
      enabled: false,
      provider: 'none',
      memory: null,
      sqlite: null,
      postgres: null,
    }
    expect(modeStrip({ worker, recorder }, undefined, clock)).toBe(
      'w-2 · cluster search · recorder off',
    )
  })

  it('is null for a worker older than v1.30', () => {
    expect(modeStrip({}, null, clock)).toBeNull()
    expect(modeStrip({ worker }, null, clock)).toBeNull()
  })
})

describe('historyCleanupNote', () => {
  it('says when sealed files, archives and merge results leave, and when the next pass runs', () => {
    expect(historyCleanupNote(sqliteRecorder(), clock)).toBe(
      'Sealed files go into an archive 48h after their 24h window ends; archives are deleted after 30 days; ' +
        'merge results are deleted after 7 days. Next archive pass at @1760432400.',
    )
  })

  it('says what is kept for ever', () => {
    const note = historyCleanupNote(
      sqliteRecorder({ retention_days: 0, merged_retention_days: 0 }),
      clock,
    )
    expect(note).toContain('archives are kept for ever; merge results are kept for ever.')
  })

  it('says no pass runs when the archive has no scope', () => {
    expect(historyCleanupNote(sqliteRecorder({ scope: null, next_slot_ts: null }), clock)).toBe(
      'No archive pass runs on this worker: sealed files and merge results stay until someone deletes them.',
    )
  })

  it('is null without a sqlite block', () => {
    expect(historyCleanupNote(postgresRecorder, clock)).toBeNull()
    expect(historyCleanupNote(undefined, clock)).toBeNull()
  })
})
