<script lang="ts">
  // Per-offset Kafka action icon. Historically a single-purpose "open in
  // Kafka-UI" deep-link; now an action point with up to two entries:
  //
  //   - "Open in Kafka-UI"     — when kafka_ui_* is configured (as before)
  //   - "Probe this message"   — when the backend serves the kafka-read API
  //     (contract v1.13); opens /debug#probe/<alias>/<p>/<o>, where the
  //     Message Probe tab fetches the record and prefills itself
  //
  // With both available a click opens a small popover menu; with exactly one
  // it goes straight there (no menu ceremony for a single action). With
  // neither, nothing renders — the original contract. Clicks are stopped
  // from bubbling so a surrounding row/sidebar handler never fires.
  import { runtimeConfig } from '../lib/config'
  import { kafkaUiUrl, KAFKA_ICON_PATH } from '../lib/kafka'
  import { ensureKafkaReadProbe, kafkaReadAvailable, probeHash } from '../lib/kafkaRead'
  import { navigate } from '../lib/router'

  let {
    partition,
    offset,
    topic,
    probeAlias = 'source',
  }: {
    partition: number
    offset: number
    topic?: string
    // The kafka-read alias these coordinates live under ('source' for the
    // pipeline input, 'dlq', or a sink instance name). Pass null to drop the
    // probe action — e.g. for links pointing at sink-produced topics, which
    // have no meaningful probe-by-alias addressing.
    probeAlias?: string | null
  } = $props()

  ensureKafkaReadProbe()

  const url = $derived(kafkaUiUrl($runtimeConfig, partition, offset, topic))
  // Optimistic while the capability probe is in flight (null): the icon
  // renders immediately and only disappears if the probe settles on false.
  const probeEnabled = $derived(probeAlias != null && $kafkaReadAvailable !== false)
  const probeTarget = $derived(probeAlias != null ? `/debug${probeHash(probeAlias, partition, offset)}` : '')

  let open = $state(false)
  // bind:this target; $state so Svelte tracks the assignment (the outside-
  // click handler reads it, never the template).
  let root = $state<HTMLSpanElement | undefined>(undefined)

  function goProbe(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    open = false
    navigate(probeTarget)
  }

  function toggle(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    open = !open
  }

  // Close on any click outside the icon+menu, and on Escape. A click target
  // that a concurrent re-render detached from the DOM fails the contains()
  // check and closes the menu — acceptable (the menu anchors to a row that
  // just changed), and it avoids trusting an orphaned event.target.
  $effect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !root?.contains(e.target)) open = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') open = false
    }
    document.addEventListener('click', onDocClick, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onDocClick, true)
      document.removeEventListener('keydown', onKey)
    }
  })
</script>

{#if url && probeEnabled}
  <span class="kafka-wrap" bind:this={root}>
    <button class="kafka-icon" title={`Kafka actions (${partition}:${offset})`} onclick={toggle} aria-haspopup="menu" aria-expanded={open}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={KAFKA_ICON_PATH} /></svg>
    </button>
    {#if open}
      <span class="menu" role="menu">
        <a role="menuitem" href={url} target="_blank" rel="noopener" onclick={(e) => { e.stopPropagation(); open = false }}>Open in Kafka-UI ↗</a>
        <a role="menuitem" href={probeTarget} onclick={goProbe}>Probe this message</a>
      </span>
    {/if}
  </span>
{:else if url}
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
{:else if probeEnabled}
  <a
    class="kafka-icon"
    href={probeTarget}
    title={`Probe this message (${partition}:${offset})`}
    onclick={goProbe}
  >
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d={KAFKA_ICON_PATH} /></svg>
  </a>
{/if}

<style>
  .kafka-wrap {
    position: relative;
    display: inline-flex;
  }
  .kafka-icon {
    display: inline-flex;
    vertical-align: -2px;
    margin-left: 0.3rem;
    color: var(--muted);
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .kafka-icon:hover {
    color: var(--text);
  }
  .menu {
    position: absolute;
    top: 1.2rem;
    left: 0;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 11rem;
    background: var(--bg, #fff);
    border: 1px solid var(--line);
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    padding: 0.25rem;
  }
  .menu a {
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    color: var(--text);
    font-size: 0.8rem;
    text-decoration: none;
    white-space: nowrap;
    text-align: left;
  }
  .menu a:hover {
    background: rgba(13, 148, 136, 0.08);
  }
</style>
