// DLQ record facts: the dk- headers a backend writes on every DLQ record,
// parsed into typed fields, and the probe coordinates derived from them.
// Header lists mirror the worked records of the backends' DLQ contract.
import { describe, expect, it } from 'vitest'
import {
  parseDlqRecordFacts,
  probeBlockedReason,
  probeCoordinates,
  splitDlqHeaders,
} from './dlqRecord'
import type { KafkaReadHeader, KafkaReadMessage } from './types'

function headers(pairs: [string, string | null][]): KafkaReadHeader[] {
  return pairs.map(([key, value]) => ({
    key,
    value,
    value_encoding: value == null ? null : 'utf-8',
  }))
}

const SINK_RECORD_HEADERS = headers([
  ['x-trace', '1'],
  ['dk-record-version', '1'],
  ['dk-stage', 'sink'],
  ['dk-error', 'connection to postgresql://***:***@db:5432/main refused'],
  ['dk-sink', 'postgres/main_db'],
  ['dk-attempts', '0'],
  ['dk-delivered-sinks', 'kafka/results,redis/cache'],
  ['dk-source-topic', 'orders'],
  ['dk-source-partition', '1'],
  ['dk-source-offset', '77'],
  ['dk-source-timestamp', '1793000000789'],
  ['dk-worker', 'worker-a'],
  ['dk-instance', '0123456789abcdef'],
  ['dk-failed-at', '2026-11-05T10:15:30.123456Z'],
])

const HTTP_RECORD_HEADERS = headers([
  ['dk-record-version', '1'],
  ['dk-stage', 'sink'],
  ['dk-error', 'HTTP 503 Service Unavailable'],
  ['dk-sink', 'http/notify'],
  ['dk-attempts', '3'],
  ['dk-source-timestamp', '1793000001000'],
  ['dk-request-id', 'req_20261105T101530_0042'],
  ['dk-worker', 'worker-a'],
  ['dk-instance', '0123456789abcdef'],
  ['dk-failed-at', '2026-11-05T10:15:30.123456Z'],
])

function dlqMessage(overrides: Partial<KafkaReadMessage> = {}): KafkaReadMessage {
  return {
    alias: 'dlq',
    partition: 4,
    offset: 9,
    timestamp_ms: 1_793_000_005_000,
    key: 'order-18',
    key_encoding: 'utf-8',
    payload: '{"id": 18}',
    payload_encoding: 'utf-8',
    payload_size_bytes: 10,
    headers: [],
    ...overrides,
  }
}

describe('splitDlqHeaders', () => {
  it('splits dk- headers from source headers and keeps the record order', () => {
    const { dk, source } = splitDlqHeaders(SINK_RECORD_HEADERS)
    expect(source.map((h) => h.key)).toEqual(['x-trace'])
    expect(dk.map((h) => h.key)).toEqual(SINK_RECORD_HEADERS.slice(1).map((h) => h.key))
  })
})

describe('parseDlqRecordFacts', () => {
  it('parses every dk- header of a sink record into typed fields', () => {
    expect(parseDlqRecordFacts(SINK_RECORD_HEADERS)).toEqual({
      recordVersion: '1',
      stage: 'sink',
      error: 'connection to postgresql://***:***@db:5432/main refused',
      sink: 'postgres/main_db',
      taskId: null,
      attempts: 0,
      deliveredSinks: ['kafka/results', 'redis/cache'],
      sourceTopic: 'orders',
      sourcePartition: 1,
      sourceOffset: 77,
      sourceTimestampMs: 1_793_000_000_789,
      requestId: null,
      worker: 'worker-a',
      instance: '0123456789abcdef',
      failedAt: '2026-11-05T10:15:30.123456Z',
    })
  })

  it('reads a record without dk- headers as all fields absent', () => {
    const facts = parseDlqRecordFacts(headers([['x-trace', '1']]))
    expect(facts.recordVersion).toBeNull()
    expect(facts.sourcePartition).toBeNull()
    expect(facts.deliveredSinks).toEqual([])
  })

  it.each([
    ['not a number', 'three'],
    ['negative', '-1'],
    ['fraction', '1.5'],
    ['empty', ''],
  ])('treats a %s decimal header as absent', (_case, text) => {
    const facts = parseDlqRecordFacts(headers([['dk-source-partition', text]]))
    expect(facts.sourcePartition).toBeNull()
  })

  it('treats a base64 dk- header as absent', () => {
    const facts = parseDlqRecordFacts([
      { key: 'dk-source-topic', value: 'AP8=', value_encoding: 'base64' },
    ])
    expect(facts.sourceTopic).toBeNull()
  })
})

describe('probeCoordinates', () => {
  it('takes topic, partition, offset and timestamp from the dk-source headers', () => {
    expect(probeCoordinates(dlqMessage({ headers: SINK_RECORD_HEADERS }))).toEqual({
      topic: 'orders',
      partition: 1,
      offset: 77,
      timestampMs: 1_793_000_000_789,
      fromSourceHeaders: true,
    })
  })

  it('falls back to the DLQ coordinates for a record without dk-source headers', () => {
    expect(probeCoordinates(dlqMessage())).toEqual({
      topic: null,
      partition: 4,
      offset: 9,
      timestampMs: 1_793_000_005_000,
      fromSourceHeaders: false,
    })
  })

  it('fills an HTTP record field by field: its timestamp, else the DLQ coordinates', () => {
    expect(probeCoordinates(dlqMessage({ headers: HTTP_RECORD_HEADERS }))).toEqual({
      topic: null,
      partition: 4,
      offset: 9,
      timestampMs: 1_793_000_001_000,
      fromSourceHeaders: true,
    })
  })
})

describe('probeBlockedReason', () => {
  it('lets the probe take a text record', () => {
    expect(probeBlockedReason(dlqMessage())).toBeNull()
  })

  it('names both parts when the value and the key are base64', () => {
    const reason = probeBlockedReason(
      dlqMessage({ payload_encoding: 'base64', key_encoding: 'base64' }),
    )
    expect(reason).toContain('the value is binary and the key is binary')
  })
})
