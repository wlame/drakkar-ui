<script lang="ts">
  // The docs drawer: the backend-served docs page for one anchor, framed in
  // the shared side panel so the operator keeps the live view behind it.
  // Mounted once, in App.svelte, and driven by the openDocsAnchor store — see
  // BookIcon.svelte for the icons that publish to it.
  //
  // An iframe rather than a fetch-and-render: the docs site is a prebuilt
  // static site with its own CSS, JS and search, and it is same-origin under
  // /docs/, so framing it costs nothing and reproduces it exactly.
  import SidePanel from './SidePanel.svelte'
  import { docsUrl, getDocsConfig } from '../lib/docsAnchors'
  import type { DocsAnchorWire } from '../lib/types'

  let { anchor, onclose }: { anchor: DocsAnchorWire; onclose: () => void } = $props()

  const url = $derived(docsUrl(anchor.path))
  // The anchor names the specific page; the site title is the fallback for an
  // anchor that declares no title of its own.
  const title = $derived(anchor.title || getDocsConfig()?.title || 'Documentation')

  // Escape closes the drawer. Caveat: Escape pressed while focus sits INSIDE
  // the iframe is delivered to the framed document, not to this one, so the
  // key never reaches this listener. Accepted for v1 — the panel's close
  // button is always visible, and cross-document key forwarding would need
  // the docs site to cooperate.
  $effect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onclose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })
</script>

<SidePanel {title} storageKey="drakkar-panel-docs" defaultWidth={40} {onclose}>
  <!-- SidePanel's body is a flex ITEM, not a container: without its own
       column layout and height chain here the iframe would collapse to its
       default 150px. -->
  <div class="docs-frame">
    <div class="docs-bar">
      <a href={url} target="_blank" rel="noopener">open in new tab ↗</a>
    </div>
    <iframe src={url} title="Documentation"></iframe>
  </div>
</SidePanel>

<style>
  .docs-frame {
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .docs-bar {
    flex: none;
    padding-bottom: 0.4rem;
    font-size: 0.8rem;
  }
  .docs-bar a {
    color: var(--muted);
    text-decoration: none;
  }
  .docs-bar a:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .docs-frame iframe {
    flex: 1;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
  }
</style>
