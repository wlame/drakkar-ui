// Detach helpers (contract v1.33): presets within the maximum, the outcome
// sentences, the poll pace, the visibility rules and the time texts.
import { describe, expect, it } from 'vitest'
import {
  DETACH_FAST_POLL_MS,
  DETACH_SLOW_POLL_MS,
  OUTCOME_SENTENCES,
  bannerVisible,
  controlVisible,
  detachChoices,
  fmtTimeLeft,
  isRefusal,
  nextPollDelayMs,
  outcomeText,
} from './detach'
import type { DetachState } from './types'

function state(overrides: Partial<DetachState> = {}): DetachState {
  return {
    enabled: true,
    ui_enabled: true,
    state: 'attached',
    origin: null,
    reason: '',
    since_ms: null,
    until_ms: null,
    max_duration_seconds: 3600,
    default_duration_seconds: 900,
    last_request: null,
    ...overrides,
  }
}

describe('detachChoices', () => {
  it('offers 5 min, 15 min and 1 h when the maximum allows all three', () => {
    expect(detachChoices(3600)).toEqual([300, 900, 3600])
  })

  it('leaves out a preset above the maximum', () => {
    expect(detachChoices(1800)).toEqual([300, 900])
    expect(detachChoices(300)).toEqual([300])
  })

  it('offers the maximum alone when no preset fits', () => {
    expect(detachChoices(120)).toEqual([120])
  })
})

describe('outcomeText', () => {
  const reasons = [
    'not_running',
    'stopping',
    'disabled',
    'inside_pipeline_hook',
    'already_detached',
    'cooldown',
    'too_few_workers',
    'budget_full',
    'store_unavailable',
    'leave_failed',
    'held_by_operator',
    'join_failed',
  ]

  it('has a plain sentence for every refusal reason and attach answer', () => {
    for (const reason of reasons) {
      expect(OUTCOME_SENTENCES, `missing sentence for ${reason}`).toHaveProperty(reason)
      expect(outcomeText(reason)).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('says what to do when the budget is full', () => {
    expect(outcomeText('budget_full')).toBe(
      'The limit of detached workers in this group is reached. Attach another worker first, or wait.',
    )
  })

  it('shows an unknown value as it is', () => {
    expect(outcomeText('brand_new_reason')).toBe('brand_new_reason')
  })

  it('tells a success from a refusal', () => {
    expect(isRefusal('detached')).toBe(false)
    expect(isRefusal('attached')).toBe(false)
    expect(isRefusal('cooldown')).toBe(true)
    expect(isRefusal('brand_new_reason')).toBe(true)
  })
})

describe('nextPollDelayMs', () => {
  it('polls about once a second during a transition', () => {
    expect(nextPollDelayMs(state({ state: 'detaching' }), 0, 1000)).toBe(DETACH_FAST_POLL_MS)
    expect(nextPollDelayMs(state({ state: 'attaching' }), 0, 1000)).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls fast for a few seconds after a request', () => {
    expect(nextPollDelayMs(state(), 5000, 1000)).toBe(DETACH_FAST_POLL_MS)
  })

  it('polls slowly otherwise', () => {
    expect(nextPollDelayMs(state(), 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
    expect(nextPollDelayMs(state({ state: 'detached' }), 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
    expect(nextPollDelayMs(null, 0, 1000)).toBe(DETACH_SLOW_POLL_MS)
  })
})

describe('visibility', () => {
  it('shows the control only when the feature and the UI switch are on', () => {
    expect(controlVisible(state())).toBe(true)
    expect(controlVisible(state({ enabled: false }))).toBe(false)
    expect(controlVisible(state({ ui_enabled: false }))).toBe(false)
    expect(controlVisible(null)).toBe(false)
  })

  it('shows the banner for every state but attached', () => {
    expect(bannerVisible(state())).toBe(false)
    expect(bannerVisible(state({ state: 'detached' }))).toBe(true)
    expect(bannerVisible(state({ state: 'detaching' }))).toBe(true)
    expect(bannerVisible(state({ state: 'detached', enabled: false }))).toBe(false)
    expect(bannerVisible(null)).toBe(false)
  })
})

describe('fmtTimeLeft', () => {
  it('writes minutes and seconds, and hours when needed', () => {
    expect(fmtTimeLeft(65_000)).toBe('1:05')
    expect(fmtTimeLeft(3_725_000)).toBe('1:02:05')
  })

  it('never goes below zero', () => {
    expect(fmtTimeLeft(-5_000)).toBe('0:00')
  })
})
