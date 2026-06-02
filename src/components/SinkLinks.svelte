<script lang="ts">
  // The header sink-UI-link row: one external-link icon per sink that exposes a
  // UI (Kafka-UI, pgAdmin, etc.), deduped by URL. Mirrors get_sink_ui_links() +
  // the per-type SVGs in the reference nav (base.html). Fetched once on mount;
  // the set rarely changes within a session.
  import { onMount } from 'svelte'
  import { api, type SinkStatus } from '../lib/api'

  interface SinkLink {
    sink_type: string
    name: string
    ui_url: string
  }

  let links = $state<SinkLink[]>([])

  // Per-type icon path (24x24 viewBox), lifted from the reference nav. Types not
  // listed render the generic circle fallback.
  const ICONS: Record<string, string> = {
    kafka:
      'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15.5v-2.04c-1.73-.23-3.23-1.2-4.07-2.63l1.5-1.12c.6 1.03 1.52 1.76 2.57 1.97V9.62c-2.28-.46-4-2.5-4-4.93h2c0 1.66 1.12 3.05 2.64 3.46l.36.08V4h2v4.23l.36-.08C14.88 7.74 16 6.35 16 4.69h2c0 2.43-1.72 4.47-4 4.93v4.06c1.05-.21 1.97-.94 2.57-1.97l1.5 1.12c-.84 1.43-2.34 2.4-4.07 2.63v2.04h-2z',
    postgres:
      'M12 2C8.13 2 5 3.79 5 6v12c0 2.21 3.13 4 7 4s7-1.79 7-4V6c0-2.21-3.13-4-7-4zm0 2c3.04 0 5 1.23 5 2s-1.96 2-5 2-5-1.23-5-2 1.96-2 5-2zm5 14c0 .77-1.96 2-5 2s-5-1.23-5-2v-2.23c1.25.77 3.02 1.23 5 1.23s3.75-.46 5-1.23V18zm0-5c0 .77-1.96 2-5 2s-5-1.23-5-2v-2.23c1.25.77 3.02 1.23 5 1.23s3.75-.46 5-1.23V13zm0-5c0 .77-1.96 2-5 2s-5-1.23-5-2V5.77C8.25 6.54 10.02 7 12 7s3.75-.46 5-1.23V8z',
    mongo:
      'M13.74 4.23c-.84-1.57-1.28-2.49-1.74-3.23-.46.74-.9 1.66-1.74 3.23C8.56 7.55 4 12.46 4 15.91 4 19.82 7.58 23 12 23s8-3.18 8-7.09c0-3.45-4.56-8.36-6.26-11.68zM12 21c-1.1 0-2-.72-2-1.6s.9-1.6 2-1.6 2 .72 2 1.6-.9 1.6-2 1.6z',
    redis: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
    http: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z',
    filesystem: 'M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  }

  async function load() {
    try {
      const sinks: SinkStatus[] = await api.sinks()
      const seen = new Set<string>()
      const out: SinkLink[] = []
      for (const s of sinks) {
        if (!s.ui_url || seen.has(s.ui_url)) continue
        seen.add(s.ui_url)
        out.push({ sink_type: s.sink_type, name: s.name, ui_url: s.ui_url })
      }
      links = out
    } catch {
      // Sink links are non-essential chrome — stay silent on failure.
      links = []
    }
  }

  onMount(load)
</script>

{#if links.length}
  <div class="sink-links">
    {#each links as l}
      <a href={l.ui_url} target="_blank" rel="noopener" title={`${l.sink_type}/${l.name}`} aria-label={`${l.sink_type} UI`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          {#if ICONS[l.sink_type]}
            <path d={ICONS[l.sink_type]} />
          {:else}
            <circle cx="12" cy="12" r="8" />
          {/if}
        </svg>
      </a>
    {/each}
  </div>
{/if}

<style>
  .sink-links {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .sink-links a {
    color: var(--muted);
    display: inline-flex;
    transition: color 120ms ease;
  }
  .sink-links a:hover {
    color: var(--text);
  }
</style>
