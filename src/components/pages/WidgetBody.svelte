<script lang="ts">
  // Renders one declared-page widget's body: fetches its data (fetchWidgetRows
  // / fetchStatValue) on mount and whenever refreshSeq bumps (the page shell
  // owns the WS-driven refresh — this component just reacts to the prop), then
  // dispatches on `view` to a generic renderer. Reuses the same cell/kv/table
  // building blocks as the probe's User-defined tab (userDetails.ts,
  // SortableTh) rather than inventing widget-specific markup.
  import type { ProbeDetailsColumn, UIPageWidget } from '../../lib/types'
  import { fetchStatValue, fetchWidgetRows, scalarValue, type WidgetRow } from '../../lib/widgets'
  import { renderCell, keyValueEntries, tableAccessors, columnNumeric } from '../../lib/userDetails'
  import { badgeColor, formatValue, getLinkBases } from '../../lib/enrich'
  import { NO_SORT, sortRows, type SortState } from '../../lib/sort'
  import SortableTh from '../SortableTh.svelte'
  import CustomCell from '../CustomCell.svelte'

  let { widget, refreshSeq = 0 }: { widget: UIPageWidget; refreshSeq?: number } = $props()

  const KNOWN_VIEWS = new Set(['table', 'keyvalue', 'string', 'badge', 'stat'])

  type Status = 'loading' | 'ready' | 'error' | 'unsupported'
  // Why a widget is unsupported, so the placeholder can name the actual
  // culprit instead of always blaming `widget.view`:
  //  - 'view': the declared view itself isn't one this UI knows how to render
  //    (forward-compat — an older UI against a newer backend).
  //  - 'source': the view is fine, but fetchWidgetRows didn't recognize
  //    `source.kind` (same forward-compat story, the other half of the pair).
  //  - 'config': the view/source pairing is one this UI DOES know, but the
  //    widget is missing data it needs (stat without a `metric`) — a
  //    config-authoring bug, not version skew, so it gets its own wording.
  type UnsupportedReason = 'view' | 'source' | 'config'

  let status = $state<Status>('loading')
  let unsupportedReason = $state<UnsupportedReason | null>(null)
  let rows = $state<WidgetRow[]>([])
  let statValue = $state<number | null>(null)
  let sort = $state<SortState>(NO_SORT)

  function markUnsupported(reason: UnsupportedReason) {
    status = 'unsupported'
    unsupportedReason = reason
  }

  // Bumped at the start of every reload() call; a call only applies what it
  // fetched if it is still the latest one once its awaited fetch settles.
  // The component instance is reused across navigation (widgets are keyed by
  // index — see UserPage.svelte), so an old widget's in-flight request can
  // resolve after a new widget's, and without this guard the stale response
  // would land last and overwrite the correct rows/statValue.
  let requestId = 0

  async function reload() {
    const currentRequest = ++requestId
    status = 'loading'
    unsupportedReason = null
    if (!KNOWN_VIEWS.has(widget.view)) {
      markUnsupported('view')
      return
    }
    try {
      if (widget.view === 'stat') {
        const metric = typeof widget.source.metric === 'string' ? widget.source.metric : null
        if (metric === null) {
          markUnsupported('config')
          return
        }
        const value = await fetchStatValue(metric)
        if (currentRequest !== requestId) return
        statValue = value
      } else {
        const result = await fetchWidgetRows(widget)
        if (currentRequest !== requestId) return
        if (result === null) {
          markUnsupported('source')
          return
        }
        rows = result
      }
      status = 'ready'
    } catch (e) {
      if (currentRequest !== requestId) return
      console.warn(`failed to load widget "${widget.title}"`, e)
      status = 'error'
    }
  }

  // Reload on mount and whenever the parent bumps refreshSeq.
  $effect(() => {
    void refreshSeq
    reload()
  })

  const newestRow = $derived<WidgetRow | undefined>(rows[0])
  const scalar = $derived(scalarValue(rows, widget.field ?? ''))
</script>

