<script lang="ts">
  // Generic results tab for the Live page's on_task_complete / on_message_complete /
  // on_window_complete feeds. Renders the per-kind table and a detail sidebar that
  // lazily fetches the sink breakdown (POST /api/v1/live/sink-breakdown) when a row
  // is opened. Window results have no resolvable offsets, so they show summary only.
  import { api, type TaskResult, type MessageResult, type WindowResult } from '../../lib/api'
  import { link } from '../../lib/router'
  import { fmtTime, fmtTimeMs, durSec, fmtLatency } from '../../lib/format'
  import { baseTaskId } from '../../lib/live'
  import KafkaIcon from '../KafkaIcon.svelte'

  type Kind = 'task' | 'message' | 'window'
  let {
    kind,
    rows = [],
  }: { kind: Kind; rows?: (TaskResult | MessageResult | WindowResult)[] } = $props()

  const taskRows = $derived(kind === 'task' ? (rows as TaskResult[]) : [])
  const messageRows = $derived(kind === 'message' ? (rows as MessageResult[]) : [])
  const windowRows = $derived(kind === 'window' ? (rows as WindowResult[]) : [])

  // Sidebar state.
  let openKey = $state<string | null>(null)
  let breakdown = $state<Record<string, number> | null>(null)
  let breakdownState = $state<'idle' | 'loading' | 'error' | 'none'>('idle')

  async function openSink(key: string, partition: number | null, offsets: number[]) {
    openKey = key
    breakdown = null
    if (partition == null || offsets.length === 0) {
      breakdownState = 'none'
      return
    }
    breakdownState = 'loading'
    try {
      const b = await api.sinkBreakdown(partition, offsets)
      breakdown = b
      breakdownState = Object.keys(b).length ? 'idle' : 'none'
    } catch {
      breakdownState = 'error'
    }
  }

  function close() {
    openKey = null
  }
</script>

{#if rows.length === 0}
  <p class="muted">No {kind === 'task' ? 'on_task_complete()' : kind === 'message' ? 'on_message_complete()' : 'on_window_complete()'} calls yet.</p>
{:else}
  <table>
    <thead>
      {#if kind === 'task'}
        <tr><th>Time</th><th>Task ID</th><th>Source</th><th class="num">Exec</th><th class="num">Hook</th><th class="num">Outputs</th><th>Status</th></tr>
      {:else if kind === 'message'}
        <tr><th>Time</th><th>Source</th><th class="num">Hook</th><th class="num">End-to-end</th><th>Tasks</th><th class="num">Outputs</th></tr>
      {:else}
        <tr><th>Time</th><th class="num">Partition</th><th class="num">Window #</th><th class="num">Duration</th><th class="num">Tasks</th><th class="num">Outputs</th></tr>
      {/if}
    </thead>
    <tbody>
      {#if kind === 'task'}
        {#each taskRows as r, i (`${r.ts}:${r.task_id}:${i}`)}
          <tr class="clickable" class:sel={openKey === `${r.ts}:${r.task_id}`} onclick={() => openSink(`${r.ts}:${r.task_id}`, r.partition, r.source_offsets ?? [])}>
            <td class="muted nowrap" title={fmtTimeMs(r.ts)}>{fmtTime(r.ts)}</td>
            <td class="mono">
              {#if r.task_id}<a href={`/task/${encodeURIComponent(baseTaskId(r.task_id))}`} use:link onclick={(e) => e.stopPropagation()} style:color="#c084fc">{r.task_id}</a>{/if}
            </td>
            <td class="mono">
              {#if r.partition != null}P{r.partition}{#if r.source_offsets?.length}:{r.source_offsets[0]}{#if r.source_offsets.length > 1}+{r.source_offsets.length - 1}{/if}<KafkaIcon partition={r.partition} offset={r.source_offsets[0]} />{/if}{/if}
            </td>
            <td class="num mono">{durSec(r.exec_duration)}</td>
            <td class="num mono">{durSec(r.hook_duration)}</td>
            <td class="num mono">{r.output_message_count}</td>
            <td><span style:color={r.status === 'failed' ? '#f87171' : r.status === 'completed' ? '#34d399' : '#8b93ad'}>{r.status ?? '?'}{#if r.status === 'failed' && r.exit_code != null} ({r.exit_code}){/if}</span></td>
          </tr>
        {/each}
      {:else if kind === 'message'}
        {#each messageRows as r, i (`${r.ts}:${r.partition}:${r.offset}:${i}`)}
          <tr class="clickable" class:sel={openKey === `${r.ts}:${r.offset}`} onclick={() => openSink(`${r.ts}:${r.offset}`, r.partition, r.offset != null ? [r.offset] : [])}>
            <td class="muted nowrap" title={fmtTimeMs(r.ts)}>{fmtTime(r.ts)}</td>
            <td class="mono">
              {#if r.partition != null && r.offset != null}P{r.partition}:{r.offset}<KafkaIcon partition={r.partition} offset={r.offset} />{/if}
            </td>
            <td class="num mono">{durSec(r.duration)}</td>
            <td class="num mono">{fmtLatency(r.end_to_end_duration)}</td>
            <td class="mono"><span style:color="#34d399">{r.succeeded}</span>/<span style:color="#f87171">{r.failed}</span>/<span style:color="#fbbf24">{r.replaced}</span></td>
            <td class="num mono">{r.output_message_count}</td>
          </tr>
        {/each}
      {:else}
        {#each windowRows as r, i (`${r.ts}:${r.partition}:${r.window_id}:${i}`)}
          <tr>
            <td class="muted nowrap" title={fmtTimeMs(r.ts)}>{fmtTime(r.ts)}</td>
            <td class="num mono">{r.partition ?? '-'}</td>
            <td class="num mono">{r.window_id ?? '-'}</td>
            <td class="num mono">{durSec(r.duration)}</td>
            <td class="num mono">{r.task_count}</td>
            <td class="num mono">{r.output_message_count}</td>
          </tr>
        {/each}
      {/if}
    </tbody>
  </table>
{/if}

{#if openKey}
  <div class="sidebar">
    <div class="sb-head">
      <span>Sink outputs</span>
      <button class="x" onclick={close} aria-label="Close">×</button>
    </div>
    {#if breakdownState === 'loading'}
      <p class="muted">loading…</p>
    {:else if breakdownState === 'error'}
      <p class="error">failed to load sink breakdown</p>
    {:else if breakdownState === 'none' || !breakdown}
      <p class="muted">(no sink outputs)</p>
    {:else}
      <table>
        <tbody>
          {#each Object.entries(breakdown) as [name, count]}
            <tr><td class="mono" style:color="#2dd4bf">{name}</td><td class="num mono">{count}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </div>
{/if}

<style>
  .nowrap {
    white-space: nowrap;
  }
  tr.clickable {
    cursor: pointer;
  }
  tr.clickable:hover td,
  tr.sel td {
    background: var(--panel-2);
  }
  .sidebar {
    position: fixed;
    top: 3.25rem;
    right: 0;
    width: 22rem;
    max-width: 90vw;
    height: calc(100vh - 3.25rem);
    background: var(--panel-2);
    border-left: 1px solid var(--line);
    box-shadow: -12px 0 32px rgba(0, 0, 0, 0.4);
    padding: 1rem;
    overflow: auto;
    z-index: 40;
  }
  .sb-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    font-weight: 600;
  }
  .sb-head .x {
    padding: 0.1rem 0.5rem;
  }
</style>
