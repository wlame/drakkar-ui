<script lang="ts">
  // Worker-at-a-glance. This page owns every request it needs and drives them
  // from one tick, so its own three endpoints never land in the same tick —
  // each request costs the worker a main-loop dispatch, and a repeating burst
  // of three is a cost the worker feels forever once the intervals align. The
  // guarantee covers this page only; the header polls workers on its own timer.
  import { onMount } from 'svelte'
  import { api, type Dashboard, type Partition, type SinkStatus } from '../lib/api'
  import { identity } from '../lib/config'
  import { fmtTime, fmtUptime } from '../lib/format'
  import { COLOR } from '../lib/events'
  import { normalizeRecentTasks, taskFromRecent, type TaskView } from '../lib/live'
  import { DEFAULT_MAX_AGE_MINUTES } from '../lib/timeline'
  import { pausableInterval } from '../lib/visibility'
  import { dueJobs, type PollJob } from '../lib/schedule'
  import WebappTile from '../components/WebappTile.svelte'
  import TimelineStats from '../components/live/TimelineStats.svelte'
  import PartitionsTable from '../components/dashboard/PartitionsTable.svelte'
  import SinksTable from '../components/dashboard/SinksTable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  const POLL_TICK_MS = 500

  // How many missed polls before a section is marked stale. One failed poll
  // during a rolling restart is normal and must stay silent.
  const STALE_AFTER_PERIODS = 3

  let data = $state<Dashboard | null>(null)
  let partitions = $state<Partition[] | null>(null)
  let sinks = $state<SinkStatus[] | null>(null)
  let recentTasks = $state<TaskView[] | null>(null)

  const maxAgeMinutes = $derived($identity?.timeline?.max_age_minutes ?? DEFAULT_MAX_AGE_MINUTES)

  async function loadDashboard() {
    data = await api.dashboard()
  }

  async function loadPartitions() {
    partitions = await api.partitions()
  }

  async function loadSinks() {
    sinks = await api.sinks()
  }

  async function loadRecentTasks() {
    // Same vetting as the Live page: a degraded payload keeps the last good
    // sample on screen (the throw routes into runJob's stale handling).
    const rt = normalizeRecentTasks(await api.recentTasks(maxAgeMinutes))
    if (rt.unavailable) throw new Error('recent-tasks unavailable')
    recentTasks = rt.tasks.map(taskFromRecent)
  }

  const LOADERS = {
    dashboard: loadDashboard,
    partitions: loadPartitions,
    sinks: loadSinks,
    tasks: loadRecentTasks,
  } satisfies Record<string, () => Promise<void>>

  // Keying the jobs off LOADERS makes a job name with no loader a compile error
  // rather than a TypeError on the tick that first fires it.
  type JobName = keyof typeof LOADERS

  // Offsets keep any two jobs off the same tick: sinks always lands on an even
  // tick, dashboard on ticks ≡ 1 (mod 10), partitions on ≡ 3 (mod 10). Each
  // offset is also a full period past tick 0, so the first scheduled run does
  // not re-fetch what the manual fill in onMount just fetched. A job added
  // later must keep both properties — for example everyTicks 10, offsetTicks 15.
  const JOBS: PollJob<JobName>[] = [
    { name: 'sinks', everyTicks: 4, offsetTicks: 4 },
    { name: 'dashboard', everyTicks: 10, offsetTicks: 11 },
    { name: 'partitions', everyTicks: 10, offsetTicks: 13 },
    // recent-tasks is the heaviest query this page makes — half the cadence
    // of the others. Ticks ≡ 7 (mod 20): odd, so never on a sinks tick, and
    // ≠ 1/3 (mod 10), so never on a dashboard or partitions tick.
    { name: 'tasks', everyTicks: 20, offsetTicks: 27 },
  ]

  const PERIOD_SEC: Record<JobName, number> = Object.fromEntries(
    JOBS.map((j) => [j.name, (j.everyTicks * POLL_TICK_MS) / 1000]),
  ) as Record<JobName, number>

  const emptyPerJob = <T,>(value: T): Record<JobName, T> => ({
    dashboard: value,
    partitions: value,
    sinks: value,
    tasks: value,
  })

  let errors = $state<Record<JobName, string | null>>(emptyPerJob<string | null>(null))
  // Epoch seconds of the last good load, and — once the section has gone quiet
  // for long enough — the timestamp shown in the stale marker.
  let lastOkAt = $state<Record<JobName, number | null>>(emptyPerJob<number | null>(null))
  let staleSince = $state<Record<JobName, number | null>>(emptyPerJob<number | null>(null))

  // Names whose request is still open. Without this a slow endpoint piles up
  // requests, and an older response landing last rewrites a table with rows
  // that are already out of date.
  const inFlight = new Set<JobName>()

  // A section goes stale once its last good value is older than a few polls.
  function markStaleIfOld(name: JobName) {
    const okAt = lastOkAt[name]
    if (okAt === null) return
    if (Date.now() / 1000 - okAt > PERIOD_SEC[name] * STALE_AFTER_PERIODS) staleSince[name] = okAt
  }

  async function runJob(name: JobName) {
    if (inFlight.has(name)) {
      // Requests carry no timeout, so one that never settles would otherwise
      // keep the numbers looking live: nothing fails, so nothing marks them.
      markStaleIfOld(name)
      return
    }
    inFlight.add(name)
    try {
      await LOADERS[name]()
      lastOkAt[name] = Date.now() / 1000
      staleSince[name] = null
      errors[name] = null
    } catch (e) {
      // Keep the last good value: one dead endpoint costs its own section, not
      // the whole page. Before the first success there is nothing to show but
      // the error; after it, the numbers stay and only pick up a stale marker
      // once they are older than a few polls.
      if (lastOkAt[name] === null) {
        errors[name] = e instanceof Error ? e.message : String(e)
      } else {
        markStaleIfOld(name)
      }
    } finally {
      inFlight.delete(name)
    }
  }

  function reloadAll() {
    for (const name of Object.keys(LOADERS) as JobName[]) void runJob(name)
  }

  // Consumer-lag thresholds for the whole-worker tile: > 100 red, > 20 amber.
  function lagColor(lag: number): string {
    if (lag > 100) return COLOR.red
    if (lag > 20) return COLOR.amber
    return COLOR.emerald
  }

  onMount(() => {
    // Fill the page at once, then let the scheduler take over the cadence.
    reloadAll()
    let tick = 0
    return pausableInterval(
      () => {
        tick += 1
        for (const name of dueJobs(JOBS, tick)) void runJob(name)
      },
      POLL_TICK_MS,
      // Advancing one tick after a long absence usually fires nothing, so the
      // catch-up has to refetch everything itself.
      { onResume: reloadAll },
    )
  })
