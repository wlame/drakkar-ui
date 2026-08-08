<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from './lib/api'
  import { hydrateFromOverview, identity, setIdentity } from './lib/config'
  import { currentPath, link, navigate } from './lib/router'
  import { navItems, resolve, type NavItem } from './lib/routes'
  import { resolveRedirect } from './lib/redirects'
  import { loadUiPages, uiPages } from './lib/pages'
  import WorkerSwitcher from './components/WorkerSwitcher.svelte'
  import SinkLinks from './components/SinkLinks.svelte'
  import VersionBadge from './components/VersionBadge.svelte'

  // $derived recomputes the active page + its route params whenever the path
  // store changes ($currentPath auto-subscribes). The router has no per-route branching;
  // resolve() does the data-driven pattern match.
  const redirectTo = $derived(resolveRedirect($currentPath))
  const match = $derived(resolve($currentPath))
  const Current = $derived(match.component)

  // navItems stays the static built-in list (Dashboard/Live/Debug/History);
  // this appends one nav entry per backend-declared page on top of it. The
  // nav re-derives whenever the uiPages store changes, which happens once
  // when loadUiPages() resolves at boot.
  const allNavItems = $derived<NavItem[]>([
    ...navItems,
    ...$uiPages.map((p) => ({ label: p.title, path: `/p/${p.slug}` })),
  ])

  // The brand shows the cluster name with a capital FIRST letter only. Cluster
  // names are commonly hyphenated ("kafka-prod-01"), and CSS
  // `text-transform: capitalize` would render that as "Kafka-Prod-01". The raw
  // configured value stays in the title attribute.
  const brand = $derived.by(() => {
    const cluster = $identity?.cluster
    if (!cluster) return 'Drakkar'
    return cluster.charAt(0).toUpperCase() + cluster.slice(1)
  })

  // A removed path never renders: the redirect replaces it before a page is shown.
  // The markup below also checks redirectTo directly, so NotFound never flashes
  // for the tick between resolve() picking it and this effect firing.
  $effect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true })
  })

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
    // Hydrate the shared runtime config (Kafka-UI deep links, row/duration
    // tuning) once at boot so it works on every page, not just after visiting
    // Live. Tolerates a backend without the overview endpoint.
    api
      .liveOverview()
      .then(hydrateFromOverview)
      .catch(() => {})

    // The header brand shows the cluster name when the worker has one, so
    // identity is resolved at boot rather than lazily. A backend too old to
    // serve it simply leaves the brand reading "Drakkar".
    api
      .identity()
      .then(setIdentity)
      .catch(() => {})

    // Declared pages (nav entries + widgets) are optional: a backend without
    // any configured degrades to an empty list, and the nav simply shows the
    // built-ins (loadUiPages itself never throws — see lib/pages.ts).
    loadUiPages()

    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  // A nav item is active on its exact path, or on any path nested under it
  // (e.g. "/live/x" would keep "Live" lit). None of the current four nav items
  // has a nested detail route, so that second branch is unreachable today; it stays
  // in place for the day a nav item gains one.
  function isActive(p: string): boolean {
    if (p === '/') return $currentPath === '/'
    return $currentPath === p || $currentPath.startsWith(p + '/')
  }
</script>

<header>
  <div class="bar" class:wide>
    <div class="left">
      <a
        class="brand"
        href="/"
        use:link
        title={$identity?.cluster ? `${$identity.cluster} — Drakkar` : 'Drakkar'}
      >
        {brand}
      </a>
      <nav>
        {#each allNavItems as item}
          <a href={item.path} use:link class:active={isActive(item.path)}>
            {item.label}{#if item.live}<span class="live-dot" aria-hidden="true">•</span>{/if}
          </a>
        {/each}
      </nav>
    </div>
    <span class="spacer"></span>
    <VersionBadge />
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
  {#if !redirectTo}
    <Current params={match.params} />
  {/if}
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
    /* A cluster name can be long; the nav must not be pushed off screen. */
    max-width: 16rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
