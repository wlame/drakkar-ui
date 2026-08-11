<script lang="ts">
  // Distribution strip under a timeline: avg/p50/p90/p99 of task duration,
  // plus the same statistics over one numeric task label picked in the
  // dropdown (file sizes, line counts — whatever the deployment labels its
  // tasks with). Everything is computed from the tasks the browser currently
  // holds, so the numbers describe exactly the window on screen — the
  // Prometheus histograms are the long-horizon view of the same quantities.
  import { type SharedTimelineControls } from '../../lib/cluster'
  import { dur3 } from '../../lib/format'
  import { type TaskView } from '../../lib/live'
  import { distStats, numericLabelKeys, numericLabelValues, taskDurations } from '../../lib/stats'

  let {
    tasks = [],
    shared = undefined,
    attached = false,
  }: {
    tasks?: TaskView[]
    // Cluster view: the label choice lives on the shared controls, so picking
    // a label in any strip switches every worker's strip to it.
    shared?: SharedTimelineControls
    // True when the strip sits directly under a timeline panel — pulls it up
    // against the panel's bottom margin so the two read as one unit.
    attached?: boolean
  } = $props()

  let localLabel = $state('')
  const chosenLabel = $derived(shared ? shared.statsLabel : localLabel)
  function setLabel(v: string) {
    if (shared) shared.statsLabel = v
    else localLabel = v
  }

  const labelKeys = $derived(numericLabelKeys(tasks))
  // The operator's choice while the data actually carries it; otherwise the
  // first numeric key seen, so the strip is useful with zero configuration.
  const labelKey = $derived(
    chosenLabel && labelKeys.includes(chosenLabel) ? chosenLabel : (labelKeys[0] ?? ''),
  )

  const durationStats = $derived(distStats(taskDurations(tasks)))
  const labelStats = $derived(labelKey ? distStats(numericLabelValues(tasks, labelKey)) : null)

  // Label values have unknown units (bytes, lines, ...) — compact notation
  // (12.5K, 3.4M) reads well for all of them.
  const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
</script>

<div class="stats" class:attached>
  <span class="row">
    <span class="name">duration</span>
    {#if durationStats}
      <span class="pair"><i>n</i>{durationStats.count}</span>
      <span class="pair"><i>avg</i>{dur3(durationStats.avg)}</span>
      <span class="pair"><i>p50</i>{dur3(durationStats.p50)}</span>
      <span class="pair"><i>p90</i>{dur3(durationStats.p90)}</span>
      <span class="pair"><i>p99</i>{dur3(durationStats.p99)}</span>
    {:else}
      <span class="none">no finished tasks in memory</span>
    {/if}
  </span>
  {#if labelKeys.length > 0}
    <span class="row">
      <select
        value={labelKey}
        onchange={(e) => setLabel(e.currentTarget.value)}
        aria-label="Label to aggregate"
      >
        {#each labelKeys as key (key)}
          <option value={key}>{key}</option>
        {/each}
      </select>
      {#if labelStats}
        <span class="pair"><i>n</i>{labelStats.count}</span>
        <span class="pair"><i>avg</i>{compact.format(labelStats.avg)}</span>
        <span class="pair"><i>p50</i>{compact.format(labelStats.p50)}</span>
        <span class="pair"><i>p90</i>{compact.format(labelStats.p90)}</span>
        <span class="pair"><i>p99</i>{compact.format(labelStats.p99)}</span>
      {:else}
        <span class="none">no numeric values</span>
      {/if}
    </span>
  {/if}
</div>

<style>
  .stats {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1.5rem;
    font-family: var(--mono);
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0 0 1rem;
  }
  /* Under a timeline panel: pull up against the panel's own 1.5rem bottom
     margin so the strip reads as part of the panel it describes. */
  .stats.attached {
    margin: -1.125rem 0 1.5rem;
  }
  .row {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
  }
  .name {
    color: #9ca3af;
  }
  .pair i {
    font-style: normal;
    color: #9ca3af;
    margin-right: 0.25rem;
  }
  .none {
    color: #9ca3af;
  }
  select {
    font-size: 0.75rem;
    font-family: var(--mono);
    border: 1px solid var(--line);
    border-radius: 0.25rem;
    padding: 0.0625rem 0.25rem;
    background: #fff;
    color: #6b7280;
  }
</style>
