<script lang="ts">
  // The Slice view (design 2.6, 3.6): the filters of a slice, kept in the URL
  // (`db_*` keys; the task id and label value are typed per visit and never
  // go there), the limits the server enforces, and the download links. A
  // download is a plain navigation to the building worker's own origin: the
  // file is never read into this page.
  import { onDestroy, onMount, untrack } from 'svelte'
  import { api, type DatabasesResponse, type WorkerPeer } from '../../../lib/api'
  import { coverageSummary, type Coverage } from '../../../lib/coverage'
  import { DB_RANGES, DB_SOURCES, isOffsetsText, type DbViewState, ALL_WORKERS } from '../../../lib/dbview'
    import { fanOutTargets } from '../../../lib/fanout'
  import { fmtDateTimeMs } from '../../../lib/format'
  import {
    EMPTY_SLICE_FORM,
    RECORDER_EVENT_TYPES,
    SLICE_BUILD_LIMIT_SECONDS,
    SLICE_LIMITS_TEXT,
    buildSliceRequest,
    canSliceCluster,
    clusterPlan,
    fromLocalInput,
    perWorkerLinks,
    providerOf,
    resolveBuilder,
    resolveRange,
    sliceFileName,
    sourcesFor,
    toLocalInput,
    validateSliceRequest,
    type SliceForm,
    type SliceLink,
  } from '../../../lib/slices'
  import type { OwnSection } from './types'

  interface Props {
    data: DatabasesResponse
    ownSections: OwnSection[]
    workers: WorkerPeer[]
    currentWorker: string
    view: DbViewState
    coverage: Coverage
    onchange: (change: Partial<DbViewState>) => void
  }
  let { data, ownSections, workers, currentWorker, view, coverage, onchange }: Props = $props()

  let form = $state<SliceForm>({ ...EMPTY_SLICE_FORM })
  let nowSeconds = $state(Math.floor(Date.now() / 1000))
  // A typed from/to that cannot be a range yet stays here, not in the URL.
  let draft = $state<{ from: number; to: number } | null>(null)
  let offsetsText = $state(untrack(() => view.offsets ?? ''))
  let offsetsBad = $state(false)
  let building = $state<string | null>(null)
  // Whether this page's own worker has the slice route; null until probed.
  let ownSupported = $state<boolean | null>(null)

  onMount(async () => {
    ownSupported = await api.debugSliceSupportedAt('')
  })

  const targets = $derived(fanOutTargets(workers))
  const ownTarget = $derived({ worker: currentWorker, base: '' })
  const builder = $derived(resolveBuilder(view.worker, ownTarget, targets.targets))
  const everyWorker = $derived(view.worker === ALL_WORKERS)

  // The databases answer of the worker that builds: its own section when it is a peer.
  // The history is the shared folder, read once on this page's worker, so a peer uses it too.
  const builderView = $derived.by(() => {
    const section = builder && builder.base !== '' ? ownSections.find((s) => s.worker === builder.worker) : undefined
    return section ? { own: section.own, history: data.history, recorder: section.recorder } : data
  })
  const available = $derived(sourcesFor(builderView))
  const provider = $derived(providerOf(builderView))
  const clusterAllowed = $derived(canSliceCluster(builderView))

  const range = $derived(draft ?? resolveRange(view, nowSeconds))
  const request = $derived({ ...buildSliceRequest(view, form, nowSeconds), ...range })
  const problem = $derived(validateSliceRequest(request, available))
  const rangeKey = $derived(view.from !== null || draft ? 'custom' : view.range)

  const plan = $derived.by((): { links: SliceLink[]; notes: string[] } => {
    if (view.scope === 'cluster') {
      return clusterPlan(provider, request, builder ?? ownTarget, targets.targets)
    }
    if (everyWorker) return { links: perWorkerLinks(request, targets.targets), notes: [] }
    const target = builder ?? ownTarget
    return {
      links: [{ base: target.base, worker: target.worker, label: target.worker || 'this worker', request }],
      notes: [],
    }
  })

  // Does the worker behind a link have the route? false = it does not.
  function supported(link: SliceLink): boolean | null {
    if (link.base === '') return ownSupported
    const section = ownSections.find((s) => s.worker === link.worker)
    return section ? section.recorder !== undefined : null
  }
  const builderUnsupported = $derived(
    builder !== null && plan.links.length > 0 && plan.links.every((l) => supported(l) === false),
  )

  const eventChoices = $derived([...new Set([...RECORDER_EVENT_TYPES, ...(view.types ?? [])])])
  const ownerNames = $derived({ worker: builder?.worker || currentWorker, cluster: data.worker?.cluster ?? null })

  function pickRange(key: string) {
    draft = null
    if (key !== 'custom') onchange({ range: key as DbViewState['range'], from: null, to: null })
    else onchange({ from: range.from, to: range.to })
  }

  function setBound(which: 'from' | 'to', text: string) {
    const value = fromLocalInput(text)
    if (value === null) return
    const next = { ...range, [which]: value }
    if (next.to > next.from) {
      draft = null
      onchange({ from: next.from, to: next.to })
    } else {
      draft = next
    }
  }

  function toggleSource(source: string) {
    const current = view.sources ?? available
    const next = current.includes(source) ? current.filter((s) => s !== source) : [...current, source]
    const ordered = DB_SOURCES.filter((s) => next.includes(s))
    onchange({ sources: ordered.length === available.length ? null : ordered })
  }

  function toggleType(type: string) {
    const current = view.types ?? []
    const next = current.includes(type) ? current.filter((t) => t !== type) : [...current, type]
    onchange({ types: next.length ? next : null })
  }

  function setOffsets(text: string) {
    offsetsText = text
    offsetsBad = text !== '' && !isOffsetsText(text)
    if (text === '') onchange({ offsets: null })
    else if (!offsetsBad) onchange({ offsets: text })
  }

  function href(link: SliceLink): string {
    return api.debugSliceUrl(link.base, link.request)
  }

  // The click opens a link made at that moment, so a "last 15 minutes" range
  // is counted back from the click and not from when the page was drawn.
  function download(event: MouseEvent, link: SliceLink) {
    event.preventDefault()
    nowSeconds = Math.floor(Date.now() / 1000)
    const fresh = {
      ...link.request,
      ...(view.from === null && !draft ? resolveRange(view, nowSeconds) : {}),
    }
    window.open(api.debugSliceUrl(link.base, fresh), '_blank', 'noopener')
    building = link.label
    // The banner is a hint for the build time; it goes when the build limit has passed.
    clearTimeout(bannerTimer)
    bannerTimer = setTimeout(() => (building = null), SLICE_BUILD_LIMIT_SECONDS * 1000)
  }

  let bannerTimer: ReturnType<typeof setTimeout> | undefined
  onDestroy(() => clearTimeout(bannerTimer))

  // A link opened another way than a left click (middle click, context menu,
  // copy) uses its href as drawn, so the relative range is refreshed first.
  function freshen() {
    nowSeconds = Math.floor(Date.now() / 1000)
  }

  function clock(ts: number): string {
    return fmtDateTimeMs(ts * 1000)
  }
