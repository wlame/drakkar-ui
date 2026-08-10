// Browser-local overrides for the timeline's label-role bindings (tag/caption/
// highlight/filter/marker — see TimelineRoleBindings in ./types). The backend
// config (ui.timeline.labels) picks defaults; a viewer can override or disable
// any role for their own browser only, per worker, persisted in localStorage.
// Pure module — no DOM beyond localStorage, no component wiring here.

import type { TimelineRoleBindings } from './types'
import type { TaskView } from './live'

export type TimelineRole = 'tag' | 'caption' | 'highlight' | 'filter' | 'marker'

export const TIMELINE_ROLES: TimelineRole[] = ['tag', 'caption', 'highlight', 'filter', 'marker']

// A role maps to a label key (override), null (explicitly disabled — no
// label fills this role even if the backend binds one), or is simply absent
// from the object (follow the backend binding).
export type RoleOverrides = Partial<Record<TimelineRole, string | null>>

function storageKey(workerId: string): string {
  return `dk.timeline.roles.${workerId}`
}

/**
 * Reads the browser-local role overrides for a worker. Absent-safe: no
 * stored value, a read error (e.g. private-mode localStorage denial), or
 * corrupted JSON all resolve to `{}` rather than throwing.
 */
export function loadRoleOverrides(workerId: string): RoleOverrides {
  try {
    const raw = localStorage.getItem(storageKey(workerId))
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RoleOverrides
    }
    return {}
  } catch {
    return {}
  }
}

// Writes the full overrides object for a worker, silently doing nothing if
// storage is unavailable or over quota (private-mode safety).
function writeRoleOverrides(workerId: string, overrides: RoleOverrides): void {
  try {
    localStorage.setItem(storageKey(workerId), JSON.stringify(overrides))
  } catch {
    // Silent no-op: private-mode storage denial or quota exceeded.
  }
}

/**
 * Sets one role's override for a worker: a label key to bind, or `null` to
 * explicitly disable the role regardless of the backend binding.
 */
export function saveRoleOverride(workerId: string, role: TimelineRole, key: string | null): void {
  const overrides = loadRoleOverrides(workerId)
  overrides[role] = key
  writeRoleOverrides(workerId, overrides)
}

/** Removes one role's override, letting it fall back to the backend binding. */
export function clearRoleOverride(workerId: string, role: TimelineRole): void {
  const overrides = loadRoleOverrides(workerId)
  delete overrides[role]
  writeRoleOverrides(workerId, overrides)
}

/** Removes every override for a worker, deleting its storage entry outright. */
export function clearAllRoleOverrides(workerId: string): void {
  try {
    localStorage.removeItem(storageKey(workerId))
  } catch {
    // Silent no-op: private-mode storage denial.
  }
}

/**
 * Merges the backend's default role bindings with a viewer's local
 * overrides: an overridden role uses the override's key (omitted from the
 * result when the override is `null`, i.e. disabled); a role with no
 * override follows the backend binding (omitted when the backend leaves it
 * unbound too).
 */
export function resolveRoles(
  backend: TimelineRoleBindings,
  overrides: RoleOverrides,
): TimelineRoleBindings {
  const result: TimelineRoleBindings = {}
  for (const role of TIMELINE_ROLES) {
    const resolved = role in overrides ? overrides[role] : backend[role]
    if (resolved !== null && resolved !== undefined) {
      result[role] = resolved
    }
  }
  return result
}

/**
 * The full set of label keys a role picker should offer: every label key
 * seen across `tasks`, plus every key the backend currently binds to a role
 * (so a bound key stays selectable even if no visible task currently
 * carries it), sorted and deduplicated.
 */
export function labelKeyUnion(tasks: TaskView[], backend: TimelineRoleBindings): string[] {
  const keys = new Set<string>()
  for (const task of tasks) {
    if (!task.labels) continue
    for (const key of Object.keys(task.labels)) keys.add(key)
  }
  for (const role of TIMELINE_ROLES) {
    const bound = backend[role]
    if (bound !== undefined) keys.add(bound)
  }
  return Array.from(keys).sort()
}

/**
 * True when a role's stored override actually changes behavior relative to
 * the backend — i.e. there is a stored value and it differs from the
 * backend's own binding for that role. Storing the backend's own key back
 * (a no-op selection) does not count as overridden; an unbound role with no
 * stored value doesn't either.
 */
export function isOverridden(
  backend: TimelineRoleBindings,
  overrides: RoleOverrides,
  role: TimelineRole,
): boolean {
  if (!(role in overrides)) return false
  const stored = overrides[role] ?? null
  const backendValue = backend[role] ?? null
  return stored !== backendValue
}
