<script lang="ts">
  // Periodic Tasks tab: run history of @periodic tasks + framework loops, with a
  // recent-runs sparkline (ports debug.html periodic).
  import { onMount } from 'svelte'
  import { api, type PeriodicTask } from '../../lib/api'
  import { fmtAgo, fmtTimeFull, dur3 } from '../../lib/format'

  let tasks = $state<PeriodicTask[] | null>(null)
  let error = $state<string | null>(null)

  async function load() {
    error = null
    try {
      tasks = await api.debugPeriodic()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(load)
</script>

<div class="bar"><button onclick={load}>Refresh</button></div>

{#if error}
  <p class="error">Failed to load periodic tasks: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !tasks}
  <p class="muted">Loading…</p>
{:else if tasks.length === 0}
  <p class="muted">No periodic task runs recorded yet</p>
{:else}
  <table>
    <thead>
      <tr><th>Task</th><th>Last Run</th><th class="num">Duration</th><th>Status</th><th class="num">OK</th><th class="num">Errors</th><th>Recent</th></tr>
    </thead>
    <tbody>
      {#each tasks as t (t.name)}
        <tr>
          <td class="mono">
            {t.name}
            {#if t.system}<span class="pill" title="Framework-internal periodic loop">system</span>{/if}
          </td>
          <td class="muted nowrap" title={fmtTimeFull(t.last_run_ts)}>{fmtAgo(t.last_run_ts)}</td>
          <td class="num mono">{t.last_duration != null ? dur3(t.last_duration) : '-'}</td>
          <td>
            {#if t.last_status === 'ok'}
              <span style:color="#059669">ok</span>
            {:else}
              <span style:color="#dc2626" title={t.last_error}>error</span>
            {/if}
          </td>
          <td class="num mono" style:color="#059669">{t.total_ok}</td>
          <td class="num mono" style:color={t.total_error > 0 ? '#dc2626' : 'var(--muted)'}>{t.total_error}</td>
          <td>
            <div class="spark">
              {#each [...t.recent].reverse() as r}
                <span
                  class="dot"
                  style:background={r.status === 'ok' ? '#059669' : '#dc2626'}
                  title={`${r.status}${r.error ? `: ${r.error}` : ''}${r.duration != null ? ` (${r.duration.toFixed(3)}s)` : ''}`}
                ></span>
              {/each}
            </div>
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .bar {
    margin-bottom: 0.75rem;
  }
  .nowrap {
    white-space: nowrap;
  }
  .pill {
    font-size: 0.65rem;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.05rem 0.4rem;
    margin-left: 0.4rem;
  }
  .spark {
    display: flex;
    gap: 2px;
    align-items: center;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 2px;
    flex: none;
  }
</style>
