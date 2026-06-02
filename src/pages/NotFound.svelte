<script lang="ts">
  import { currentPath, link } from '../lib/router'

  // Pages receive their matched route params from the router; NotFound ignores them.
  let { params: _params = {} }: { params?: Record<string, string> } = $props()
</script>

<h1>Not found</h1>
<p class="muted">
  No page is mapped to <code>{$currentPath}</code>.
</p>
<p><a href="/" use:link>← Back to the dashboard</a></p>
