<script lang="ts">
  // Detach control (contract v1.33) on the Live page. Renders nothing unless
  // the worker has the feature on (sources.kafka.detach.enabled) and the
  // deployment opted in to the buttons (ui.detach_enabled); an older worker
  // answers 404 and the control stays hidden, with no error.
  //
  // Attached: one small "Detach…" button that opens a popover with the
  // durations, a reason field and the Detach button. Detaching or attaching:
  // a disabled button that says so. Detached: an "Attach now" button (the
  // page-wide banner shows the deadline). The last request that was refused
  // shows as one plain sentence.
  //
  // The state comes from the shared store of lib/detach.ts, which the app
  // shell also reads for the banner, so there is one poll loop for both.
  import { onMount } from 'svelte'
  import {
    DETACH_REASON_MAX_CHARS,
    controlVisible,
    detachChoices,
    detachState,
    fmtDetachDuration,
    fmtUtcTimeMs,
    isRefusal,
    outcomeText,
    requestAttach,
    requestDetach,
    requestErrorText,
    useDetachState,
  } from '../../lib/detach'

  let busy = $state(false)
  let error = $state<string | null>(null)
  let formOpen = $state(false)
  let chosen = $state<number | null>(null)
  let reason = $state('')
  let popEl = $state<HTMLDivElement>()

  const snapshot = $derived($detachState)
  const choices = $derived(snapshot ? detachChoices(snapshot.max_duration_seconds) : [])
  // The configured default when it is one of the choices, else the first.
  const duration = $derived(
    chosen != null && choices.includes(chosen)
      ? chosen
      : snapshot && choices.includes(snapshot.default_duration_seconds)
        ? snapshot.default_duration_seconds
        : (choices[0] ?? null),
  )
  const refused = $derived(
    snapshot?.last_request && isRefusal(snapshot.last_request.outcome) ? snapshot.last_request : null,
  )

  // Runs one request; true when the worker accepted it.
  async function run(action: () => Promise<void>): Promise<boolean> {
    busy = true
    error = null
    try {
      await action()
      return true
    } catch (e) {
      error = requestErrorText(e)
      return false
    } finally {
      busy = false
    }
  }

  // On success the form closes and forgets its reason, so the next detach
  // starts clean. On a failure the form stays as it was, next to the error.
  async function detach() {
    if (duration == null) return
    if (await run(() => requestDetach(duration, reason.trim()))) {
      formOpen = false
      reason = ''
      chosen = null
    }
  }

  function attach() {
    void run(requestAttach)
  }

  // Close the form on a press anywhere outside the control, and on Escape.
  $effect(() => {
    if (!formOpen) return
    function onPointerDown(e: PointerEvent) {
      if (popEl && !popEl.contains(e.target as Node)) formOpen = false
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') formOpen = false
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  })

  onMount(() => useDetachState())
</script>

{#if snapshot && controlVisible(snapshot)}
  <div class="detach-ctl" bind:this={popEl}>
    {#if snapshot.state === 'attached'}
      <button
        class="detach-toggle"
        class:on={formOpen}
        onclick={() => (formOpen = !formOpen)}
        aria-expanded={formOpen}
        disabled={busy}
        title="Leave the Kafka consumer group for a bounded time. The worker joins it again at the deadline."
      >Detach&hellip; &#9662;</button>
      {#if formOpen}
        <div class="detach-pop" role="group" aria-label="Detach from the consumer group">
          <div class="detach-presets" role="radiogroup" aria-label="Detach for">
            <span class="label">Detach for</span>
            {#each choices as seconds}
              <button
                role="radio"
                aria-checked={duration === seconds}
                class:selected={duration === seconds}
                onclick={() => (chosen = seconds)}
              >{fmtDetachDuration(seconds)}</button>
            {/each}
          </div>
          <label class="reason-row">
            <span class="label">Reason</span>
            <input
              class="detach-reason"
              type="text"
              maxlength={DETACH_REASON_MAX_CHARS}
              placeholder="optional, shown to other operators"
              bind:value={reason}
            />
          </label>
          <p class="note">
            This worker leaves its consumer group. Kafka gives its partitions to the other workers.
          </p>
          <button class="detach-go" onclick={detach} disabled={busy || duration == null}
            >Detach from the group</button
          >
        </div>
      {/if}
    {:else if snapshot.state === 'detached'}
      <button class="attach-go" onclick={attach} disabled={busy}>Attach now</button>
    {:else}
      <button class="detach-toggle" disabled
        >{snapshot.state === 'detaching' ? 'Detaching…' : 'Attaching…'}</button
      >
    {/if}
  </div>
  {#if refused}
    <p class="detach-outcome" role="status">
      Last {refused.action} by {refused.origin} at {fmtUtcTimeMs(refused.at_ms)} did not
      succeed: {outcomeText(refused.outcome)}
    </p>
  {/if}
  {#if error}<p class="error">{error}</p>{/if}
{/if}

<style>
  /* Idle: a header-row pill like the pause control next to it, with the
     form in an anchored popover. */
  .detach-ctl {
    position: relative;
  }
  .detach-toggle,
  .attach-go {
    font-size: 0.75rem;
    border-radius: 0.25rem;
    padding: 0.125rem 0.5rem;
    background: #f5f3ee;
    color: #6b7280;
    border: 1px solid #ddd9ce;
  }
  .detach-toggle.on {
    background: #fef3c7;
    color: #92400e;
    border-color: #fcd34d;
  }
  .attach-go {
    font-weight: 600;
    color: var(--text);
  }
  .detach-pop {
    position: absolute;
    top: calc(100% + 0.25rem);
    left: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    width: 22rem;
    padding: 0.55rem 0.7rem;
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 0.375rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
  }
  .detach-presets,
  .reason-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .label {
    font-size: 0.78rem;
    color: var(--muted);
    min-width: 4.5rem;
  }
  .detach-presets button {
    font-size: 0.75rem;
    padding: 0.15rem 0.55rem;
  }
  .detach-presets button.selected {
    background: #fef3c7;
    color: #92400e;
    border-color: #fcd34d;
  }
  .detach-reason {
    flex: 1;
    font-size: 0.8rem;
    padding: 0.15rem 0.35rem;
  }
  .note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .detach-go {
    align-self: flex-start;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.2rem 0.7rem;
    color: #92400e;
    background: #fef3c7;
    border: 1px solid #d97706;
  }
  /* The outcome and errors each own a full line of the header row the
     control sits in. */
  .detach-outcome,
  .error {
    flex-basis: 100%;
    margin: 0;
    font-size: 0.8rem;
  }
  .detach-outcome {
    color: var(--warn);
  }
</style>
