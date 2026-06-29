<script lang="ts">
  // Cache tab: browse the cache_entries table with scope/search/expired filters and
  // a single-entry detail panel (ports debug.html cache). Cache timestamps are
  // epoch MILLISECONDS (unlike the rest of the UI). Stats poll every 5s.
  import { onMount } from 'svelte'
  import { api, type CacheEntriesResponse, type CacheStats, type CacheEntryDetail } from '../../lib/api'
  import { fmtBytes, fmtDateTimeMs } from '../../lib/format'

  const PAGE_SIZE = 200

  let stats = $state<CacheStats | null>(null)
  let resp = $state<CacheEntriesResponse | null>(null)
  let error = $state<string | null>(null)

  let scope = $state('')
  let searchTerm = $state('')
  let expiredOnly = $state(false)
  let offset = $state(0)

  let detail = $state<CacheEntryDetail | null>(null)
  let detailError = $state<string | null>(null)

  const SCOPE_COLORS: Record<string, string> = { local: '#d97706', cluster: '#2563eb', global: '#059669' }

  async function loadStats() {
    try {
      stats = await api.cacheStats()
    } catch {
      // non-fatal
    }
  }

  async function loadEntries() {
    error = null
    try {
      resp = await api.cacheEntries({
        limit: PAGE_SIZE,
        offset,
        scope: scope || undefined,
        search: searchTerm.trim() || undefined,
        expired_only: expiredOnly || undefined,
      })
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function applyFilters() {
    offset = 0
    loadEntries()
  }
  function prev() {
    offset = Math.max(0, offset - PAGE_SIZE)
    loadEntries()
  }
  function next() {
    offset = offset + PAGE_SIZE
    loadEntries()
  }

  async function openDetail(key: string) {
    detail = null
    detailError = null
    try {
      detail = await api.cacheEntry(key)
    } catch (e) {
      detailError = e instanceof Error && e.message.includes('404') ? 'Entry not found' : 'Failed to load entry'
    }
  }

  function expiresCell(ms: number | null): { text: string; cls: string } {
    if (ms == null) return { text: 'never', cls: 'muted' }
    if (ms < Date.now()) return { text: 'expired', cls: 'expired' }
    return { text: fmtDateTimeMs(ms), cls: 'muted' }
  }

  function pretty(v: unknown): string {
    if (typeof v === 'string') return v
    try {
      return JSON.stringify(v, null, 2)
    } catch {
      return String(v)
    }
  }

  onMount(() => {
    loadStats()
    loadEntries()
    const id = setInterval(loadStats, 5000)
    return () => clearInterval(id)
  })
</script>

{#if stats}
  <div class="stats">
    <div class="stat"><span class="k">Entries (memory)</span><span class="v" style:color="var(--accent)">{stats.entries_in_memory}</span></div>
    <div class="stat"><span class="k">Bytes (memory)</span><span class="v" style:color="var(--accent)">{fmtBytes(stats.bytes_in_memory)}</span></div>
    <div class="stat"><span class="k">Entries (DB)</span><span class="v">{stats.entries_in_db}</span></div>
    <div class="stat"><span class="k">Bytes (DB)</span><span class="v">{fmtBytes(stats.bytes_in_db)}</span></div>
  </div>
{/if}

<div class="bar">
  <select bind:value={scope}>
    <option value="">All scopes</option>
    <option value="local">local</option>
    <option value="cluster">cluster</option>
    <option value="global">global</option>
  </select>
  <input placeholder="search key (case-sensitive)" bind:value={searchTerm} onkeydown={(e) => e.key === 'Enter' && applyFilters()} />
  <label><input type="checkbox" bind:checked={expiredOnly} /> expired only</label>
  <button onclick={applyFilters}>Apply</button>
  <span class="muted">{resp ? `${resp.total} matching entries` : ''}</span>
</div>

{#if error}
  <p class="error">Failed to load entries: <code>{error}</code></p>
  <button onclick={loadEntries}>Retry</button>
{:else if !resp}
  <p class="muted">Loading…</p>
{:else if resp.entries.length === 0}
  <p class="muted">{offset > 0 ? 'No entries on this page' : 'No cache entries'}</p>
{:else}
  <table>
    <thead>
      <tr><th>Key</th><th>Scope</th><th class="num">Size</th><th>Updated</th><th>Expires</th><th>Origin</th></tr>
    </thead>
    <tbody>
      {#each resp.entries as e (e.key)}
        {@const ex = expiresCell(e.expires_at_ms)}
        <tr class="clickable" onclick={() => openDetail(e.key)}>
          <td class="mono key">{e.key}</td>
          <td><span class="pill" style:color={SCOPE_COLORS[e.scope] ?? 'var(--muted)'}>{e.scope}</span></td>
          <td class="num mono">{fmtBytes(e.size_bytes)}</td>
          <td class="muted nowrap">{fmtDateTimeMs(e.updated_at_ms)}</td>
          <td class={ex.cls}>{ex.text}</td>
          <td class="mono muted">{e.origin_worker_id}</td>
        </tr>
      {/each}
    </tbody>
  </table>

  <div class="pager">
    <button onclick={prev} disabled={offset <= 0}>← Prev</button>
    <span class="muted">{offset + 1}–{Math.min(offset + PAGE_SIZE, resp.total)} of {resp.total}</span>
    <button onclick={next} disabled={offset + PAGE_SIZE >= resp.total}>Next →</button>
  </div>
{/if}

{#if detail || detailError}
  <div class="sidebar">
    <div class="sb-head">
      <span>Cache entry</span>
      <button class="x" onclick={() => { detail = null; detailError = null }} aria-label="Close">×</button>
    </div>
    {#if detailError}
      <p class="error">{detailError}</p>
    {:else if detail}
      <dl>
        <dt>Key</dt><dd class="mono break">{detail.key}</dd>
        <dt>Scope</dt><dd>{detail.scope}</dd>
        <dt>Size</dt><dd>{fmtBytes(detail.size_bytes)}</dd>
        <dt>Created</dt><dd>{fmtDateTimeMs(detail.created_at_ms)}</dd>
        <dt>Updated</dt><dd>{fmtDateTimeMs(detail.updated_at_ms)}</dd>
        <dt>Expires</dt><dd>{detail.expires_at_ms == null ? 'never' : fmtDateTimeMs(detail.expires_at_ms)}</dd>
        <dt>Origin Worker</dt><dd class="mono">{detail.origin_worker_id}</dd>
      </dl>
      <h3>Value</h3>
      <pre class="block">{detail.value != null ? pretty(detail.value) : detail.raw_value}</pre>
    {/if}
  </div>
{/if}

<style>
  .stats {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.75rem 1rem;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--panel);
  }
  .stat .k {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
  }
  .stat .v {
    font-size: 1.3rem;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .bar input:not([type='checkbox']) {
    flex: 1;
    min-width: 12rem;
  }
  .bar input,
  .bar select {
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
  }
  .key {
    max-width: 24rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nowrap {
    white-space: nowrap;
  }
  .pill {
    font-size: 0.72rem;
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 0.05rem 0.45rem;
  }
  .expired {
    color: var(--error);
  }
  .clickable {
    cursor: pointer;
  }
  .clickable:hover td {
    background: var(--panel-2);
  }
  .pager {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-top: 1rem;
    font-size: 0.85rem;
  }
  .sidebar {
    position: fixed;
    top: 3.25rem;
    right: 0;
    width: 26rem;
    max-width: 92vw;
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
    font-weight: 600;
    margin-bottom: 0.75rem;
  }
  .sb-head .x {
    padding: 0.1rem 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.25rem 0.75rem;
    font-size: 0.85rem;
    margin: 0 0 1rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .break {
    word-break: break-all;
  }
  h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    margin: 0 0 0.4rem;
  }
  .block {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.75rem;
    max-height: 24rem;
    overflow: auto;
    font-family: var(--mono);
    font-size: 0.78rem;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
</style>
