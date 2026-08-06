// Pure helpers for the Configs debug tab. Kept separate from the component so
// the filtering/formatting logic is unit-testable without mounting Svelte.
import type { ConfigReferenceEntry, ConfigReferenceGroup } from './types'

const TRUNCATE_AT = 120

// filterGroups returns a NEW array of groups, each holding a NEW array of
// entries, matching `query` (case-insensitive substring over path/env/
// description/full_description) and, when `changedOnly` is set, restricted to
// entries whose live value differs from the default (`is_default === false`).
// A group with zero surviving entries is dropped entirely, so an empty search
// or an all-default group never renders an empty header. Never mutates its
// input — several tabs re-render from a poll while a page is open, and this
// helper runs on every keystroke.
export function filterGroups(
  groups: readonly ConfigReferenceGroup[],
  query: string,
  changedOnly: boolean,
): ConfigReferenceGroup[] {
  const q = query.trim().toLowerCase()

  function matches(entry: ConfigReferenceEntry): boolean {
    if (changedOnly && entry.is_default !== false) return false
    if (!q) return true
    return (
      entry.path.toLowerCase().includes(q) ||
      (entry.env ?? '').toLowerCase().includes(q) ||
      entry.description.toLowerCase().includes(q) ||
      entry.full_description.toLowerCase().includes(q)
    )
  }

  const result: ConfigReferenceGroup[] = []
  for (const group of groups) {
    const entries = group.entries.filter(matches)
    if (entries.length === 0) continue
    result.push({ ...group, entries })
  }
  return result
}

// changedCount totals entries across every group whose live value differs
// from the default — the toolbar's "N changed" badge.
export function changedCount(groups: readonly ConfigReferenceGroup[]): number {
  let n = 0
  for (const group of groups) {
    for (const entry of group.entries) {
      if (entry.is_default === false) n++
    }
  }
  return n
}

// fmtValue renders a config value for the table cell: null (the `*` template
// row, or a genuinely null default) as an em dash, strings verbatim (no
// quoting — a config string is already text), everything else compact JSON.
// Long output is truncated with an ellipsis; the expanded detail row shows
// the full, untruncated value.
export function fmtValue(value: unknown): string {
  let text: string
  if (value === null || value === undefined) {
    return '—'
  } else if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length > TRUNCATE_AT) return `${text.slice(0, TRUNCATE_AT)}…`
  return text
}

// docsUrl builds the published config-reference doc-site deep link for a
// group's `doc_anchor`.
export function docsUrl(anchor: string): string {
  return `https://wlame.github.io/drakkar/config-reference/#${anchor}`
}
