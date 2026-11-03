import { describe, expect, it } from 'vitest'
import {
  cardLink,
  clusterHashText,
  featureNames,
  groupByCluster,
  leaseAgeText,
  lastSlotText,
  leaseStatusText,
  livenessText,
  registryLine,
  timeLeftText,
} from './autodiscover'
import type { CardRow, LeaseRow, RegistryStatus } from './types'

const clock = (epoch: number) => new Date(epoch * 1000).toISOString().slice(11, 16)

function card(worker: string, cluster: string, url = `http://${worker}:8080/`): CardRow {
  return {
    worker,
    instance: 'i',
    cluster,
    state: 'running',
    backend: null,
    version: null,
    url,
    started_at: null,
    heartbeat_at: null,
    age_seconds: null,
    online: null,
    key: null,
    features: {},
  }
}

function lease(extra: Partial<LeaseRow>): LeaseRow {
  return {
    task: 't',
    scope: 'c/t',
    system: false,
    lease_seconds: 60,
    next_slot_ts: 3600,
    last_slot: null,
    status: 'free',
    holder: null,
    key: null,
    ...extra,
  }
}

describe('autodiscover', () => {
  it('groups cards by cluster in the order they came', () => {
    const groups = groupByCluster([card('a', 'x'), card('b', 'x'), card('c', 'y')])
    expect(groups.map((g) => [g.cluster, g.rows.map((r) => r.worker)])).toEqual([
      ['x', ['a', 'b']],
      ['y', ['c']],
    ])
  })

  it('links only an http(s) card URL', () => {
    expect(cardLink(card('a', 'x'))).toBe('http://a:8080')
    expect(cardLink(card('a', 'x', 'javascript:alert(1)'))).toBeNull()
    expect(cardLink(card('a', 'x', '/relative'))).toBeNull()
  })

  it('writes the registry line', () => {
    const registry: RegistryStatus = {
      provider: 'filesystem',
      connection: null,
      started: false,
      refreshed_at: null,
      last_publish_at: '2026-11-08T10:00:00.000000Z',
      breaker_open: true,
      offline_after_seconds: 60,
    }
    expect(registryLine(registry, clock)).toBe(
      'filesystem · not started · last refresh never · last publish 10:00 · breaker open',
    )
  })

  it('writes liveness and time left', () => {
    expect([livenessText(true), livenessText(false), livenessText(null)]).toEqual([
      'online',
      'offline',
      'unknown',
    ])
    expect([timeLeftText(null), timeLeftText(41.5), timeLeftText(-30.2)]).toEqual([
      '-',
      '42s',
      'expired 30s ago',
    ])
  })

  it('says what each lease status means', () => {
    const holder = {
      worker: 'w-2',
      instance: null,
      acquired_at: null,
      age_seconds: null,
      expires_in_seconds: null,
    }
    expect(leaseStatusText(lease({ status: 'held', holder }), clock)).toBe('held by w-2')
    expect(
      leaseStatusText(lease({ status: 'held', holder: { ...holder, worker: null } }), clock),
    ).toBe('held by an unknown holder')
    expect(leaseStatusText(lease({ status: 'free' }), clock)).toBe('free')
    expect(leaseStatusText(lease({ status: 'not_started' }), clock)).toBe(
      'the election starts at the first slot (01:00)',
    )
    expect(leaseStatusText(lease({ status: 'not_started', next_slot_ts: null }), clock)).toBe(
      'the election starts at the first slot',
    )
    expect(leaseStatusText(lease({ status: 'breaker_open' }), clock)).toBe(
      'breaker open: the store was not asked',
    )
    expect(leaseStatusText(lease({ status: 'failed' }), clock)).toBe(
      'the read failed or did not answer',
    )
    expect(leaseStatusText(lease({ status: 'later' }), clock)).toBe('later')
  })

  it('writes the last slot', () => {
    expect(lastSlotText(lease({}), clock)).toBe('-')
    expect(
      lastSlotText(lease({ last_slot: { slot: 7200, outcome: 'held_elsewhere', at: 'x' } }), clock),
    ).toBe('held elsewhere at 02:00')
  })
})

describe('autodiscover columns', () => {
  it('reads the cluster task hash and the feature names of a card', () => {
    const withFeatures = {
      ...card('a', 'x'),
      features: { ui: true, periodic: { cluster_hash: '0123456789abcdef' }, cache: {} },
    }
    expect(clusterHashText(withFeatures)).toBe('0123456789abcdef')
    expect(featureNames(withFeatures)).toBe('cache, periodic, ui')
    expect(clusterHashText(card('a', 'x'))).toBe('-')
    expect(featureNames(card('a', 'x'))).toBe('-')
    expect(clusterHashText({ ...card('a', 'x'), features: { periodic: 'bad' } })).toBe('-')
  })

  it('marks an approximate lease age with a tilde', () => {
    const holder = { worker: 'w', instance: null, acquired_at: null, expires_in_seconds: null }
    expect(leaseAgeText(null)).toBe('-')
    expect(leaseAgeText({ ...holder, age_seconds: null })).toBe('-')
    expect(leaseAgeText({ ...holder, age_seconds: 12.4 })).toBe('12s')
    expect(leaseAgeText({ ...holder, age_seconds: 12.4, age_approximate: true })).toBe('~12s')
  })

  it('says a busy row should be read again', () => {
    expect(leaseStatusText(lease({ status: 'busy' }), clock)).toBe(
      'another read runs on this worker; refresh again',
    )
  })
})
