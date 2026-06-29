// Kafka-UI deep links. Mirrors buildKafkaUiUrl in base.html: given a configured
// Kafka-UI base + cluster + topic, builds a URL that opens the exact message at
// partition:offset. Returns '' when Kafka-UI isn't configured so callers can skip
// rendering the icon (same contract as the reference's makeKafkaUiIcon → null).

import type { RuntimeConfig } from './config'

// The Kafka glyph (24x24 viewBox path), shared by the nav sink-links and the
// per-offset Kafka-UI deep-link icon so they stay visually identical.
export const KAFKA_ICON_PATH =
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15.5v-2.04c-1.73-.23-3.23-1.2-4.07-2.63l1.5-1.12c.6 1.03 1.52 1.76 2.57 1.97V9.62c-2.28-.46-4-2.5-4-4.93h2c0 1.66 1.12 3.05 2.64 3.46l.36.08V4h2v4.23l.36-.08C14.88 7.74 16 6.35 16 4.69h2c0 2.43-1.72 4.47-4 4.93v4.06c1.05-.21 1.97-.94 2.57-1.97l1.5 1.12c-.84 1.43-2.34 2.4-4.07 2.63v2.04h-2z'

export function kafkaUiUrl(
  cfg: Pick<RuntimeConfig, 'kafkaUiBase' | 'kafkaUiCluster' | 'kafkaSourceTopic'>,
  partition: number,
  offset: number,
  topic?: string,
): string {
  const t = topic || cfg.kafkaSourceTopic
  if (!cfg.kafkaUiBase || !cfg.kafkaUiCluster || !t) return ''
  return (
    `${cfg.kafkaUiBase}/ui/clusters/${encodeURIComponent(cfg.kafkaUiCluster)}` +
    `/all-topics/${encodeURIComponent(t)}` +
    `/messages?seekType=OFFSET&seekTo=${partition}%3A%3A${offset}&limit=1`
  )
}
