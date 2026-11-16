<script lang="ts">
  // Page-wide detach banner (contract v1.33), rendered by the app shell so it
  // shows on every page. Detached: who did it, the reason, and the deadline
  // in UTC with the time left as a countdown. Detaching or attaching: one quieter
  // line, so a short transition does not flash a full banner. Attached, the
  // feature off, or an older worker (404): nothing. While the worker does not
  // answer, the last state stays and a line says since when it is unknown.
  import { onMount } from 'svelte'
  import {
    bannerVisible,
    detachStaleSince,
    detachState,
    detachStateLine,
    fmtTimeLeft,
    fmtUtcTimeMs,
    useDetachState,
  } from '../lib/detach'

  let now = $state(Date.now())
  const snapshot = $derived($detachState)
  const staleSince = $derived($detachStaleSince)

  onMount(() => {
    const leave = useDetachState()
    const tick = setInterval(() => {
      now = Date.now()
    }, 1_000)
    return () => {
      clearInterval(tick)
      leave()
    }
  })
</script>

{#if snapshot && bannerVisible(snapshot)}
  {#if snapshot.state === 'detached'}
    <div class="detach-banner" role="status">
      <span class="dot" aria-hidden="true"></span>
      <strong>Detached from the consumer group</strong>
      {#if snapshot.origin}<span>by {snapshot.origin}</span>{/if}
      {#if snapshot.reason}<span class="reason">&ldquo;{snapshot.reason}&rdquo;</span>{/if}
      {#if staleSince != null}
        <span class="detach-stale"
          >state unknown since {fmtUtcTimeMs(staleSince)}: the worker does not answer</span
        >
      {/if}
      {#if snapshot.until_ms != null}
        {#if snapshot.until_ms > now}
          <span class="deadline"
            >attaches at {fmtUtcTimeMs(snapshot.until_ms)} (in {fmtTimeLeft(
              snapshot.until_ms - now,
            )})</span
          >
        {:else}
          <span class="deadline"
            >deadline {fmtUtcTimeMs(snapshot.until_ms)}: the deadline has passed</span
          >
        {/if}
      {/if}
    </div>
  {:else}
    <p class="detach-transition" role="status">
      {detachStateLine(snapshot.state)}
      {#if staleSince != null}
        <span class="detach-stale"
          >state unknown since {fmtUtcTimeMs(staleSince)}: the worker does not answer</span
        >
      {/if}
    </p>
  {/if}
{/if}

<style>
  .detach-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin: 0 0 1rem;
    padding: 0.5rem 0.8rem;
    border: 1px solid rgba(217, 119, 6, 0.5);
    border-radius: 8px;
    background: rgba(217, 119, 6, 0.08);
    color: var(--text);
    font-size: 0.85rem;
  }
  .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--warn);
  }
  .reason {
    font-style: italic;
  }
  .deadline {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 0.8rem;
    color: var(--muted);
  }
  .detach-stale {
    font-weight: 600;
    color: var(--error);
  }
  .detach-transition {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
</style>
