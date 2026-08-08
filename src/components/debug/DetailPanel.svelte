<script lang="ts">
  // Renders a declared ProbeDetail layout over one clicked row, hosted inside
  // SidePanel by whichever tab opened it (currently UserDetailsTab). Driven
  // entirely by the layout, same philosophy as UserDetailsTab itself: this
  // component never knows the user's model, only the four wire element views.
  import type { ProbeDetail, ProbeDetailElement } from '../../lib/types'
  import { resolveTemplate, type LinkBases } from '../../lib/enrich'
  import { elementHeading, keyValueEntries, nestedTableColumns } from '../../lib/userDetails'

  let { detail, row, bases }: { detail: ProbeDetail; row: Record<string, unknown>; bases: LinkBases } =
    $props()

  function tableRows(el: ProbeDetailElement): Record<string, unknown>[] {
    const v = el.field ? row[el.field] : undefined
    return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
  }
</script>

{#each detail.elements as el, i (i)}
  {@const heading = elementHeading(el)}
  <div class="block">
    {#if heading}<h4>{heading}</h4>{/if}
    {#if el.view === 'string'}
      {@const value = el.field ? row[el.field] : undefined}
      <p class="mono value">{value === null || value === undefined || value === '' ? '—' : String(value)}</p>
    {:else if el.view === 'keyvalue'}
      {@const entries = keyValueEntries(el.field ? row[el.field] : undefined)}
      {#if entries.length === 0}
        <p class="muted">—</p>
      {:else}
        <div class="kv">
          {#each entries as [k, v] (k)}
            <span>{k}</span><span class="mono">{String(v)}</span>
          {/each}
        </div>
      {/if}
    {:else if el.view === 'table'}
      {@const rows = tableRows(el)}
      {@const columns = nestedTableColumns(rows)}
      {#if rows.length === 0}
        <p class="muted">No rows</p>
      {:else}
        <table>
          <thead>
            <tr>
              {#each columns as col (col.key)}
                <th>{col.label}</th>
              {/each}
            </tr>
          </thead>
          <tbody>
            {#each rows as r, ri (ri)}
              <tr>
                {#each columns as col (col.key)}
                  <td class="mono">{String(r[col.key] ?? '')}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    {:else if el.view === 'links'}
      {#if !el.links || el.links.length === 0}
        <p class="muted">—</p>
      {:else}
        <ul class="links">
          {#each el.links as link (link.label)}
            {@const href = resolveTemplate(link.template, { row, bases })}
            <li>
              {#if href}
                <a {href} target="_blank" rel="noopener noreferrer">{link.label}</a>
              {:else}
                <span class="muted">{link.label}</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{/each}

<style>
  .block {
    margin: 0 0 1.1rem;
  }
  .block h4 {
    margin: 0 0 0.3rem;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .value {
    margin: 0.2rem 0;
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
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
</style>