</script>

<!-- Marks a section whose numbers are still on screen but no longer refreshing.
     Deliberately quiet: a single failed poll is normal, so this reads as a note
     next to the heading, not as an alarm. -->
{#snippet staleMark(since: number | null)}
  {#if since !== null}<span class="stale">stale since {fmtTime(since)}</span>{/if}
{/snippet}

<h1>Dashboard {@render staleMark(staleSince.dashboard)}</h1>

<!-- Tiny external-link arrow shown next to a stat-tile label when the backend
     provides a Prometheus URL for it. -->
{#snippet promIcon(url: string, title: string)}
  <a class="promicon" href={url} target="_blank" rel="noopener" {title}>
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
  </a>
{/snippet}

{#if errors.dashboard}
  <p class="error">Could not load the worker summary: <code>{errors.dashboard}</code></p>
  <button onclick={() => void runJob('dashboard')}>Retry</button>
{:else if !data}
  <p class="muted">Loading…</p>
{:else}
  <!-- Primary stats -->
  <div class="tiles">
    <div class="tile"><span class="k">Uptime</span><span class="v">{fmtUptime(data.uptime)}</span></div>
    <div class="tile"><span class="k">Partitions</span><span class="v">{data.partition_count}</span></div>
    <div class="tile"><span class="k">Executor Pool</span><span class="v">{data.pool_active} / {data.pool_max}</span></div>
    <div class="tile"><span class="k">Total Events</span><span class="v">{data.stats.total_events ?? 0}</span></div>
    <div class="tile"><span class="k">Consumer Lag{#if data.links?.card_links.lag}{@render promIcon(data.links.card_links.lag, 'View in Prometheus')}{/if}</span><span class="v" style:color={lagColor(data.total_lag)}>{data.total_lag}</span></div>
  </div>

  <!-- Secondary stats -->
  <div class="tiles secondary">
    <div class="tile"><span class="k">Consumed{#if data.links?.card_links.consumed}{@render promIcon(data.links.card_links.consumed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.blue}>{data.stats.consumed ?? 0}</span></div>
    <div class="tile"><span class="k">Completed{#if data.links?.card_links.completed}{@render promIcon(data.links.card_links.completed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.emerald}>{data.stats.completed ?? 0}</span></div>
    <div class="tile"><span class="k">Failed{#if data.links?.card_links.failed}{@render promIcon(data.links.card_links.failed, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.red}>{data.stats.failed ?? 0}</span></div>
    <div class="tile"><span class="k">Produced{#if data.links?.card_links.produced}{@render promIcon(data.links.card_links.produced, 'View rate in Prometheus')}{/if}</span><span class="v" style:color={COLOR.purple}>{data.stats.produced ?? 0}</span></div>
  </div>

  <!-- WebApp sits above the partition tiles: it is a second ingress into the
       same pipeline, not one of the partitions. -->
  {#if data.webapp_tile}
    <div class="tile-wrap"><WebappTile tile={data.webapp_tile} /></div>
  {/if}

  <!-- Duration + numeric-label distributions over the recent-tasks window —
       the same strip the Live timeline shows, fed by this page's own poll. -->
  {#if recentTasks !== null}
    <h2>
      Task Stats <span class="note">(last {maxAgeMinutes} min)</span>
      {@render staleMark(staleSince.tasks)}
    </h2>
    <TimelineStats tasks={recentTasks} />
  {/if}

  <h2>Assigned Partitions</h2>
  <div class="partitions">
    {#if data.partitions.length === 0}
      <p class="muted">No partitions assigned</p>
    {:else}
      {#each data.partitions as pid}
        <span class="ptile">P{pid}</span>
      {/each}
    {/if}
  </div>

  <!-- Prometheus link sections. The cluster-wide card only renders when the
       per-worker grid does; custom links render independently. -->
  {#if data.links}
    {#if data.links.worker_links.length > 0}
      <h2>Prometheus Metrics</h2>
      <div class="promgrid">
        {#each data.links.worker_links as group}
          <div class="promcard">
            <div class="cat">{group.category}</div>
            <ul>
              {#each group.links as [name, url]}
                <li><a class="promlink" href={url} target="_blank" rel="noopener">{name}</a></li>
              {/each}
            </ul>
          </div>
        {/each}
      </div>

      {#if data.links.cluster_links.length > 0}
        <h2>Cluster-wide Metrics</h2>
        <div class="linkcard">
          <ul>
            {#each data.links.cluster_links as [name, url]}
              <li><a class="promlink" href={url} target="_blank" rel="noopener">{name}</a></li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}

    {#if data.links.custom_links.length > 0}
      <h2>Links</h2>
      <div class="linkcard">
        <ul>
          {#each data.links.custom_links as link}
            <li><a class="promlink" href={link.url} target="_blank" rel="noopener">{link.name}</a></li>
          {/each}
        </ul>
      </div>
    {/if}
  {/if}
{/if}

<!-- The two tables sit outside the `data` guard: a failing /dashboard request
     must not hide partition and sink health, which come from other endpoints.
     "All Partitions" because this lists every partition the recorder has seen,
     while the stat tile above counts only the ones assigned to this worker. -->
<h2>All Partitions {@render staleMark(staleSince.partitions)}</h2>
<PartitionsTable rows={partitions} error={errors.partitions} />

<h2>Sinks {@render staleMark(staleSince.sinks)}</h2>
<SinksTable rows={sinks} error={errors.sinks} />

<style>
  /* Stale marker: small, muted, normal weight so it never competes with the
     heading it hangs off. */
  .stale {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--muted);
  }
  /* Window note on the Task Stats heading, same idiom as the timeline's. */
  .note {
    font-size: 0.875rem;
    font-weight: 400;
    color: var(--muted);
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .tiles.secondary {
    margin-bottom: 1.5rem;
  }
  .tile {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
  }
  .tile .k {
    font-size: 0.8rem;
    color: var(--muted);
  }
  /* Reference stat values are text-2xl font-mono (normal weight); the
     secondary row steps down to text-xl. */
  .tile .v {
    font-size: 1.5rem;
    font-weight: 400;
    font-family: var(--mono);
  }
  .secondary .tile .v {
    font-size: 1.25rem;
  }
  .partitions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .tile-wrap {
    margin: 1.25rem 0;
  }
  .ptile {
    display: inline-block;
    min-width: 3.5rem;
    text-align: center;
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--panel);
    color: var(--text);
    font-family: var(--mono);
    font-weight: 600;
  }

  /* Stat-tile Prometheus deep link — reference: `inline -mt-0.5 ml-1 opacity-40
     hover:opacity-100`, inheriting the gray label color via currentColor. */
  .promicon {
    display: inline-block;
    margin-left: 0.25rem;
    vertical-align: -2px;
    color: inherit;
    opacity: 0.4;
  }
  .promicon:hover {
    opacity: 1;
  }

  /* Prometheus link grid — reference: `grid-cols-1 md:grid-cols-2 lg:grid-cols-4
     gap-4 mb-6`, white cards with the cream border. */
  .promgrid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  @media (min-width: 768px) {
    .promgrid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  @media (min-width: 1024px) {
    .promgrid {
      grid-template-columns: repeat(4, 1fr);
    }
  }
  .promcard,
  .linkcard {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 1rem;
  }
  .linkcard {
    margin-bottom: 1.5rem;
  }
  /* Category header — reference: text-sm font-semibold text-gray-500 mb-2. */
  .promcard .cat {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--muted);
    margin-bottom: 0.5rem;
  }
  .promcard ul,
  .linkcard ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  /* space-y-1 between stacked links. */
  .promcard li + li {
    margin-top: 0.25rem;
  }
  /* Custom-links card lays its entries out inline — reference:
     `flex flex-wrap gap-x-6 gap-y-1`. */
  .linkcard ul {
    display: flex;
    flex-wrap: wrap;
    column-gap: 1.5rem;
    row-gap: 0.25rem;
  }
  /* Link style — reference: text-sm text-blue-600 hover:text-blue-800
     hover:underline (blue-800 = #1e40af). */
  .promlink {
    font-size: 0.875rem;
    color: var(--link);
  }
  .promlink:hover {
    color: #1e40af;
    text-decoration: underline;
  }
</style>
