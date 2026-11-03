<script lang="ts">
  // The Autodiscover view of the Databases tab (contract v1.30): the
  // registry with its cards (GET /api/v1/debug/autodiscover, from the
  // worker's memory) and the leases of the cluster tasks
  // (GET /api/v1/debug/autodiscover/leases, one store read per task). Both are
  // read on open and on Refresh only; nothing polls the store.
  import { onMount } from 'svelte'
  import { api, type AutodiscoverResponse, type LeasesResponse } from '../../../lib/api'
  import {
    cardLink,
    groupByCluster,
    lastSlotText,
    leaseStatusText,
    livenessText,
    registryLine,
    timeLeftText,
  } from '../../../lib/autodiscover'
  import { localClock } from '../../../lib/dbmode'

  let registry = $state<AutodiscoverResponse | null>(null)
  let leases = $state<LeasesResponse | null>(null)
  let registryMissing = $state(false)
  let leasesMissing = $state(false)
  let error = $state<string | null>(null)
  let loading = $state(false)

  async function load() {
    loading = true
    error = null
    try {
      const [cards, held] = await Promise.all([api.debugAutodiscover(), api.debugLeases()])
      registry = cards
      leases = held
      registryMissing = cards === null
      leasesMissing = held === null
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      loading = false
    }
  }

  onMount(load)

  const groups = $derived(registry ? groupByCluster(registry.workers) : [])

  function fmtAge(seconds: number | null): string {
    return seconds === null ? '-' : `${Math.round(seconds)}s`
  }
</script>

<div class="bar">
  <button onclick={load} disabled={loading}>{loading ? 'Reading…' : 'Refresh'}</button>
</div>

{#if error}
  <p class="error">Failed to read the autodiscover state: <code>{error}</code></p>
{/if}

<h2>Workers</h2>
{#if registryMissing}
  <p class="muted">The registry is not available on this worker.</p>
{:else if registry}
  <p class="muted" data-testid="registry-line">{registryLine(registry.registry, localClock)}</p>
  <p class="muted">
    This worker: <span class="mono">{registry.worker.name}</span>; card at
    <span class="mono">{registry.worker.key ?? 'not known yet'}</span>
  </p>
  {#if registry.workers.length === 0}
    <p class="muted">The registry lists no other worker.</p>
  {/if}
  {#each groups as group (group.cluster)}
    <h3>Cluster {group.cluster}</h3>
    <table>
      <thead>
        <tr>
          <th>Worker</th><th>Instance</th><th>State</th><th>Backend</th><th class="num">Age</th>
          <th>Liveness</th><th>Store key</th>
        </tr>
      </thead>
      <tbody>
        {#each group.rows as card (card.worker)}
          <tr>
            <td class="mono">
              {#if cardLink(card)}
                <a href={cardLink(card)} target="_blank" rel="noreferrer">{card.worker}</a>
              {:else}
                {card.worker}
              {/if}
            </td>
            <td class="mono">{card.instance}</td>
            <td>{card.state}</td>
            <td>{card.backend ?? '-'} {card.version ?? ''}</td>
            <td class="num mono">{fmtAge(card.age_seconds)}</td>
            <td>{livenessText(card.online)}</td>
            <td class="mono key">{card.key ?? '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/each}
  {#if registry.truncated}
    <p class="muted">Only the first {registry.workers.length} cards are shown.</p>
  {/if}
{/if}

<h2>Leases</h2>
{#if leasesMissing}
  <p class="muted">The leases are not available on this worker.</p>
{:else if leases}
  {#if leases.election === null}
    <p class="muted">No cluster task on this worker.</p>
  {:else}
    <p class="muted" data-testid="election-line">
      Election {leases.election.provider} · {leases.election.started ? 'started' : 'not started'}{leases
        .election.breaker_open
        ? ' · breaker open'
        : ''}
    </p>
    <table>
      <thead>
        <tr>
          <th>Task</th><th>Holder</th><th class="num">Lease</th><th class="num">Time left</th>
          <th>Next slot</th><th>Last slot here</th><th>Store key</th>
        </tr>
      </thead>
      <tbody>
        {#each leases.leases as lease (lease.task)}
          <tr>
            <td class="mono">{lease.task}{#if lease.system}<span class="chip">system</span>{/if}</td>
            <td class="status-{lease.status}">{leaseStatusText(lease, localClock)}</td>
            <td class="num mono">{lease.lease_seconds}s</td>
            <td class="num mono">{timeLeftText(lease.holder?.expires_in_seconds ?? null)}</td>
            <td class="nowrap">{lease.next_slot_ts !== null ? localClock(lease.next_slot_ts) : '-'}</td>
            <td class="nowrap">{lastSlotText(lease, localClock)}</td>
            <td class="mono key">{lease.key ?? '-'}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
{/if}

<style>
  .bar {
    margin-bottom: 0.9rem;
  }
  .num {
    text-align: right;
  }
  .nowrap {
    white-space: nowrap;
  }
  .key {
    font-size: 0.8rem;
    word-break: break-all;
  }
  .chip {
    margin-left: 0.4rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .status-failed,
  .status-breaker_open {
    color: #b45309;
  }
</style>
