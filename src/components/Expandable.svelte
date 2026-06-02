<script lang="ts">
  // A click-to-expand text cell, mirroring the reference's delegated `.expandable`
  // handler: a long value renders truncated on one line and toggles to full,
  // wrapped text on click. Keyboard-accessible (Enter/Space).
  let {
    text = '',
    title = 'Click to expand',
    color = 'var(--muted)',
  }: { text?: string; title?: string; color?: string } = $props()
  let expanded = $state(false)

  function toggle() {
    expanded = !expanded
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle()
    }
  }
</script>

<span
  class="expandable"
  class:expanded
  title={expanded ? '' : title}
  style:color
  role="button"
  tabindex="0"
  onclick={toggle}
  onkeydown={onKey}
>{text}</span>

<style>
  .expandable {
    cursor: pointer;
    font-size: 0.8rem;
  }
  .expandable:not(.expanded) {
    display: inline-block;
    max-width: 22rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: bottom;
  }
  .expandable.expanded {
    white-space: pre-wrap;
    word-break: break-all;
  }
</style>
