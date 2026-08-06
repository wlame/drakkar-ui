<script lang="ts">
  // Configs tab: every config field Drakkar accepts, joined with this worker's
  // live values (GET /api/v1/config-reference). Grouped sections mirror the
  // backend's config groups; each group links out to the published docs page
  // at its `doc_anchor`. A search box and a "changed only" toggle narrow the
  // (often large) field list down to what an operator is actually looking for.
  import { onDestroy, onMount } from 'svelte'
  import { api, type ConfigReferenceEntry, type ConfigReferenceGroup } from '../../lib/api'
  import { changedCount, docsUrl, filterGroups, fmtValue } from '../../lib/configref'
  import { isMultiline } from '../../lib/codeblock'
  import { copyText } from '../../lib/copy'
  import CodeBlock from '../CodeBlock.svelte'

  let groups = $state<ConfigReferenceGroup[] | null>(null)
  let error = $state<string | null>(null)

  let query = $state('')
  let changedOnly = $state(false)

  // Expanded detail rows, keyed by `${group.key}:${entry.path}` — a path
  // alone isn't guaranteed unique across groups, though in practice it is.
  let expanded = $state<Set<string>>(new Set())

  // Brief "copied" feedback, keyed the same way plus which field was copied
  // (`path` or `env`), so copying one cell doesn't flash feedback on another.
  let copiedField = $state<string | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  const filteredGroups = $derived(groups ? filterGroups(groups, query, changedOnly) : [])
  const totalChanged = $derived(groups ? changedCount(groups) : 0)

  function rowKey(group: ConfigReferenceGroup, entry: ConfigReferenceEntry): string {
    return `${group.key}:${entry.path}`
  }

  function toggleRow(key: string) {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    expanded = next
  }

  async function copyField(fieldKey: string, text: string) {
    const ok = await copyText(text)
    if (ok) {
      copiedField = fieldKey
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => (copiedField = null), 1200)
    }
  }

  onDestroy(() => clearTimeout(copyResetTimer))

  // pretty renders a full (untruncated) value/default for the expanded detail
  // row — fmtValue() is deliberately truncated for the table cell.
  function pretty(v: unknown): string {
    if (v === null || v === undefined) return '—'
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  async function load() {
    error = null
    try {
      const resp = await api.configReference()
      groups = resp.groups
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(load)
</script>

<div class="bar">
  <input placeholder="search path, env, or description" bind:value={query} />
  <label><input type="checkbox" bind:checked={changedOnly} /> Changed only</label>
  <span class="spacer"></span>
  <span class="changed-badge" class:accent={totalChanged > 0}>{totalChanged} changed</span>
</div>

{#if error}
  <p class="error">Failed to load config reference: <code>{error}</code></p>
  <button onclick={load}>Retry</button>
{:else if !groups}
  <p class="muted">Loading…</p>
{:else if filteredGroups.length === 0}
  <p class="muted">No config entries match</p>
{:else}
  {#each filteredGroups as group (group.key)}
    <section class="group">
      <div class="group-header">
        <h3>{group.title}</h3>
        <a href={docsUrl(group.doc_anchor)} target="_blank" rel="noopener" title="Open docs for this group">
          📚 docs
        </a>
      </div>
      <table>
        <thead>
          <tr>
            <th>Path</th>
            <th>Value</th>
            <th>Env</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {#each group.entries as entry (entry.path)}
            {@const key = rowKey(group, entry)}
            {@const isChanged = entry.is_default === false}
            {@const pathFieldKey = `${key}:path`}
            {@const envFieldKey = `${key}:env`}
            <tr
              class="row"
              class:changed={isChanged}
              class:expanded-row={expanded.has(key)}
              onclick={() => toggleRow(key)}
            >
              <td class="mono path-cell">
                <button
                  type="button"
                  class="copy-target"
                  title="Click to copy the config path"
                  onclick={(e) => {
                    e.stopPropagation()
                    copyField(pathFieldKey, entry.path)
                  }}
                >
                  {entry.path}
                </button>
                {#if copiedField === pathFieldKey}<span class="copied-hint">copied</span>{/if}
              </td>
              <td class="value-cell">
                {#if entry.secret}
                  <span class="mono secret-value">{fmtValue(entry.value)}</span>
                  <span class="chip secret-chip" title="This value is masked because the field is secret">🔒 secret</span>
                {:else}
                  <span class="mono" class:changed-value={isChanged}>{fmtValue(entry.value)}</span>
                {/if}
                {#if !entry.is_default}
                  <div class="default-line muted">default: {fmtValue(entry.default)}</div>
                {/if}
              </td>
              <td class="mono env-cell">
                {#if entry.env}
                  <button
                    type="button"
                    class="copy-target"
                    title="Click to copy the environment variable name"
                    onclick={(e) => {
                      e.stopPropagation()
                      copyField(envFieldKey, entry.env ?? '')
                    }}
                  >
                    {entry.env}
                  </button>
                  {#if copiedField === envFieldKey}<span class="copied-hint">copied</span>{/if}
                {:else}
                  <span class="muted">—</span>
                {/if}
              </td>
              <td class="desc-cell">{entry.description}</td>
            </tr>
            {#if expanded.has(key)}
              <tr class="detail-row">
                <td colspan="4">
                  <dl>
                    <dt>Description</dt>
                    <dd>{entry.full_description}</dd>
                    <dt>Type</dt>
                    <dd class="mono">{entry.type}</dd>
                  </dl>
                  <h4>Value</h4>
                  {#if entry.secret}
                    <p class="mono secret-value">{pretty(entry.value)}</p>
                  {:else if isMultiline(pretty(entry.value))}
                    <CodeBlock text={pretty(entry.value)} />
                  {:else}
                    <p class="mono">{pretty(entry.value)}</p>
                  {/if}
                  {#if !entry.is_default}
                    <h4>Default</h4>
                    {#if isMultiline(pretty(entry.default))}
                      <CodeBlock text={pretty(entry.default)} />
                    {:else}
                      <p class="mono muted">{pretty(entry.default)}</p>
                    {/if}
                  {/if}
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </section>
  {/each}
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .bar input:not([type='checkbox']) {
    flex: 1;
    min-width: 14rem;
  }
  .bar input {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .bar label {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.85rem;
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .changed-badge {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.15rem 0.65rem;
  }
  .changed-badge.accent {
    color: var(--accent);
    border-color: var(--accent);
  }

  .group {
    margin-bottom: 1.5rem;
  }
  .group-header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    background: var(--bg);
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }
  .group-header h3 {
    margin: 0;
  }
  .group-header a {
    font-size: 0.82rem;
    white-space: nowrap;
  }

  .row {
    cursor: pointer;
  }
  .row:hover td {
    background: #f0eee8;
  }
  .row.changed {
    border-left: 3px solid var(--accent);
    background: rgba(13, 148, 136, 0.06);
  }
  .row.changed td:first-child {
    border-left: 3px solid var(--accent);
    padding-left: calc(0.7rem - 3px);
  }
  .row.expanded-row td {
    border-bottom: none;
  }

  .path-cell {
    max-width: 20rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .env-cell {
    white-space: nowrap;
  }
  .desc-cell {
    color: var(--muted);
    font-size: 0.85rem;
  }
  .value-cell {
    max-width: 24rem;
    overflow-wrap: anywhere;
  }
  .changed-value {
    color: var(--text);
    font-weight: 600;
  }
  .default-line {
    font-size: 0.75rem;
    margin-top: 0.15rem;
  }
  .secret-value {
    letter-spacing: 0.1em;
    color: var(--muted);
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.68rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.02rem 0.4rem;
    margin-left: 0.4rem;
    color: var(--muted);
    white-space: nowrap;
  }

  .copy-target {
    all: unset;
    cursor: pointer;
  }
  .copy-target:hover {
    text-decoration: underline;
    text-decoration-style: dotted;
  }
  .copied-hint {
    margin-left: 0.4rem;
    font-size: 0.72rem;
    color: var(--accent);
  }

  .detail-row td {
    background: var(--panel-2);
    padding: 0.75rem 1rem 1rem;
  }
  .detail-row dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
  }
  .detail-row dt {
    color: var(--muted);
  }
  .detail-row dd {
    margin: 0;
  }
  .detail-row h4 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 0.6rem 0 0.3rem;
  }
  .detail-row p {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
