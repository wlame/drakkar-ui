<script lang="ts">
  // The open split jobs of the cluster: a summary line, one row per job with
  // its progress and links, and the health marks. Presentational: the
  // Dashboard joins the shared poll loop of lib/split.ts and passes its data.
  import { runtimeConfig } from '../../lib/config'
  import { fmtTime, fmtUptime } from '../../lib/format'
  import { kafkaUiUrl } from '../../lib/kafka'
  import { partitionLabel } from '../../lib/partitions'
  import { link } from '../../lib/router'
  import {
    jobHealth,
    jobLabel,
    mergeSplitJobs,
    ownerState,
    progressPercent,
    restoringTooLong,
    splitSummary,
    splitTraceHref,
    summaryText,
    timeLeftSeconds,
    type SplitHealth,
    type SplitRow,
    type SplitView,
  } from '../../lib/split'

  let {
    view,
    staleSince = null,
    splitOn = false,
  }: { view: SplitView | null; staleSince?: number | null; splitOn?: boolean } = $props()

  const visible = $derived(splitOn || view?.anySplit === true)
  const results = $derived(view?.results ?? [])
  const rows = $derived(mergeSplitJobs(results))
  const summary = $derived(splitSummary(results, view?.unanswered ?? []))
  const slowRestores = $derived(summary.restoring.filter((r) => restoringTooLong(r.seconds)))

  const HEALTH_TEXT: Record<SplitHealth, string> = {
    failed_parts: 'failed parts',
    near_timeout: 'near timeout',
  }

  function timeLeftText(row: SplitRow): string {
    const left = timeLeftSeconds(row)
    if (left === null) return '-'
    return left <= 0 ? 'overdue' : fmtUptime(left)
  }

  function rowContext(row: SplitRow) {
    const owner = ownerState(row, results)
    return {
      base: owner?.state.parts_partition_base ?? null,
      settings: owner?.state.settings ?? null,
      kafkaUrl: kafkaUiUrl($runtimeConfig, row.partition, row.offset, owner?.state.source_topic ?? ''),
    }
  }
</script>

{#if visible}
  <section class="split-jobs">
    <h2>
      Split jobs
      {#if staleSince !== null}<span class="split-stale">stale since {fmtTime(staleSince / 1000)}</span>{/if}
    </h2>
    {#if view === null}
      <p class="muted">Loading…</p>
    {:else}
      <p class="split-summary">{summaryText(summary)}</p>

      {#if slowRestores.length || summary.writeFailures.length}
        <ul class="split-marks">
          {#each slowRestores as r (`${r.worker}/${r.partition}`)}
            <li class="warn">
              {r.worker} partition {r.partition} restoring for {fmtUptime(r.seconds)}
            </li>
          {/each}
          {#each summary.writeFailures as f (f.worker)}
            <li class="warn">{f.worker}: {f.count} result writes failed</li>
          {/each}
        </ul>
      {/if}
      {#if summary.unanswered.length}
        <ul class="split-unanswered">
          {#each summary.unanswered as u (u.worker)}
            <li>{u.worker || 'this worker'}: {u.reason}</li>
          {/each}
        </ul>
      {/if}
      {#if summary.notAvailable.length}
        <p class="split-not-available">
          Not available (no split jobs view on this release): {summary.notAvailable
            .map((w) => w || 'this worker')
            .join(', ')}
        </p>
      {/if}

      {#if !view.answered}
        <p class="muted">No answer yet</p>
      {:else if rows.length === 0}
        <p class="muted">No open split jobs.</p>
      {:else}
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Owner</th>
                <th>Phase</th>
                <th>Progress</th>
                <th class="num">Failed parts</th>
                <th>Age</th>
                <th>Time left</th>
                <th>Request id</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              {#each rows as row (`${row.partition}:${row.offset}`)}
                {@const ctx = rowContext(row)}
                {@const health = jobHealth(row, ctx.settings)}
                {@const percent = progressPercent(row)}
                <tr>
                  <td class="mono">
                    {partitionLabel(row.partition, ctx.base)}:{row.offset}{#if row.attempt > 1}<span class="muted"> (attempt {row.attempt})</span>{/if}
                    {#each health as mark (mark)}<span class="mark">{HEALTH_TEXT[mark]}</span>{/each}
                  </td>
                  <td class="split-owners">{row.owners.join(', ')}</td>
                  <td>{row.phase}</td>
                  <td class="split-progress">
                    {#if percent === null}
                      <span class="bar"><span class="fill splitting"></span></span>
                      <span class="muted">splitting</span>
                    {:else}
                      <span class="bar"><span class="fill" style:width={`${percent}%`}></span></span>
                      <span class="mono">{row.received} / {row.parts} ({percent}%)</span>
                    {/if}
                  </td>
                  <td class="num" class:bad={row.failed > 0}>{row.failed}</td>
                  <td>{fmtUptime(row.age_seconds)}</td>
                  <td>{timeLeftText(row)}</td>
                  <td class="mono">{row.request_id ?? '-'}</td>
                  <td class="links">
                    <a class="split-trace" href={splitTraceHref(row)} use:link title={`Trace ${jobLabel(row)}`}>Trace</a>
                    {#if ctx.kafkaUrl}
                      <a class="split-kafka" href={ctx.kafkaUrl} target="_blank" rel="noopener">Kafka</a>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .split-stale {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--muted);
  }
  .split-summary {
    margin: 0.5rem 0;
  }
  .split-marks,
  .split-unanswered {
    list-style: none;
    margin: 0.25rem 0 0.75rem;
    padding: 0;
    font-size: 0.875rem;
  }
  .split-unanswered,
  .split-not-available {
    color: var(--muted);
  }
  .split-not-available {
    margin: 0.25rem 0 0.75rem;
    font-size: 0.875rem;
  }
  .warn {
    color: #b45309;
  }
  .scroll {
    overflow-x: auto;
  }
  .num {
    text-align: right;
  }
  .bad {
    color: #b91c1c;
  }
  .mark {
    margin-left: 0.4rem;
    font-size: 0.7rem;
    color: #b91c1c;
    border: 1px solid currentColor;
    border-radius: 4px;
    padding: 0 0.25rem;
  }
  .split-progress {
    white-space: nowrap;
  }
  .bar {
    display: inline-block;
    width: 6rem;
    height: 0.5rem;
    margin-right: 0.4rem;
    border-radius: 4px;
    background: var(--line);
    overflow: hidden;
    vertical-align: middle;
  }
  .fill {
    display: block;
    height: 100%;
    background: #2563eb;
  }
  /* No part count yet: a striped bar instead of a fraction. */
  .fill.splitting {
    width: 100%;
    background: repeating-linear-gradient(45deg, #93c5fd 0 6px, transparent 6px 12px);
  }
  .links a + a {
    margin-left: 0.5rem;
  }
</style>
