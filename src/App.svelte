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
  <div class="bar" class:wide>
    <div class="left">
      <a class="brand" href="/" use:link>Drakkar</a>
      <nav>
        {#each navItems as item}
          <a href={item.path} use:link class:active={isActive(item.path)}>
            {item.label}{#if item.live}<span class="live-dot" aria-hidden="true">•</span>{/if}
          </a>
        {/each}
      </nav>
    </div>
    <span class="spacer"></span>
    <SinkLinks />
    <div class="tools">
      <button class="width-toggle" onclick={() => (wide = !wide)} title="Toggle full width (f)" aria-label="Toggle full width">
        {#if wide}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 14h6v6M14 4h6v6M10 14l-7 7M21 3l-7 7" /></svg>
        {:else}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
        {/if}
      </button>
      <WorkerSwitcher />
    </div>
  </div>
</header>

<main class:wide>
  <Current params={match.params} />
</main>

<style>
  header {
    background: #2a2a2a;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    max-width: 80rem;
    margin: 0 auto;
    padding: 0.75rem 1rem;
  }
  .bar.wide {
    max-width: none;
  }
  .left {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  .brand {
    font-size: 1.125rem;
    font-weight: 700;
    color: #fff;
    text-decoration: none;
  }
  nav {
    display: flex;
    gap: 1.5rem;
  }
  nav a {
    display: inline-flex;
    align-items: center;
    gap: 0.15rem;
    color: #9ca3af;
    text-decoration: none;
    font-size: 0.875rem;
    transition: color 0.12s;
  }
  nav a:hover,
  nav a.active {
    color: #fff;
  }
  .live-dot {
    color: #ef4444;
    font-size: 32px;
    line-height: 0;
    vertical-align: middle;
    position: relative;
    top: -2px;
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
  .tools {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .width-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    color: #6b7280;
    background: transparent;
    border: none;
  }
  .width-toggle:hover {
    color: #fff;
  }
  main {
    padding: 1.5rem 1rem;
    max-width: 80rem;
    margin: 0 auto;
  }
  main.wide {
    max-width: none;
  }
</style>
