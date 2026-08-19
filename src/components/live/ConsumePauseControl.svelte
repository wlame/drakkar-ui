<script lang="ts">
  // Timed consume-pause control (contract v1.14). Renders nothing unless the
  // deployment opted in (ui.consume_pause.enabled — carried by the state
  // endpoint, no failure-probe needed). Idle: one row of preset buttons
  // ("Pause 15s / 1m / 5m / 15m", from the configured presets). Active: a
  // loud banner with a live countdown to the server's resume deadline and a
  // Resume button.
  //
  // The countdown ticks client-side from resume_at_ms (the server-
  // authoritative deadline), and the state is re-polled every few seconds
  // while active so an auto-resume, a resume from another tab, or clock
  // drift reconcile within one poll — the banner never lingers after the
  // worker actually resumed.
  import { onMount } from 'svelte'
  import { api } from '../../lib/api'
  import type { ConsumePauseState } from '../../lib/types'

  const ACTIVE_POLL_MS = 5_000

  let snapshot = $state<ConsumePauseState | null>(null)
  let now = $state(Date.now())
  let busy = $state(false)
  let error = $state<string | null>(null)

  async function refresh() {
    try {
      snapshot = await api.consumePauseState()
    } catch {
      snapshot = null // endpoint absent (older backend) — hide the control
    }
  }

  async function pause(seconds: number) {
    busy = true
    error = null
    try {
      snapshot = await api.consumePause(seconds)
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  async function resume() {
    busy = true
    error = null
    try {
      snapshot = await api.consumeResume()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  // "15s" / "1m" / "15m" / "1h" — the button labels for the presets.
  function fmtDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    if (seconds < 3600) return `${Math.round(seconds / 60)}m`
    return `${Math.round(seconds / 3600)}h`
  }

  // "0:42" countdown to the server deadline; clamped at zero (the poll then
  // flips the banner off as soon as the backend confirms the auto-resume).
  const remaining = $derived.by(() => {
    if (!snapshot?.active || snapshot.resume_at_ms == null) return ''
    const totalSeconds = Math.max(0, Math.ceil((snapshot.resume_at_ms - now) / 1000))
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  })

  onMount(() => {
    void refresh()
    const tick = setInterval(() => {
      now = Date.now()
    }, 1_000)
    const poll = setInterval(() => {
      if (snapshot?.active) void refresh()
    }, ACTIVE_POLL_MS)
    return () => {
      clearInterval(tick)
      clearInterval(poll)
    }
  })
</script>

{#if snapshot?.enabled}
  {#if snapshot.active}
    <div class="paused-banner" role="status">
      <span class="dot"></span>
      <strong>Consuming paused</strong>
      <span>resumes in {remaining}{snapshot.requested_seconds ? ` (asked for ${fmtDuration(snapshot.requested_seconds)})` : ''}</span>
      <span class="note">The consumer group is untouched — no rebalance; lag grows while paused.</span>
      <button class="resume" onclick={resume} disabled={busy}>Resume now</button>
    </div>
  {:else}
    <div class="pause-row">
      <span class="label" title="Pause message intake for a bounded period (debug). Uses partition pause — the consumer group is untouched, no rebalance. Auto-resumes at the deadline.">Pause consuming:</span>
      {#each snapshot.durations_seconds as seconds}
        <button onclick={() => pause(seconds)} disabled={busy}>{fmtDuration(seconds)}</button>
      {/each}
    </div>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
{/if}

<style>
  .pause-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0.4rem 0 0.6rem;
  }
  .pause-row .label {
    font-size: 0.78rem;
    color: var(--muted);
  }
  .pause-row button {
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
  }
  .paused-banner {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin: 0.4rem 0 0.6rem;
    padding: 0.5rem 0.8rem;
    border: 1px solid rgba(217, 119, 6, 0.5);
    border-radius: 8px;
    background: rgba(217, 119, 6, 0.08);
    font-size: 0.85rem;
  }
  .paused-banner .dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #d97706;
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }
  .paused-banner .note {
    color: var(--muted);
    font-size: 0.75rem;
  }
  .paused-banner .resume {
    margin-left: auto;
    font-weight: 600;
  }
</style>
