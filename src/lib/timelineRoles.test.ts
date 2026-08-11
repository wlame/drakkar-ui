import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  TIMELINE_ROLES,
  clearAllRoleOverrides,
  clearRoleOverride,
  isOverridden,
  labelKeyUnion,
  loadRoleOverrides,
  resolveRoles,
  saveRoleOverride,
} from './timelineRoles'
import type { TimelineRoleBindings } from './types'
import type { TaskView } from './live'

function task(labels: Record<string, string> | null): TaskView {
  return {
    task_id: 't1',
    partition: 0,
    start_ts: 1000,
    end_ts: 1005,
    duration: 5,
    status: 'completed',
    exit_code: 0,
    args: null,
    pid: null,
    slot: null,
    labels,
    origin: 'kafka',
    client_name: null,
    request_id: null,
    stdout_size: null,
    stdout_lines: null,
    stdin_lines: null,
    stdin_size: null,
    env: null,
    source_offsets: null,
    spawn_ms: null,
    queue_wait_ms: null,
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('loadRoleOverrides / saveRoleOverride — round trip', () => {
  it('returns {} when nothing is stored for the worker', () => {
    expect(loadRoleOverrides('worker-a')).toEqual({})
  })

  it('round-trips a saved override through localStorage', () => {
    saveRoleOverride('worker-a', 'tag', 'module')
    expect(loadRoleOverrides('worker-a')).toEqual({ tag: 'module' })
  })

  it('keeps overrides for different workers independent', () => {
    saveRoleOverride('worker-a', 'tag', 'module')
    saveRoleOverride('worker-b', 'tag', 'stage')
    expect(loadRoleOverrides('worker-a')).toEqual({ tag: 'module' })
    expect(loadRoleOverrides('worker-b')).toEqual({ tag: 'stage' })
  })

  it('stores an explicit null (disabled) and round-trips it', () => {
    saveRoleOverride('worker-a', 'marker', null)
    expect(loadRoleOverrides('worker-a')).toEqual({ marker: null })
  })

  it('accumulates multiple role overrides for the same worker', () => {
    saveRoleOverride('worker-a', 'tag', 'module')
    saveRoleOverride('worker-a', 'caption', 'summary')
    expect(loadRoleOverrides('worker-a')).toEqual({ tag: 'module', caption: 'summary' })
  })

  it('returns {} when the stored value is corrupted JSON', () => {
    localStorage.setItem('dk.timeline.roles.worker-a', '{not valid json')
    expect(loadRoleOverrides('worker-a')).toEqual({})
  })
})

describe('resolveRoles', () => {
  const backend: TimelineRoleBindings = { tag: 'module', caption: 'summary' }

  it('follows the backend binding when a role has no override', () => {
    expect(resolveRoles(backend, {})).toEqual({ tag: 'module', caption: 'summary' })
  })

  it('substitutes a string override in place of the backend key', () => {
    expect(resolveRoles(backend, { tag: 'stage' })).toEqual({ tag: 'stage', caption: 'summary' })
  })

  it('a null override disables an otherwise backend-bound role', () => {
    expect(resolveRoles(backend, { tag: null })).toEqual({ caption: 'summary' })
  })

  it('leaves a role unbound if backend has no binding and there is no override', () => {
    expect(resolveRoles(backend, {})).not.toHaveProperty('highlight')
  })

  it('a string override can bind a role the backend left unbound', () => {
    expect(resolveRoles(backend, { highlight: 'severity' })).toEqual({
      tag: 'module',
      caption: 'summary',
      highlight: 'severity',
    })
  })
})

describe('clearRoleOverride', () => {
  it('restores the backend binding by removing just that role from storage', () => {
    saveRoleOverride('worker-a', 'tag', 'stage')
    saveRoleOverride('worker-a', 'caption', 'summary')

    clearRoleOverride('worker-a', 'tag')

    expect(loadRoleOverrides('worker-a')).toEqual({ caption: 'summary' })
    const backend: TimelineRoleBindings = { tag: 'module', caption: 'summary' }
    expect(resolveRoles(backend, loadRoleOverrides('worker-a'))).toEqual({
      tag: 'module',
      caption: 'summary',
    })
  })

  it('is a no-op when the role was never overridden', () => {
    saveRoleOverride('worker-a', 'caption', 'summary')
    clearRoleOverride('worker-a', 'tag')
    expect(loadRoleOverrides('worker-a')).toEqual({ caption: 'summary' })
  })
})

describe('clearAllRoleOverrides', () => {
  it('removes the storage key entirely for the worker', () => {
    saveRoleOverride('worker-a', 'tag', 'stage')
    saveRoleOverride('worker-a', 'caption', 'summary')

    clearAllRoleOverrides('worker-a')

    expect(localStorage.getItem('dk.timeline.roles.worker-a')).toBeNull()
    expect(loadRoleOverrides('worker-a')).toEqual({})
  })

  it('does not affect another worker sharing the module', () => {
    saveRoleOverride('worker-a', 'tag', 'stage')
    saveRoleOverride('worker-b', 'tag', 'phase')

    clearAllRoleOverrides('worker-a')

    expect(loadRoleOverrides('worker-a')).toEqual({})
    expect(loadRoleOverrides('worker-b')).toEqual({ tag: 'phase' })
  })
})

describe('labelKeyUnion', () => {
  it('merges label keys across tasks with backend-bound keys, sorted and deduped', () => {
    const tasks = [
      task({ module: 'scanner', stage: 'init' }),
      task({ module: 'scanner', severity: 'high' }),
    ]
    const backend: TimelineRoleBindings = { tag: 'module', highlight: 'priority' }

    expect(labelKeyUnion(tasks, backend)).toEqual(['module', 'priority', 'severity', 'stage'])
  })

  it('tolerates tasks with null labels', () => {
    const tasks = [task(null), task({ module: 'scanner' })]
    expect(labelKeyUnion(tasks, {})).toEqual(['module'])
  })

  it('returns an empty array when there is nothing to union', () => {
    expect(labelKeyUnion([], {})).toEqual([])
  })
})

describe('isOverridden', () => {
  const backend: TimelineRoleBindings = { tag: 'module' }

  it('is false when the role has no stored override', () => {
    expect(isOverridden(backend, {}, 'tag')).toBe(false)
  })

  it('is false when the stored value equals the backend key (not a real override)', () => {
    expect(isOverridden(backend, { tag: 'module' }, 'tag')).toBe(false)
  })

  it('is true when the stored value differs from the backend key', () => {
    expect(isOverridden(backend, { tag: 'stage' }, 'tag')).toBe(true)
  })

  it('is true when the stored value is null but the backend has a binding', () => {
    expect(isOverridden(backend, { tag: null }, 'tag')).toBe(true)
  })

  it('is false when both the stored value and backend are absent for a role', () => {
    expect(isOverridden(backend, { highlight: undefined }, 'highlight')).toBe(false)
  })
})

describe('storage access failures (private-mode denial)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('loadRoleOverrides returns {} when getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(loadRoleOverrides('worker-a')).toEqual({})
  })

  it('saveRoleOverride does not throw when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => saveRoleOverride('worker-a', 'tag', 'module')).not.toThrow()
  })

  it('clearRoleOverride does not throw when setItem throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => clearRoleOverride('worker-a', 'tag')).not.toThrow()
  })

  it('clearAllRoleOverrides does not throw when removeItem throws', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('denied')
    })
    expect(() => clearAllRoleOverrides('worker-a')).not.toThrow()
  })
})

describe('TIMELINE_ROLES', () => {
  it('lists exactly the five timeline roles', () => {
    expect(TIMELINE_ROLES).toEqual(['tag', 'caption', 'highlight', 'filter', 'marker'])
  })
})
