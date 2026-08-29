<script lang="ts">
  // The docs affordance (contract v1.22): a small book glyph rendered next to
  // whatever an operator bound a docs page to — a sink name, a label chip, a
  // declared page title, an event type. Clicking it opens the docs drawer.
  //
  // The default `onopen` publishes to the shared store, so a call site only
  // needs `<BookIcon {anchor} />`; the prop stays overridable for a caller
  // that wants the click for something else (a test, or a future inline
  // preview).
  //
  // The click is stopped from bubbling — the icon usually sits inside a row,
  // a chip or a label that has its own click handler (the KafkaIcon
  // precedent).
  import { openDocsAnchor } from '../lib/docsAnchors'
  import type { DocsAnchorWire } from '../lib/types'

  let {
    anchor,
    onopen = (a: DocsAnchorWire) => openDocsAnchor.set(a),
  }: {
    anchor: DocsAnchorWire
    onopen?: (anchor: DocsAnchorWire) => void
  } = $props()

  const label = $derived(anchor.title || 'Documentation')

  function open(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    onopen(anchor)
  }
</script>

<button class="docs-icon" title={label} aria-label={label} onclick={open}>
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    aria-hidden="true"
  >
    <path d="M4 4h9a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4z" />
    <path d="M20 4h-2a2 2 0 0 0-2 2v14a2.5 2.5 0 0 1 2.5-2.5H20z" />
  </svg>
</button>

<style>
  .docs-icon {
    display: inline-flex;
    align-items: center;
    vertical-align: -3px;
    margin-left: 0.3rem;
    padding: 0;
    /* Inherits the color of whatever it annotates — a teal sink name, a
       label chip, a page heading — and only dims itself, so it never fights
       the text it sits next to. */
    color: inherit;
    opacity: 0.55;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .docs-icon:hover {
    opacity: 1;
  }
</style>