</script>

{#if builderUnsupported}
  <p class="muted" data-state="unsupported">
    This worker does not support slices: it runs a release older than the slice download.
  </p>
{:else if available.length === 0 && view.scope === 'worker' && !everyWorker}
  <p class="muted">This worker keeps no events (the recorder is off and it has no memory store), so there is nothing to slice.</p>
{:else}
  <p class="muted summary">{coverageSummary(coverage, clock)}</p>

  <fieldset>
    <legend>Range</legend>
    <div class="row">
      {#each [...DB_RANGES, 'custom'] as key}
        <button class:on={rangeKey === key} aria-pressed={rangeKey === key} onclick={() => pickRange(key)}>
          {key}
        </button>
      {/each}
    </div>
    {#if rangeKey === 'custom'}
      <div class="row">
        <label>from <input type="datetime-local" value={toLocalInput(range.from)} onchange={(e) => setBound('from', e.currentTarget.value)} aria-label="slice from" /></label>
        <label>to <input type="datetime-local" value={toLocalInput(range.to)} onchange={(e) => setBound('to', e.currentTarget.value)} aria-label="slice to" /></label>
      </div>
    {/if}
  </fieldset>

  <fieldset>
    <legend>Scope</legend>
    <div class="row">
      <label><input type="radio" name="slice-scope" checked={view.scope === 'worker'} onchange={() => onchange({ scope: 'worker' })} /> {everyWorker ? 'each worker' : 'this worker'}</label>
      {#if clusterAllowed}
        <label><input type="radio" name="slice-scope" checked={view.scope === 'cluster'} onchange={() => onchange({ scope: 'cluster' })} /> the whole cluster</label>
      {:else}
        <span class="muted">The whole cluster needs the recorder: it is off here.</span>
      {/if}
    </div>
    {#if view.scope === 'worker'}
      <div class="row">
        sources:
        {#each available as source}
          <label><input type="checkbox" checked={(view.sources ?? available).includes(source)} onchange={() => toggleSource(source)} /> {source}</label>
        {/each}
      </div>
    {:else}
      <p class="muted">The cluster file reads the shared sources the worker has; the sources are not chosen.</p>
    {/if}
  </fieldset>

  <fieldset>
    <legend>Filters</legend>
    <div class="row">
      event types (none checked = all):
      {#each eventChoices as type}
        <label><input type="checkbox" checked={(view.types ?? []).includes(type)} onchange={() => toggleType(type)} /> {type}</label>
      {/each}
    </div>
    <div class="row">
      <label>partition <input type="number" min="0" max="2147483647" value={view.partition ?? ''} onchange={(e) => onchange({ partition: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })} aria-label="partition" /></label>
      <label>offsets <input type="text" placeholder="from-to" value={offsetsText} oninput={(e) => setOffsets(e.currentTarget.value)} aria-label="offsets" /></label>
      {#if offsetsBad}<span class="error">write the offsets as from-to, for example 100-200</span>{/if}
    </div>
    <div class="row">
      <label>task id <input type="text" bind:value={form.taskId} aria-label="task id" /></label>
      <label>label key <input type="text" value={view.labelKey ?? ''} onchange={(e) => onchange({ labelKey: e.currentTarget.value || null })} aria-label="label key" /></label>
      <label>label value <input type="text" bind:value={form.labelValue} aria-label="label value" /></label>
    </div>
    <p class="muted">The task id and the label value are not kept in the address, because they can hold user data.</p>
    <div class="row">
      <label><input type="checkbox" bind:checked={form.output} /> include stdout and stderr</label>
      <label><input type="checkbox" bind:checked={form.compress} /> compress (gzip)</label>
      <label>max rows <input type="number" min="1" max="1000000" placeholder="200000" value={form.maxRows ?? ''} onchange={(e) => (form.maxRows = e.currentTarget.value === '' ? null : Number(e.currentTarget.value))} aria-label="max rows" /></label>
    </div>
  </fieldset>

  <ul class="muted limits">
    {#each SLICE_LIMITS_TEXT as line}<li>{line}</li>{/each}
  </ul>

  {#if problem}
    <p class="error" role="alert">{problem}</p>
  {:else}
    <p class="muted">File name: <code>{sliceFileName(request, ownerNames)}</code> (<code>-partial</code> when a limit ends the build)</p>
  {/if}

  <div class="links">
    {#each plan.links as link (`${link.label}:${link.request.scope}:${link.request.sources?.join('+') ?? ''}`)}
      {@const has = supported(link)}
      {#if problem}
        <button disabled>Download: {link.label}</button>
      {:else if has === false}
        <span class="muted">{link.label}: this worker does not support slices</span>
      {:else}
        <a class="button" href={href(link)} target="_blank" rel="noopener" onclick={(e) => download(e, link)}
          onpointerenter={freshen}
          onfocus={freshen}
          oncontextmenu={freshen}
          onauxclick={freshen}>Download: {link.label}</a>
      {/if}
    {/each}
  </div>
  {#each plan.notes as note}<p class="muted">{note}</p>{/each}
  {#if targets.unreachable.length && (view.scope === 'cluster' || everyWorker)}
    <p class="muted">No link for: {targets.unreachable.map((u) => `${u.worker} (${u.reason})`).join(', ')}</p>
  {/if}
  {#if building}
    <p class="banner" role="status">Building on {building} … the download starts when the file is ready (at most 60 s).</p>
  {/if}
{/if}

<style>
  fieldset {
    border: 1px solid var(--line);
    border-radius: 8px;
    margin: 0 0 0.8rem;
    padding: 0.5rem 0.8rem;
  }
  legend {
    color: var(--muted);
    font-size: 0.8rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    margin: 0.3rem 0;
  }
  .row button.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .limits {
    margin: 0 0 0.8rem;
    padding-left: 1.2rem;
    font-size: 0.85rem;
  }
  .links {
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
    margin: 0.6rem 0;
  }
  .links a.button {
    display: inline-block;
    padding: 0.35rem 0.8rem;
    border-radius: 6px;
    background: var(--accent);
    color: #fff;
    text-decoration: none;
  }
  .banner {
    padding: 0.6rem 0.9rem;
    border: 1px solid rgba(52, 211, 153, 0.4);
    border-radius: 8px;
    background: var(--panel);
    font-size: 0.9rem;
  }
</style>
