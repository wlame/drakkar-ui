<script lang="ts">
  // DLQ browser tab: a time-window listing of the dead-letter topic through
  // the kafka-read API (contract v1.13, alias 'dlq'). Reads are ad-hoc and
  // group-less on the backend — browsing the DLQ moves no offsets and is
  // invisible to the pipeline. Rows open a side panel with the full payload
  // and headers, plus a "Probe this message" jump that deep-links the
  // Message Probe tab (#probe/dlq/<p>/<o>) so the record can be replayed
  // through the live handler with zero side effects.
  import { api, type KafkaReadMessage } from '../../lib/api'
  import { fmtBytes, fmtDateTimeMs } from '../../lib/format'
  import { probeHash } from '../../lib/kafkaRead'
  import { setHash } from '../../lib/router'
  import CodeBlock from '../CodeBlock.svelte'
  import SidePanel from '../SidePanel.svelte'

  // datetime-local speaks a zone-less local string ("2026-08-19T17:04");
  // these two convert to/from epoch ms in the browser's zone.
  function toLocalInput(ms: number): string {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  function fromLocalInput(v: string): number | null {
    if (!v) return null
    const ms = new Date(v).getTime()
    return Number.isFinite(ms) ? ms : null
  }

  const HOUR_MS = 3_600_000

  // Window controls. Default: the last hour, newest-bounded by "no to_ts"
  // (the backend stops at its end-of-topic snapshot), capped at 200 rows.
  let fromLocal = $state(toLocalInput(Date.now() - HOUR_MS))
  let toLocal = $state('')
  let limit = $state(200)
  // Bound to a number input: Svelte hands back '' (cleared) or a number.
  let partitionFilter = $state<string | number>('')

  let rows = $state<KafkaReadMessage[]>([])
  let streamError = $state<string | null>(null)
  let loadError = $state<string | null>(null)
  let busy = $state(false)
  let loadedOnce = $state(false)
  let selected = $state<KafkaReadMessage | null>(null)

  async function load() {
    loadError = null
    streamError = null
    const fromTs = fromLocalInput(fromLocal)
    if (fromTs == null) {
      loadError = 'from is required'
      return
    }
    const toTs = fromLocalInput(toLocal)
    if (toTs != null && toTs < fromTs) {
      loadError = 'to must not be before from'
      return
    }
    const partition = partitionFilter === '' ? undefined : Number(partitionFilter)
    if (partition !== undefined && (!Number.isInteger(partition) || partition < 0)) {
      loadError = 'partition must be a non-negative integer'
      return
    }
    busy = true
    try {
      const res = await api.kafkaMessages('dlq', {
        from_ts: fromTs,
        to_ts: toTs ?? undefined,
        limit,
        partition,
      })
      rows = res.messages
      streamError = res.streamError
      loadedOnce = true
      selected = null
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function probe(msg: KafkaReadMessage) {
    setHash(probeHash('dlq', msg.partition, msg.offset))
  }

  function preview(payload: string): string {
    return payload.length > 160 ? payload.slice(0, 160) + '…' : payload
  }
  function pretty(text: string): string {
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }

  // Load the default window on first render — an empty DLQ answers fast and
  // the common visit intent is "what landed here recently?".
  $effect(() => {
    if (!loadedOnce && !busy) void load()
  })
</script>

<form class="bar" onsubmit={(e) => { e.preventDefault(); void load() }}>
  <label>From<input type="datetime-local" bind:value={fromLocal} required /></label>
  <label>To<input type="datetime-local" bind:value={toLocal} /></label>
  <label>Limit<input type="number" min="1" max="10000" bind:value={limit} /></label>
  <label>Partition<input type="number" min="0" placeholder="all" bind:value={partitionFilter} /></label>
  <button class="primary" type="submit" disabled={busy}>{busy ? 'Loading…' : 'Load'}</button>
  <span class="muted">{loadedOnce ? `${rows.length} message${rows.length === 1 ? '' : 's'}` : ''}</span>
</form>

{#if loadError}<p class="error">{loadError}</p>{/if}
{#if streamError}
  <p class="error">The listing is incomplete — the stream ended with an error: {streamError}</p>
{/if}

{#if loadedOnce && rows.length === 0 && !loadError}
  <p class="muted empty">No DLQ messages in this window. Widen the time range, or celebrate.</p>
{:else if rows.length}
  <div class="tablewrap">
    <table>
      <thead>
        <tr><th>time</th><th>p:offset</th><th>key</th><th>size</th><th>payload</th></tr>
      </thead>
      <tbody>
        {#each rows as m (m.partition + ':' + m.offset)}
          <tr class="row" class:sel={selected === m} onclick={() => (selected = m)}>
            <td class="mono nowrap">{fmtDateTimeMs(m.timestamp_ms)}</td>
            <td class="mono nowrap">P{m.partition}:{m.offset}</td>
            <td class="mono">{m.key ?? ''}</td>
            <td class="mono nowrap">{fmtBytes(m.payload_size_bytes)}</td>
            <td class="mono clip">{preview(m.payload)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if selected}
  <SidePanel
    title={`DLQ P${selected.partition}:${selected.offset}`}
    storageKey="drakkar-panel-dlq-message"
    defaultWidth={34}
    onclose={() => (selected = null)}
  >
    <div class="actions">
      <button class="primary" onclick={() => selected && probe(selected)}>Probe this message</button>
    </div>
    <dl>
      <dt>time</dt><dd class="mono">{fmtDateTimeMs(selected.timestamp_ms)}</dd>
      <dt>key</dt><dd class="mono">{selected.key ?? '—'}{selected.key_encoding === 'base64' ? ' (base64)' : ''}</dd>
      <dt>size</dt><dd class="mono">{fmtBytes(selected.payload_size_bytes)}</dd>
      {#if selected.payload_encoding === 'base64'}
        <dt>encoding</dt><dd>binary payload — shown base64-encoded</dd>
      {/if}
    </dl>
    {#if selected.headers.length}
      <h3>Headers</h3>
      <dl>
        {#each selected.headers as h}
          <dt class="mono">{h.key}</dt>
          <dd class="mono">{h.value ?? '—'}{h.value_encoding === 'base64' ? ' (base64)' : ''}</dd>
        {/each}
      </dl>
    {/if}
    <h3>Payload</h3>
    <CodeBlock text={pretty(selected.payload)} maxHeight="30rem" />
  </SidePanel>
{/if}

<style>
  .bar {
    display: flex;
    align-items: end;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.8rem;
  }
  .bar label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: var(--muted);
  }
  .bar input {
    font: inherit;
    color: var(--text);
    background: var(--panel-2);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 0.3rem 0.5rem;
  }
  .bar input[type='number'] {
    width: 6.5rem;
  }
  .bar .muted {
    align-self: center;
  }
  .empty {
    padding: 1.5rem 0;
  }
  .tablewrap {
    overflow-x: auto;
  }
  .row {
    cursor: pointer;
  }
  .row.sel {
    background: rgba(13, 148, 136, 0.07);
  }
  .nowrap {
    white-space: nowrap;
  }
  .clip {
    max-width: 34rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    margin-bottom: 0.8rem;
  }
</style>
