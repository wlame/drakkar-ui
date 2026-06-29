<script lang="ts">
  // Per-offset "open in Kafka-UI" deep-link icon. Renders nothing when Kafka-UI
  // isn't configured (kafkaUiUrl returns ''), matching the reference's
  // makeKafkaUiIcon → null. Click is stopped from bubbling so it never triggers a
  // surrounding row/sidebar handler.
  import { runtimeConfig } from '../lib/config'
  import { kafkaUiUrl, KAFKA_ICON_PATH } from '../lib/kafka'

  let { partition, offset, topic }: { partition: number; offset: number; topic?: string } = $props()

  const url = $derived(kafkaUiUrl($runtimeConfig, partition, offset, topic))
</script>

{#if url}
  <a
    class="kafka-icon"
    href={url}
    target="_blank"
    rel="noopener"
    title={`Open in Kafka-UI (${partition}:${offset})`}
    onclick={(e) => e.stopPropagation()}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={KAFKA_ICON_PATH} /></svg>
  </a>
{/if}

<style>
  .kafka-icon {
    display: inline-flex;
    vertical-align: -2px;
    margin-left: 0.3rem;
    color: var(--muted);
  }
  .kafka-icon:hover {
    color: var(--text);
  }
</style>
