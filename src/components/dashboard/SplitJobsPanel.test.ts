// The Dashboard "Split jobs" panel (contract v1.34): hidden without a
// splitting worker, a summary line, one row per job with its progress and
// links, the workers that did not answer, and the stale marker.
import { afterEach, describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import SplitJobsPanel from './SplitJobsPanel.svelte'
import { setConfig } from '../../lib/config'
import type { SplitView } from '../../lib/split'
import type { SplitJob, SplitState } from '../../lib/types'

function job(overrides: Partial<SplitJob> = {}): SplitJob {
  return {
    partition: 7,
    offset: 500,
    request_id: 'req_1',
    attempt: 1,
    phase: 'waiting',
    parts: 100,
    received: 40,
    failed: 0,
    dlq_parts: 0,
    tasks_succeeded: 0,
    tasks_failed: 0,
    opened_at: '2026-11-21T10:00:00.000000Z',
    age_seconds: 600,
    last_progress_at: null,
    timeout_at: null,
    timeout_kind: null,
    ...overrides,
  }
}

function splitState(overrides: Partial<SplitState> = {}): SplitState {
  return {
    enabled: true,
    worker: { name: 'worker-1', instance: 'a1b2c3d4e5f60718' },
    source_topic: 'requests',
    consumer_group: 'g1',
    parts_topic: 'requests_g1_split_parts',
    results_topic: 'requests_g1_split_results',
    parts_partition_base: 1000000,
    settings: { job_timeout_seconds: 86400, idle_timeout_seconds: 0, max_attempts: 3 },
    partitions: [],
    jobs: [job()],
    jobs_total: 1,
    result_write_failures_total: 0,
    ...overrides,
  }
}

function view(overrides: Partial<SplitView> = {}): SplitView {
  return {
    results: [{ worker: 'worker-1', base: '', state: splitState() }],
    unanswered: [],
    anySplit: true,
    ...overrides,
  }
}

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

function render(props: { view: SplitView | null; staleSince?: number | null; splitOn?: boolean }) {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SplitJobsPanel, {
    target,
    props: { staleSince: null, splitOn: false, ...props },
  })
  mounted.push({ target, component })
  flushSync()
  return target
}

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  setConfig({ kafkaUiBase: '', kafkaUiCluster: '', kafkaSourceTopic: '' })
})

describe('SplitJobsPanel', () => {
  it('is hidden when no worker splits', () => {
    const target = render({ view: view({ anySplit: false, results: [] }) })
    expect(target.querySelector('.split-jobs')).toBeNull()
    expect(render({ view: null }).querySelector('.split-jobs')).toBeNull()
  })

  it('shows when this worker splits, before the first answer', () => {
    const target = render({ view: null, splitOn: true })
    expect(target.querySelector('.split-jobs')).not.toBeNull()
  })

  it('shows the summary line', () => {
    const target = render({ view: view() })
    expect(target.querySelector('.split-summary')?.textContent?.trim()).toBe(
      '1 open job · 60 parts left · oldest 10m 0s',
    )
  })

  it('shows "splitting" for a job before its split is done', () => {
    const target = render({
      view: view({
        results: [
          {
            worker: 'worker-1',
            base: '',
            state: splitState({ jobs: [job({ parts: null, received: 0, phase: 'splitting' })] }),
          },
        ],
      }),
    })
    expect(target.querySelector('.split-progress')?.textContent).toContain('splitting')
    expect(target.textContent).not.toContain('NaN')
  })

  it('shows received / parts with the percentage', () => {
    const target = render({ view: view() })
    expect(target.querySelector('.split-progress')?.textContent).toContain('40 / 100 (40%)')
  })

  it('links the Trace tab with the job label', () => {
    const target = render({ view: view() })
    const anchor = target.querySelector('a.split-trace') as HTMLAnchorElement
    expect(anchor.getAttribute('href')?.endsWith('#trace-label/split_job=7%3A500')).toBe(true)
  })

  it('links the source message in the Kafka UI only when one is configured', () => {
    expect(render({ view: view() }).querySelector('a.split-kafka')).toBeNull()
    setConfig({ kafkaUiBase: 'http://kafka-ui', kafkaUiCluster: 'local' })
    const anchor = render({ view: view() }).querySelector('a.split-kafka') as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toContain('/all-topics/requests/')
    expect(anchor.getAttribute('href')).toContain('seekTo=7%3A%3A500')
  })

  it('lists a worker that did not answer with its reason', () => {
    const target = render({
      view: view({ unanswered: [{ worker: 'worker-2', reason: 'timed out' }] }),
    })
    expect(target.querySelector('.split-unanswered')?.textContent).toContain('worker-2: timed out')
  })

  it('names both owners of a job two workers report', () => {
    const target = render({
      view: view({
        results: [
          { worker: 'worker-1', base: '', state: splitState() },
          { worker: 'worker-2', base: 'http://w2', state: splitState() },
        ],
      }),
    })
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1)
    expect(target.querySelector('.split-owners')?.textContent).toContain('worker-1, worker-2')
  })

  it('marks a partition restoring for more than 120 s and write failures', () => {
    const target = render({
      view: view({
        results: [
          {
            worker: 'worker-1',
            base: '',
            state: splitState({
              partitions: [
                {
                  partition: 4,
                  state: 'restoring',
                  state_seconds: 130,
                  read_position: null,
                  open_jobs: null,
                  closed_jobs: null,
                },
              ],
              result_write_failures_total: 3,
            }),
          },
        ],
      }),
    })
    const marks = target.querySelector('.split-marks')?.textContent ?? ''
    expect(marks).toContain('worker-1 partition 4 restoring for 2m 10s')
    expect(marks).toContain('worker-1: 3 result writes failed')
  })

  it('shows the stale marker with the last rows', () => {
    const since = Date.UTC(2026, 10, 21, 12, 0, 0)
    const target = render({ view: view(), staleSince: since })
    expect(target.querySelector('.split-stale')?.textContent).toContain('stale since')
    expect(target.querySelectorAll('tbody tr')).toHaveLength(1)
  })
})

describe('SplitJobsPanel and workers without the split route', () => {
  it('lists a 404 peer as not available and keeps the panel shown', () => {
    const target = render({
      view: view({ unanswered: [{ worker: 'worker-2', reason: 'not available on this worker' }] }),
    })
    expect(target.querySelector('.split-jobs')).not.toBeNull()
    expect(target.querySelector('.split-summary')?.textContent).not.toContain('did not answer')
    expect(target.querySelector('.split-not-available')?.textContent).toContain('worker-2')
    expect(target.querySelector('.split-unanswered')).toBeNull()
  })

  it('renders no empty list of marks', () => {
    const target = render({
      view: view({ unanswered: [{ worker: 'worker-2', reason: 'timed out' }] }),
    })
    expect(target.querySelector('.split-marks')).toBeNull()
  })
})

describe('SplitJobsPanel with no worker that has the route', () => {
  it('is hidden after a round where every worker answered 404', () => {
    const target = render({
      view: view({
        results: [],
        unanswered: [
          { worker: 'worker-1', reason: 'not available on this worker' },
          { worker: 'worker-2', reason: 'not available on this worker' },
        ],
        anySplit: false,
      }),
    })
    expect(target.querySelector('.split-jobs')).toBeNull()
  })
})
