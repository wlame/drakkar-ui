// Runtime config the pages need but that isn't tied to a single record — in the
// Python reference these were Jinja template globals injected per request
// (kafka_ui_*, max_ui_rows, ws_min_duration_ms, hook flags, cache-enabled). The
// versioned contract is expected to surface them via an overview/config endpoint;
// until a response populates this store the values stay at safe defaults (Kafka-UI
// deep links simply don't render, the cache tab hides, etc.). Pages call
// setConfig() with whatever a real response carries — nothing here guesses an
// endpoint, so there's no speculative 404.

import { writable } from 'svelte/store'

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
