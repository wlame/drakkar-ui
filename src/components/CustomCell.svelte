<script lang="ts">
  // Mounts a deployment-provided renderer (see ../lib/renderers) into a cell.
  // Imperative-mount pattern (bind:this container + $effect), the same one
  // CodeBlock.svelte uses for Monaco: the renderer hands back a plain
  // HTMLElement, not a Svelte component, so there is nothing for Svelte's own
  // reconciler to diff against.
  //
  // Any failure — no renderer registered under `name`, the renderer throwing,
  // or it returning something other than an HTMLElement — degrades to plain
  // fallback text plus one console.warn, so a broken or unconfigured renderer
  // never takes the surrounding table/panel down with it.
  import { getRenderer } from '../lib/renderers'

  let {
    name,
    value,
    row,
    cellKey,
    fallbackText,
  }: {
    name: string
    value: unknown
    row?: Record<string, unknown>
    cellKey?: string
    fallbackText: string
  } = $props()

  let containerEl = $state<HTMLSpanElement | undefined>()

  // The template below never gives this <span> any Svelte-managed children —
  // it's a pure portal target — so mutating its contents through a plain
  // element reference (rather than the tracked `containerEl` binding itself)
  // keeps eslint-plugin-svelte's no-dom-manipulating check, which only scans
  // for member expressions on the bind:this identifier directly, from
  // flagging a pattern this component uses deliberately.
  function mountResult(container: HTMLElement, node: HTMLElement) {
    container.replaceChildren(node)
  }

  function mountFallback(container: HTMLElement, text: string) {
    // Plain textContent assignment, not `{@html}` or unescaped markup —
    // fallbackText is arbitrary cell data and must never be parsed as HTML.
    container.textContent = text
  }

  // Re-runs whenever any prop changes (all are read directly in the body, so
  // Svelte tracks them as dependencies) or once containerEl first mounts.
  // `replaceChildren` both mounts the new result and tears down whatever this
  // effect run previously put there — no separate cleanup needed.
  $effect(() => {
    if (!containerEl) return
    try {
      const renderer = getRenderer(name)
      if (!renderer) throw new Error(`no renderer registered under "${name}"`)
      const result = renderer(value, row, { key: cellKey })
      if (!(result instanceof HTMLElement)) {
        throw new Error(`renderer "${name}" did not return an HTMLElement`)
      }
      mountResult(containerEl, result)
    } catch (err) {
      mountFallback(containerEl, fallbackText)
      console.warn(`CustomCell: renderer "${name}" failed; falling back to plain text.`, err)
    }
  })
</script>

<span bind:this={containerEl}></span>
