// Pure color-rule engine for the Live timeline: evaluates ui.timeline.color_rules
// (GET /api/v1/identity -> timeline.color_rules) against a task and picks the bar
// color, plus the legend text each rule shows. No DOM; consumed by the timeline
// geometry/component wiring (Timeline.svelte).
//
// Rule matching is first-match-wins, AND across a rule's `when` conditions. A
// condition targets either a task label (`labels[key]`, a dynamic string map)
// or a fixed task field, and is absent-safe: a missing label or a null/undefined
// field fails every op except `missing` — this is deliberate so, e.g., a
// `{field: stdout_size, op: eq, value: 0}` rule matches only finished
// empty-output tasks, never a running task whose stdout_size is still null.

import type { TimelineColorRule, TimelineCondition } from './types'
import type { TaskView } from './live'

/** Named colors a rule may reference, alongside a raw '#rrggbb' hex. */
export const TIMELINE_PALETTE: Record<string, string> = {
  green: '#34d399',
  red: '#f87171',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  gray: '#9ca3af',
  lightgray: '#d1d5db',
  purple: '#a78bfa',
  orange: '#fb923c',
}

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/**
 * Resolves a rule's `color` field to a CSS hex value: a palette name maps
 * through {@link TIMELINE_PALETTE}, a literal `#rrggbb` passes through
 * unchanged, and anything else (an unrecognized name, a malformed backend
 * value) falls back to the palette's neutral gray rather than rendering an
 * invalid CSS color.
 */
export function ruleHex(color: string): string {
  const named = TIMELINE_PALETTE[color]
  if (named) return named
  if (HEX_COLOR_RE.test(color)) return color
  return TIMELINE_PALETTE.gray
}

// The condition's target key, used both to read the task value and (for an
// unnamed rule) to label the generated legend text: the label key when the
// condition targets a label, otherwise the field name.
function targetKey(cond: TimelineCondition): string {
  return cond.label ?? cond.field ?? ''
}

// Reads the value a condition targets: a label reads from the task's label
// map (undefined when the key is absent or labels is null), a field reads
// the same-named TaskView property directly. Exactly one of label/field is
// set by a compliant backend.
function targetValue(task: TaskView, cond: TimelineCondition): unknown {
  if (cond.label !== undefined) {
    return task.labels?.[cond.label]
  }
  if (cond.field !== undefined) {
    return (task as unknown as Record<string, unknown>)[cond.field]
  }
  return undefined
}

function isAbsent(value: unknown): boolean {
  return value === null || value === undefined
}

// parseFinite mirrors the backend's numeric coercion for gt/ge/lt/le/eq/ne:
// parseFloat of the String() form, NaN when it doesn't parse as a number.
function parseFinite(value: unknown): number {
  return parseFloat(String(value))
}

/**
 * Evaluates one condition against a task. See the module doc for the
 * absent-value and numeric-vs-string comparison rules.
 */
export function evalCondition(task: TaskView, cond: TimelineCondition): boolean {
  const actual = targetValue(task, cond)
  const absent = isAbsent(actual)

  if (cond.op === 'exists') return !absent
  if (cond.op === 'missing') return absent
  if (absent) return false

  switch (cond.op) {
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le': {
      const a = parseFinite(actual)
      const b = parseFinite(cond.value)
      if (Number.isNaN(a) || Number.isNaN(b)) return false
      if (cond.op === 'gt') return a > b
      if (cond.op === 'ge') return a >= b
      if (cond.op === 'lt') return a < b
      return a <= b
    }
    case 'eq':
    case 'ne': {
      const a = parseFinite(actual)
      const b = parseFinite(cond.value)
      const equal =
        Number.isFinite(a) && Number.isFinite(b) ? a === b : String(actual) === String(cond.value)
      return cond.op === 'eq' ? equal : !equal
    }
    case 'contains':
      return String(actual).includes(String(cond.value))
    case 'prefix':
      return String(actual).startsWith(String(cond.value))
    default:
      // Forward compatibility: an op this UI doesn't know yet never matches
      // rather than throwing, same as an unrecognized widget view (v1.5).
      return false
  }
}

const HTTP_ORIGIN_COLOR = '#9c27b0'

const STATUS_COLOR: Record<string, string> = {
  completed: TIMELINE_PALETTE.green,
  failed: TIMELINE_PALETTE.red,
}

/**
 * The bar color for a task: the first `rules` entry whose `when` conditions
 * all match (AND), else the implicit fallback — the `origin === 'http'`
 * color, then a status color (running falls through to yellow).
 */
export function barColorFor(task: TaskView, rules: TimelineColorRule[]): string {
  for (const rule of rules) {
    if (rule.when.every((cond) => evalCondition(task, cond))) {
      return ruleHex(rule.color)
    }
  }
  if (task.origin === 'http') return HTTP_ORIGIN_COLOR
  return STATUS_COLOR[task.status] ?? TIMELINE_PALETTE.yellow
}

// generatedLabel renders a condition as legend text for an unnamed rule,
// e.g. "stdout_size eq 0" or "file_size_bytes gt 10240".
function generatedLabel(cond: TimelineCondition): string {
  return `${targetKey(cond)} ${cond.op} ${cond.value}`
}

/**
 * Legend chips for the configured color rules, in rule order: a named rule
 * (`name` non-empty) shows its name, an unnamed rule shows generated text
 * for each of its `when` conditions joined with '&'. Colors are resolved
 * through {@link ruleHex}.
 */
export function legendEntries(rules: TimelineColorRule[]): { label: string; color: string }[] {
  return rules.map((rule) => ({
    label: rule.name ? rule.name : rule.when.map(generatedLabel).join(' & '),
    color: ruleHex(rule.color),
  }))
}
