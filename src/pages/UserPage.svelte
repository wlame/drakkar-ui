<script lang="ts">
  // Shell for a backend-declared page (GET /api/v1/pages, routed at
  // /p/:slug). Resolves the page by slug against the store loaded at boot
  // (App.svelte) and renders its title plus one card per widget, each body
  // rendered by WidgetBody, which reloads whenever this page bumps the
  // widget's refreshSeq (see the live-refresh $effect below).
  import { pageBySlug, uiPages } from '../lib/pages'
  import { refreshEventTypes } from '../lib/widgets'
  import { createLiveSocket, type LiveSocket } from '../lib/ws'
  import type { UIPageWidget, WsEvent } from '../lib/types'
  import WidgetBody from '../components/pages/WidgetBody.svelte'
  import NotFound from './NotFound.svelte'

  let { params = {} }: { params?: Record<string, string> } = $props()

  const slug = $derived(params.slug ?? '')
  const page = $derived(pageBySlug($uiPages, slug))

  // A relevant event within this window collapses with any that follow it
  // into a single refetch, rather than one refetch per event — the same
  // coalesce-once shape Live.svelte's arrange-task lookups use (see
  // queueArrangeLookup there): the timer starts on the FIRST pending event
  // and is not reset by later ones, so a sustained stream still flushes on
  // schedule instead of the refetch being pushed out indefinitely.
  const DEBOUNCE_MS = 500
  // 'stat' widgets have no single WS event that means "this changed" (they
  // sum a metric family), so they poll on a flat cadence instead of
  // subscribing to the socket at all.
  const STAT_INTERVAL_MS = 30_000

  // One reload counter per widget, index-aligned with page.widgets (same
  // indexing the {#each} below already keys on). Bumping an entry is what
  // makes WidgetBody's `refreshSeq` prop change and reload.
  let refreshSeqs = $state<number[]>([])

  function bumpWidgets(indices: Iterable<number>) {
    const next = refreshSeqs.slice()
    for (const i of indices) next[i] = (next[i] ?? 0) + 1
    refreshSeqs = next
  }

  // Opens (at most) one socket and one stat-refresh interval per page,
  // rebuilding both whenever the widget list changes — a slug navigation
  // reuses this same UserPage instance (see routes.ts's <Current>), so this
  // cannot be onMount-once.
  $effect(() => {
    const widgets: UIPageWidget[] = page?.widgets ?? []
    refreshSeqs = widgets.map(() => 0)

    // Stat widgets refresh on the interval below, never through the socket
    // — excluded from both the subscription and the event-matching table.
    const watched = widgets
      .map((w, i) => ({ i, types: w.view === 'stat' ? [] : refreshEventTypes(w) }))
      .filter((w) => w.types.length > 0)
    const unionEventTypes = [...new Set(watched.flatMap((w) => w.types))]

    const statIndices = widgets.flatMap((w, i) => (w.view === 'stat' ? [i] : []))

    let socket: LiveSocket | null = null
    let debounceTimer: ReturnType<typeof setTimeout> | undefined
    let pending = new Set<number>()

    function flush() {
      debounceTimer = undefined
      const indices = pending
      pending = new Set()
      bumpWidgets(indices)
    }

    function schedule() {
      if (debounceTimer === undefined) {
        debounceTimer = setTimeout(flush, DEBOUNCE_MS)
      }
    }

    function onEvent(e: WsEvent) {
      let matched = false
      for (const w of watched) {
        if (w.types.includes(e.event)) {
          pending.add(w.i)
          matched = true
        }
      }
      if (matched) schedule()
    }

    // No point opening a socket that would never see a subscribed event
    // type — an all-stat page, or one whose widgets all resolve to [].
    if (unionEventTypes.length > 0) {
      socket = createLiveSocket({
        eventTypes: unionEventTypes,
        onEvent,
        onStatus: () => {},
        // The server dropped frames for us — any of the widgets we're
        // watching could have missed an update, so treat it like a match
        // on all of them rather than silently going stale.
        onGap: () => {
          for (const w of watched) pending.add(w.i)
          schedule()
        },
      })
    }

    const statTimer =
      statIndices.length > 0 ? setInterval(() => bumpWidgets(statIndices), STAT_INTERVAL_MS) : undefined

    return () => {
      socket?.close()
      if (debounceTimer !== undefined) clearTimeout(debounceTimer)
      if (statTimer !== undefined) clearInterval(statTimer)
    }
  })
</script>

{#if !page}
  <NotFound />
{:else}
  <h1>{page.title}</h1>
  <div class="widgets">
    <!-- Keyed on index: the wire contract gives widgets no unique id, and
         title uniqueness within a page isn't enforced by the backend. -->
    {#each page.widgets as widget, i (i)}
      <section class="widget">
        <h2>{widget.title}</h2>
        <div class="widget-body"><WidgetBody {widget} refreshSeq={refreshSeqs[i] ?? 0} /></div>
      </section>
    {/each}
  </div>
{/if}

<style>
  .widgets {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .widget {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    padding: 1rem;
  }
  .widget h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
  }
  .widget-body {
    font-size: 0.875rem;
  }
</style>
