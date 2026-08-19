// Kafka-read capability, probed lazily and shared app-wide. The backend
// serves /api/v1/debug/kafka/* unless the operator closed it
// (ui.kafka_read_enabled=false → 403) or it predates contract v1.13 (404).
// One probe per session decides both the DLQ tab's visibility and whether
// the per-offset Kafka icons offer the "Probe this message" action —
// mirroring the Debug page's cache-tab capability probe.

import { writable } from 'svelte/store'
import { api } from './api'
import type { KafkaReadTopic } from './types'

// null = not probed yet (callers treat it optimistically); true/false once
// the probe settles. Failure only hides the feature, never surfaces an error.
export const kafkaReadAvailable = writable<boolean | null>(null)

// The alias listing from the probe, for consumers that need it (the DLQ tab
// only appears when the backend actually lists a dlq alias — it always does
// today, but the guard costs nothing and survives future config shapes).
export const kafkaReadTopics = writable<KafkaReadTopic[]>([])

let probed = false

// ensureKafkaReadProbe fires the capability probe once per session. Safe to
// call from every component that cares — subsequent calls are no-ops.
export function ensureKafkaReadProbe(): void {
  if (probed) return
  probed = true
  api
    .kafkaTopics()
    .then((res) => {
      kafkaReadTopics.set(res.topics)
      kafkaReadAvailable.set(true)
    })
    .catch(() => {
      kafkaReadAvailable.set(false)
    })
}

// probeHash builds the Debug-page deep-link that opens the Message Probe tab
// prefilled from Kafka coordinates (the #trace/<p>/<o> idiom, plus an alias).
export function probeHash(alias: string, partition: number, offset: number): string {
  return `#probe/${encodeURIComponent(alias)}/${partition}/${offset}`
}

// resetKafkaReadProbeForTests restores the un-probed state between tests.
export function resetKafkaReadProbeForTests(): void {
  probed = false
  kafkaReadAvailable.set(null)
  kafkaReadTopics.set([])
}
