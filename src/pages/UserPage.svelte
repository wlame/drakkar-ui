<script lang="ts">
  // Shell for a backend-declared page (GET /api/v1/pages, routed at
  // /p/:slug). Resolves the page by slug against the store loaded at boot
  // (App.svelte) and renders its title plus one card per widget, each body
  // rendered by WidgetBody (live WS-driven refresh is Task 6's job).
  import { pageBySlug, uiPages } from '../lib/pages'
  import WidgetBody from '../components/pages/WidgetBody.svelte'
  import NotFound from './NotFound.svelte'

  let { params = {} }: { params?: Record<string, string> } = $props()

  const slug = $derived(params.slug ?? '')
  const page = $derived(pageBySlug($uiPages, slug))
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
        <div class="widget-body"><WidgetBody {widget} /></div>
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
