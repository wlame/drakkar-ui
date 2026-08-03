<script lang="ts">
  import { onMount } from 'svelte'
  import { api, type Partition, type WebappTile as WebappTileData } from '../lib/api'
  import WebappTile from '../components/WebappTile.svelte'
  import PartitionsTable from '../components/dashboard/PartitionsTable.svelte'

  let { params: _params = {} }: { params?: Record<string, string> } = $props()

  let rows = $state<Partition[] | null>(null)
  let error = $state<string | null>(null)
  let webappTile = $state<WebappTileData | null>(null)

  async function load() {
    try {
      rows = await api.partitions()
      error = null
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  onMount(() => {
    load()
    api
      .dashboard()
      .then((d) => (webappTile = d.webapp_tile ?? null))
      .catch(() => {})
  })
</script>

<h1>Partitions</h1>

{#if webappTile}
  <div class="tile-wrap"><WebappTile tile={webappTile} variant="wide" /></div>
{/if}

<PartitionsTable {rows} {error} />

<style>
  .tile-wrap {
    margin-bottom: 1.25rem;
  }
</style>
