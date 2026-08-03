<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type SinkStatus } from '../lib/api'
  import { pausableInterval } from '../lib/visibility'
  import SinksTable from '../components/dashboard/SinksTable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  const POLL_MS = 2000

  let rows = $state<SinkStatus[] | null>(null)
  let error = $state<string | null>(null)

  async function load() {
    try {
      rows = await api.sinks()
      error = null
    } catch (e) {
      // Keep the last good list across transient poll failures; only surface an
      // error before the first successful load.
      if (rows === null) error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(() => pausableInterval(load, POLL_MS, { immediate: true }))
</script>

<h1>Sinks</h1>

<SinksTable {rows} {error} />
