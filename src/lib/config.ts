// Runtime config the pages need but that isn't tied to a single record — in the
// Python reference these were Jinja template globals injected per request
// (kafka_ui_*, max_ui_rows, ws_min_duration_ms, hook flags, cache-enabled). The
// v1 contract surfaces them on GET /api/v1/live/overview; the app hydrates this
// store from it once at boot (see hydrateFromOverview). Until a response lands,
// values stay at safe defaults (Kafka-UI deep links simply don't render, the
// cache tab hides, etc.).

import { writable } from 'svelte/store'
import type { LiveOverview } from './types'

export interface RuntimeConfig {
  // Kafka-UI deep-link config. All three must be set for links to render.
  kafkaUiBase: string
  kafkaUiCluster: string
  kafkaSourceTopic: string
  // Live/History tuning.
  maxUiRows: number
  wsMinDurationMs: number
  // Debug surface.
  cacheEnabled: boolean
}

const DEFAULTS: RuntimeConfig = {
  kafkaUiBase: '',
  kafkaUiCluster: '',
  kafkaSourceTopic: '',
  maxUiRows: 5000,
  wsMinDurationMs: 500,
  cacheEnabled: false,
}

export const runtimeConfig = writable<RuntimeConfig>({ ...DEFAULTS })

// setConfig merges a partial update into the shared config (immutably).
export function setConfig(partial: Partial<RuntimeConfig>): void {
  runtimeConfig.update((cur) => ({ ...cur, ...partial }))
}

// hydrateFromOverview maps a /live/overview payload onto the shared config.
// Called once at app boot (App.svelte) so Kafka-UI deep links and tuning work on
// every page, and again by the Live page whenever it refreshes the overview.
export function hydrateFromOverview(o: LiveOverview): void {
  setConfig({
    ...(o.kafka_ui_base != null ? { kafkaUiBase: o.kafka_ui_base } : {}),
    ...(o.kafka_ui_cluster != null ? { kafkaUiCluster: o.kafka_ui_cluster } : {}),
    ...(o.kafka_source_topic != null ? { kafkaSourceTopic: o.kafka_source_topic } : {}),
    ...(o.max_ui_rows != null ? { maxUiRows: o.max_ui_rows } : {}),
    ...(o.ws_min_duration_ms != null ? { wsMinDurationMs: o.ws_min_duration_ms } : {}),
  })
}