{#snippet table(tableRows: WidgetRow[], columns: ProbeDetailsColumn[])}
  {@const accessors = tableAccessors(columns)}
  <table>
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <SortableTh bind:sort key={col.key} label={col.label} numeric={columnNumeric(tableRows, col.key)} />
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each sortRows(tableRows, sort, accessors) as row, i (i)}
        <tr>
          {#each columns as col (col.key)}
            {@const cell = renderCell(row[col.key], row, col, getLinkBases())}
            {#if col.renderer}
              <!-- renderer is boot-time exclusive with link_template/badge_colors/format
                   (the backend rejects declaring both), so checking it first here never
                   shadows a badge/link cell that also wants to render. -->
              <td title={cell.title}>
                <CustomCell
                  name={col.renderer}
                  value={row[col.key]}
                  {row}
                  cellKey={col.key}
                  fallbackText={cell.text}
                />
              </td>
            {:else if col.badge_colors}
              <td><span class="badge{cell.badge ? ` badge-${cell.badge}` : ''}" title={cell.title}>{cell.text}</span></td>
            {:else if cell.href}
              <td class="mono"><a href={cell.href} target="_blank" rel="noopener noreferrer" title={cell.title}>{cell.text}</a></td>
            {:else}
              <td class="mono" title={cell.title}>{cell.text}</td>
            {/if}
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#if status === 'loading'}
  <p class="muted">Loading…</p>
{:else if status === 'error'}
  <p class="muted">failed to load</p>
{:else if status === 'unsupported'}
  {#if unsupportedReason === 'view'}
    <p class="muted">This widget needs a newer UI (unsupported view '{widget.view}').</p>
  {:else if unsupportedReason === 'source'}
    <p class="muted">This widget needs a newer UI (unsupported source '{widget.source.kind}').</p>
  {:else}
    <p class="muted">This widget is misconfigured: a 'stat' view needs a source with a 'metric' field.</p>
  {/if}
{:else if widget.view === 'table'}
  {#if rows.length === 0}
    <p class="muted">No data.</p>
  {:else}
    {@render table(rows, widget.columns ?? [])}
  {/if}
{:else if widget.view === 'keyvalue'}
  {@const entries = keyValueEntries(widget.field ? newestRow?.[widget.field] : newestRow)}
  {#if entries.length === 0}
    <p class="muted">No data.</p>
  {:else}
    <div class="kv">
      {#each entries as [k, v] (k)}
        <span>{k}</span><span class="mono">{String(v)}</span>
      {/each}
    </div>
  {/if}
{:else if widget.view === 'string'}
  <p class="mono value">{scalar === null || scalar === undefined ? '—' : String(scalar)}</p>
{:else if widget.view === 'badge'}
  {#if scalar === null || scalar === undefined}
    <p class="value muted">—</p>
  {:else}
    {@const color = badgeColor(widget.badge_colors ?? {}, String(scalar))}
    <p class="value"><span class="badge{color ? ` badge-${color}` : ''}">{String(scalar)}</span></p>
  {/if}
{:else if widget.view === 'stat'}
  <p class="stat-value">
    {statValue === null ? '—' : widget.format ? formatValue(widget.format, statValue) : statValue}
  </p>
{/if}

<style>
  /* table/th/td, .mono and .muted come from the global stylesheet
     (src/app.css) — only the extras a widget body needs are declared here,
     matching UserDetailsTab.svelte's split. */
  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
  }
  .kv > span:nth-child(odd) {
    color: var(--muted);
  }
  .value {
    margin: 0;
  }
  .stat-value {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .badge {
    font-size: 0.75rem;
    padding: 0.05rem 0.5rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel-2);
  }
  .badge-green {
    background: #d1fae5;
    border-color: #6ee7b7;
    color: #065f46;
  }
  .badge-red {
    background: #fecaca;
    border-color: #fca5a5;
    color: #991b1b;
  }
  .badge-yellow {
    background: #fffbeb;
    border-color: #fde68a;
    color: #92400e;
  }
  .badge-blue {
    background: #dbeafe;
    border-color: #93c5fd;
    color: #1e40af;
  }
  .badge-gray {
    background: var(--panel-2);
    border-color: var(--line);
    color: var(--muted);
  }
  .badge-purple {
    background: #f3e8ff;
    border-color: #d8b4fe;
    color: #6b21a8;
  }
</style>
