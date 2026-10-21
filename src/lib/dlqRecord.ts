// The facts a backend writes on a DLQ record. A DLQ record is the original
// source message (key and value unchanged) with the source headers first and
// then the dk- headers (contract v1.27, informational: the read endpoint
// passes headers through, so no /api/v1 shape changes). A record written
// before v1.27 has no dk- headers; every fact is then absent.
import type { KafkaReadHeader, KafkaReadMessage } from './types'

export const DK_HEADER_PREFIX = 'dk-'

// One field per dk- header. Absent headers, base64 values and decimals that
// do not parse read as null (deliveredSinks: an empty list).
export interface DlqRecordFacts {
  recordVersion: string | null
  stage: string | null
  error: string | null
  sink: string | null
  taskId: string | null
  attempts: number | null
  deliveredSinks: string[]
  sourceTopic: string | null
  sourcePartition: number | null
  sourceOffset: number | null
  sourceTimestampMs: number | null
  requestId: string | null
  worker: string | null
  instance: string | null
  failedAt: string | null
}

// Where a probe of the record should claim the message came from. A null
// topic means "the configured source topic" (the read API never names the
// raw topic of the record itself).
export interface ProbeCoordinates {
  topic: string | null
  partition: number
  offset: number
  timestampMs: number | null
  fromSourceHeaders: boolean
}

const DECIMAL = /^\d+$/

export function isDkHeader(header: KafkaReadHeader): boolean {
  return header.key.startsWith(DK_HEADER_PREFIX)
}

/** Splits headers into the dk- facts and the source headers, each in record order. */
export function splitDlqHeaders(headers: KafkaReadHeader[]): {
  dk: KafkaReadHeader[]
  source: KafkaReadHeader[]
} {
  return {
    dk: headers.filter(isDkHeader),
    source: headers.filter((h) => !isDkHeader(h)),
  }
}

function headerText(headers: KafkaReadHeader[], name: string): string | null {
  const header = headers.find((h) => h.key === name)
  if (!header || header.value == null || header.value_encoding === 'base64') return null
  return header.value
}

function headerDecimal(headers: KafkaReadHeader[], name: string): number | null {
  const text = headerText(headers, name)
  if (text == null || !DECIMAL.test(text)) return null
  const n = Number(text)
  return Number.isSafeInteger(n) ? n : null
}

/** Parses the dk- headers of a DLQ record into typed facts. */
export function parseDlqRecordFacts(headers: KafkaReadHeader[]): DlqRecordFacts {
  const delivered = headerText(headers, 'dk-delivered-sinks')
  return {
    recordVersion: headerText(headers, 'dk-record-version'),
    stage: headerText(headers, 'dk-stage'),
    error: headerText(headers, 'dk-error'),
    sink: headerText(headers, 'dk-sink'),
    taskId: headerText(headers, 'dk-task-id'),
    attempts: headerDecimal(headers, 'dk-attempts'),
    deliveredSinks: delivered ? delivered.split(',') : [],
    sourceTopic: headerText(headers, 'dk-source-topic'),
    sourcePartition: headerDecimal(headers, 'dk-source-partition'),
    sourceOffset: headerDecimal(headers, 'dk-source-offset'),
    sourceTimestampMs: headerDecimal(headers, 'dk-source-timestamp'),
    requestId: headerText(headers, 'dk-request-id'),
    worker: headerText(headers, 'dk-worker'),
    instance: headerText(headers, 'dk-instance'),
    failedAt: headerText(headers, 'dk-failed-at'),
  }
}

/**
 * Probe coordinates of a record, field by field: each dk-source-* header when
 * present, else the record's own partition, offset and timestamp. An old
 * record has none of the headers and keeps its own coordinates; an HTTP
 * record has only dk-source-timestamp.
 */
export function probeCoordinates(msg: KafkaReadMessage): ProbeCoordinates {
  const facts = parseDlqRecordFacts(msg.headers)
  return {
    topic: facts.sourceTopic,
    partition: facts.sourcePartition ?? msg.partition,
    offset: facts.sourceOffset ?? msg.offset,
    timestampMs: facts.sourceTimestampMs ?? msg.timestamp_ms,
    fromSourceHeaders:
      facts.sourceTopic != null ||
      facts.sourcePartition != null ||
      facts.sourceOffset != null ||
      facts.sourceTimestampMs != null,
  }
}

/**
 * Why the probe cannot take this record, or null when it can: the probe form
 * carries text, and the read API sends a value or key that is not UTF-8 as
 * base64.
 */
export function probeBlockedReason(msg: KafkaReadMessage): string | null {
  const parts: string[] = []
  if (msg.payload_encoding === 'base64') parts.push('the value is binary')
  if (msg.key_encoding === 'base64') parts.push('the key is binary')
  if (!parts.length) return null
  return `Probe is off for this record: ${parts.join(' and ')} (base64), and the probe takes text.`
}
