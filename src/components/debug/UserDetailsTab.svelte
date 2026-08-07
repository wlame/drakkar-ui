<script lang="ts">
  // Generic renderer for the probe's User-defined tab. Driven ENTIRELY by
  // the layout descriptor — this component never knows the user's model.
  import type { ProbeDetailsColumn, ProbeDetailsEntry, ProbeUserDetails } from '../../lib/types'
  import { NO_SORT, sortRows, type SortState } from '../../lib/sort'
  import { columnNumeric, groupedRows, stageBadges, tableAccessors, touchedFields } from '../../lib/userDetails'
  import SortableTh from '../SortableTh.svelte'
  import CodeBlock from '../CodeBlock.svelte'

  let { details }: { details: ProbeUserDetails } = $props()

  let collapsedSections = $state<Set<string>>(new Set())
  // One independent sort state per rendered table: keyed by entry key for
  // 'table' fields, and by `${entry.key}:${group}` for each sub-table of a
  // 'tables' field.
  let tableSorts = $state<Record<string, SortState>>({})

  const touched = $derived(touchedFields(details.writes))

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

{#snippet detailsTable(rows: Record<string, unknown>[], columns: ProbeDetailsColumn[], sortKey: string)}
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
      </tr>
    </thead>
    <tbody>
      {#each sortRows(rows, tableSorts[sortKey] ?? NO_SORT, accessors) as row, i (i)}
        <tr>
          {#each columns as col (col.key)}
            <td class="mono">{String(row[col.key] ?? '')}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
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
            <p class="mono value">{String(details.data[entry.key] ?? '—')}</p>
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
              {@render detailsTable(rows, entry.columns ?? [], entry.key)}
            {/if}
          {:else if entry.view === 'tables'}
            {@const groups = groupedRows(details.data[entry.key])}
            <p class="muted">{groups.length} groups</p>
            {#each groups as [group, rows] (group)}
              <h5 class="group"><span class="mono">{group}</span> <span class="muted">— {rows.length} rows</span></h5>
              {#if rows.length}
                {@render detailsTable(rows, entry.columns ?? [], `${entry.key}:${group}`)}
              {/if}
            {/each}
          {/if}
        </div>
      {/each}
    {/if}
  </section>
{/each}

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
  .entry.dim {
    opacity: 0.45;
  }
  /* Sub-table heading of a 'tables' entry — the group name is user data
     (file names, ids), so it keeps normal casing, unlike the uppercase h4. */
  h5.group {
    margin: 0.6rem 0 0.25rem;
    font-size: 0.8rem;
    font-weight: 600;
    overflow-wrap: anywhere;
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
