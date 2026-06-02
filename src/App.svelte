<script lang="ts">
  import { onMount } from 'svelte'
  import { currentPath, link } from './lib/router'
  import { navItems, resolve } from './lib/routes'
  import WorkerSwitcher from './components/WorkerSwitcher.svelte'
  import SinkLinks from './components/SinkLinks.svelte'

  // $derived recomputes the active page + its route params whenever the path
  // store changes ($currentPath auto-subscribes). The router has no per-route branching;
  // resolve() does the data-driven pattern match.
  const match = $derived(resolve($currentPath))
  const Current = $derived(match.component)

  // Wide-layout toggle, persisted like the reference's localStorage 'drakkar-wide'.
  let wide = $state(localStorage.getItem('drakkar-wide') === '1')
  $effect(() => {
    localStorage.setItem('drakkar-wide', wide ? '1' : '0')
  })

  // Plain "f" / "F" toggles wide layout (ignored in inputs and with modifiers, so
  // it never shadows Cmd/Ctrl+F find-in-page).
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'f' && e.key !== 'F') return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target as HTMLElement
    const tag = (t.tagName || '').toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return
    e.preventDefault()
    wide = !wide
  }

  onMount(() => {
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // A nav item is active on its exact page and (for top-level pages) on any detail
  // route beneath it, so "Partitions" stays lit on /partitions/3.
  function isActive(p: string): boolean {
    if (p === '/') return $currentPath === '/'
    return $currentPath === p || $currentPath.startsWith(p + '/')
  }
</script>

<header>
  <a class="brand" href="/" use:link>
    <span class="mark">◆</span> drakkar
  </a>
  <nav>
    {#each navItems as item}
      <a href={item.path} use:link class:active={isActive(item.path)}>
        {item.label}{#if item.live}<span class="live-dot" aria-hidden="true">●</span>{/if}
      </a>
    {/each}
  </nav>
  <span class="spacer"></span>
  <SinkLinks />
  <WorkerSwitcher />
  <button class="width-toggle" onclick={() => (wide = !wide)} title="Toggle full width (f)" aria-label="Toggle full width">
    {#if wide}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M14 4h6v6M10 14l-7 7M21 3l-7 7" /></svg>
    {:else}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
    {/if}
  </button>
</header>

<main class:wide>
  <Current params={match.params} />
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 1.25rem;
    padding: 0 1.25rem;
    height: 3.25rem;
    border-bottom: 1px solid var(--line);
    background: var(--panel);
  }
  .brand {
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text);
    text-decoration: none;
  }
  .mark {
    color: var(--accent);
  }
  nav {
    display: flex;
    gap: 0.15rem;
  }
  nav a {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    padding: 0.4rem 0.7rem;
    border-radius: 6px;
    color: var(--muted);
    text-decoration: none;
    font-size: 0.9rem;
  }
  nav a:hover,
  nav a.active {
    color: var(--text);
    background: var(--panel-2);
  }
  .live-dot {
    color: var(--error);
    font-size: 0.7rem;
    line-height: 1;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }
  .spacer {
    flex: 1;
  }
  .width-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line);
  }
  .width-toggle:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  main {
    padding: 1.5rem 1.25rem;
    max-width: 70rem;
    margin: 0 auto;
  }
  main.wide {
    max-width: none;
  }
</style>
