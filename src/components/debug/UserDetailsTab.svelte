<script lang="ts">
  // Generic renderer for the probe's User-defined tab. Driven ENTIRELY by
  // the layout descriptor — this component never knows the user's model.
  import type { ProbeDetail, ProbeDetailsColumn, ProbeDetailsEntry, ProbeUserDetails } from '../../lib/types'
  import { NO_SORT, sortRows, type SortState } from '../../lib/sort'
  import {
    buildTree,
    columnNumeric,
    groupedRows,
    renderCell,
    resolveDetailTitle,
    stageBadges,
    tableAccessors,
    touchedFields,
    valueColumns,
    type DetailsTreeNode,
  } from '../../lib/userDetails'
  import { getLinkBases } from '../../lib/enrich'
  import SortableTh from '../SortableTh.svelte'
  import CodeBlock from '../CodeBlock.svelte'
  import SidePanel from '../SidePanel.svelte'
  import DetailPanel from './DetailPanel.svelte'
  import CustomCell from '../CustomCell.svelte'

  let { details }: { details: ProbeUserDetails } = $props()

  let collapsedSections = $state<Set<string>>(new Set())
  // One independent sort state per rendered table: keyed by entry key for
  // 'table' fields, and by `${entry.key}:${group}` for each sub-table of a
  // 'tables' field.
  let tableSorts = $state<Record<string, SortState>>({})
  // The row-detail side panel. `detail`/`row` are captured straight out of the
  // click closure (never re-derived from the event target), so a re-render
  // that replaces the clicked <tr> afterwards cannot orphan the data it needs.
  let openPanel = $state<{ title: string; detail: ProbeDetail; row: Record<string, unknown> } | null>(null)

  const touched = $derived(touchedFields(details.writes))

  function openRowDetail(detail: ProbeDetail, entryLabel: string, row: Record<string, unknown>) {
    openPanel = { title: resolveDetailTitle(detail, row, entryLabel, getLinkBases()), detail, row }
  }

  function toggleSection(title: string) {
    const next = new Set(collapsedSections)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    collapsedSections = next
  }
  function rowsFor(entry: ProbeDetailsEntry): Record<string, unknown>[] {
    const v = details.data[entry.key]
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
  }
  function kvFor(entry: ProbeDetailsEntry): [string, unknown][] {
    const v = details.data[entry.key]
    return v && typeof v === 'object' ? Object.entries(v as Record<string, unknown>) : []
  }
  function pretty(v: unknown): string {
    try {
      return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }
</script>

{#snippet detailsTable(rows: Record<string, unknown>[], columns: ProbeDetailsColumn[], sortKey: string, detail: ProbeDetail | null | undefined, entryLabel: string)}
  {@const accessors = tableAccessors(columns)}
  <table>
    <thead>
      <tr>
        {#each columns as col (col.key)}
          <SortableTh
            bind:sort={
              () => tableSorts[sortKey] ?? NO_SORT,
              (v) => (tableSorts = { ...tableSorts, [sortKey]: v })
            }
            key={col.key}
            label={col.label}
            numeric={columnNumeric(rows, col.key)}
          />
        {/each}
        {#if detail}<th aria-hidden="true"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each sortRows(rows, tableSorts[sortKey] ?? NO_SORT, accessors) as row, i (i)}
        <tr
          class:clickable={!!detail}
          onclick={detail ? () => openRowDetail(detail, entryLabel, row) : undefined}
        >
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
              <td class="mono"><a href={cell.href} target="_blank" rel="noopener noreferrer" title={cell.title} onclick={(e) => e.stopPropagation()}>{cell.text}</a></td>
            {:else}
              <td class="mono" title={cell.title}>{cell.text}</td>
            {/if}
          {/each}
          {#if detail}<td class="chevron" aria-hidden="true">›</td>{/if}
        </tr>
      {/each}
    </tbody>
  </table>
{/snippet}

{#snippet treeNodes(nodes: DetailsTreeNode[], leafColumns: ProbeDetailsColumn[], depth: number, path: string, detail: ProbeDetail | null | undefined, entryLabel: string)}
  {#each nodes as node (node.key)}
    <details class="treenode" open={depth === 0}>
      <summary><span class="mono">{node.key}</span> <span class="muted">— {node.count} rows</span></summary>
      <div class="treebody">
        {#if node.children}
          {@render treeNodes(node.children, leafColumns, depth + 1, `${path}/${node.key}`, detail, entryLabel)}
        {:else if leafColumns.length}
          {@render detailsTable(node.rows, leafColumns, `${path}/${node.key}`, detail, entryLabel)}
        {/if}
      </div>
    </details>
  {/each}
{/snippet}

<p class="muted model">model: <span class="mono">{details.model}</span></p>

{#each details.layout.sections as section (section.title)}
  <section class="card">
    <h3>
      <button class="toggle" onclick={() => toggleSection(section.title)}>
        {collapsedSections.has(section.title) ? '▸' : '▾'} {section.title}
      </button>
    </h3>
    {#if !collapsedSections.has(section.title)}
      {#each section.entries as entry (entry.key)}
        <div class="entry" class:dim={!touched.has(entry.key)}>
          <h4>
            {entry.label}
            {#each stageBadges(details.writes, entry.key) as badge (badge.stage)}
              <span class="badge">{badge.stage}{badge.count > 1 ? ` ×${badge.count}` : ''}</span>
            {/each}
          </h4>
          {#if !touched.has(entry.key)}
            <p class="muted">—</p>
          {:else if entry.view === 'string'}
            {@const cell = renderCell(details.data[entry.key], undefined, entry, getLinkBases())}
            {#if cell.href}
              <p class="mono value">
                <a href={cell.href} target="_blank" rel="noopener noreferrer" title={cell.title}>{cell.text}</a>
              </p>
            {:else}
              <p class="mono value" title={cell.title}>{cell.text || '—'}</p>
            {/if}
          {:else if entry.view === 'badge'}
            {@const cell = renderCell(details.data[entry.key], undefined, entry, getLinkBases())}
            <p class="value">
              <span class="badge{cell.badge ? ` badge-${cell.badge}` : ''}" title={cell.title}>{cell.text}</span>
            </p>
          {:else if entry.view === 'custom'}
            {@const value = details.data[entry.key]}
            <!-- 'custom' is a closed view on its own (not layered on top of
                 link_template/badge_colors/format), so there is no
                 renderCell call and no precedence question here either. -->
            <p class="value">
              <CustomCell
                name={entry.renderer ?? ''}
                {value}
                cellKey={entry.key}
                fallbackText={value === null || value === undefined || value === '' ? '—' : String(value)}
              />
            </p>
          {:else if entry.view === 'keyvalue'}
            <div class="kv">
              {#each kvFor(entry) as [k, v] (k)}
                <span>{k}</span><span class="mono">{String(v)}</span>
              {/each}
            </div>
          {:else if entry.view === 'dict'}
            <details open>
              <summary class="muted">expand</summary>
              <CodeBlock text={pretty(details.data[entry.key])} language="json" />
            </details>
          {:else if entry.view === 'table'}
            {@const rows = rowsFor(entry)}
            <p class="muted">{rows.length} rows</p>
            {#if rows.length}
              {@render detailsTable(rows, entry.columns ?? [], entry.key, entry.detail, entry.label)}
            {/if}
          {:else if entry.view === 'tables'}
            {@const groups = groupedRows(details.data[entry.key])}
            <p class="muted">{groups.length} groups</p>
            {#each groups as [group, rows] (group)}
              <h5 class="group"><span class="mono">{group}</span> <span class="muted">— {rows.length} rows</span></h5>
              {#if rows.length}
                {@render detailsTable(rows, entry.columns ?? [], `${entry.key}:${group}`, entry.detail, entry.label)}
              {/if}
            {/each}
          {:else if entry.view === 'tree'}
            {@const rows = rowsFor(entry)}
            {@const groupBy = entry.group_by ?? []}
            <p class="muted">{rows.length} rows</p>
            {#if groupBy.length}
              {@render treeNodes(buildTree(rows, groupBy), valueColumns(entry.columns ?? [], groupBy), 0, entry.key, entry.detail, entry.label)}
            {:else if rows.length}
              <!-- Defensive: a tree entry without group_by (contract drift)
                   degrades to the plain flat table instead of rendering
                   nothing. -->
              {@render detailsTable(rows, entry.columns ?? [], entry.key, entry.detail, entry.label)}
            {/if}
          {/if}
        </div>
      {/each}
    {/if}
  </section>
{/each}

{#if openPanel}
  <SidePanel
    title={openPanel.title}
    storageKey="drakkar-panel-user-details"
    defaultWidth={30}
    onclose={() => (openPanel = null)}
  >
    <DetailPanel detail={openPanel.detail} row={openPanel.row} bases={getLinkBases()} />
  </SidePanel>
{/if}

<style>
  .card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
    padding: 1rem;
    margin-bottom: 1rem;
  }
  h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
  }
  h4 {
    margin: 0.8rem 0 0.3rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .badge {
    text-transform: none;
    letter-spacing: normal;
    font-size: 0.7rem;
    padding: 0.05rem 0.4rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: var(--panel-2);
  }
  /* Enrichment badge colors (probe_field view='badge' / column badge_colors).
     No color match (or an unstyled '*' fallback) leaves the base .badge
     look — same green/red/amber/blue triad as the Live WS/freeze pills and
     Timeline's label/env chips, plus gray and purple for the two colors
     those don't already cover. */
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
  .entry.dim {
    opacity: 0.45;
  }
  /* Row-detail affordance: only rows whose entry declares `detail` get the
     pointer cursor and trailing chevron cell. */
  .clickable {
    cursor: pointer;
  }
  .chevron {
    color: var(--muted);
    text-align: center;
    width: 1.5rem;
  }
  /* Sub-table heading of a 'tables' entry — the group name is user data
     (file names, ids), so it keeps normal casing, unlike the uppercase h4. */
  h5.group {
    margin: 0.6rem 0 0.25rem;
    font-size: 0.8rem;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  /* One collapsible level of a 'tree' entry; nesting indents via .treebody. */
  details.treenode {
    margin: 0.25rem 0;
  }
  details.treenode > summary {
    cursor: pointer;
    font-size: 0.85rem;
    overflow-wrap: anywhere;
  }
  .treebody {
    margin-left: 1rem;
    padding-left: 0.5rem;
    border-left: 1px solid var(--line);
  }
  .kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    font-size: 0.85rem;
  }
  .kv > span:nth-child(odd) {
    color: var(--muted);
  }
  /* `all: unset` so the button keeps the section header's own styling
     instead of looking like one of the page's buttons — same idiom as
     SortableTh's sort button. */
  button.toggle {
    all: unset;
    cursor: pointer;
    user-select: none;
  }
  .model {
    margin: 0 0 0.8rem;
  }
  .value {
    margin: 0.2rem 0;
  }
</style>
