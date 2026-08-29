// The sinks table's docs affordance: a book icon next to the name of a sink
// the operator declared a docs anchor for (contract v1.22). Every other sink
// renders exactly as before.
import { afterEach, describe, expect, it } from 'vitest'
import { flushSync, mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import SinksTable from './SinksTable.svelte'
import { openDocsAnchor, setDocsConfig } from '../../lib/docsAnchors'
import type { SinkStatus } from '../../lib/types'

function sink(name: string): SinkStatus {
  return {
    sink_type: 'postgres',
    name,
    ui_url: '',
    delivered_count: 12,
    delivered_payloads: 34,
    error_count: 0,
    retry_count: 0,
    last_delivery_ts: null,
    last_delivery_duration: null,
    last_error: null,
    last_error_ts: null,
  }
}

const rows = [sink('analytics_postgres_sink'), sink('audit_trail_kafka_sink')]

const mounted: { target: HTMLElement; component: Record<string, unknown> }[] = []

function renderTracked() {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const component = mount(SinksTable, { target, props: { rows } })
  mounted.push({ target, component })
  flushSync()
  return target
}

afterEach(() => {
  for (const { target, component } of mounted.splice(0)) {
    unmount(component)
    target.remove()
  }
  setDocsConfig(null)
  openDocsAnchor.set(null)
})

describe('SinksTable docs anchors', () => {
  it('renders no docs icon without a docs config', () => {
    const target = renderTracked()
    expect(target.querySelectorAll('.docs-icon')).toHaveLength(0)
  })

  it('renders the icon only in the row of the anchored sink', () => {
    setDocsConfig({
      title: 'Operator handbook',
      anchors: [
        {
          match: { sink: 'analytics_postgres_sink' },
          path: 'sinks/postgres.html',
          title: 'Postgres sink',
        },
      ],
    })
    const target = renderTracked()
    const icons = target.querySelectorAll('.docs-icon')
    expect(icons).toHaveLength(1)
    const row = icons[0].closest('tr') as HTMLTableRowElement
    expect(row.textContent).toContain('analytics_postgres_sink')
    expect(icons[0].getAttribute('aria-label')).toBe('Postgres sink')
  })

  it('opens the drawer store with the matched anchor when clicked', () => {
    const anchor = { match: { sink: 'analytics_postgres_sink' }, path: 'sinks/postgres.html' }
    setDocsConfig({ title: 'Operator handbook', anchors: [anchor] })
    const target = renderTracked()
    ;(target.querySelector('.docs-icon') as HTMLButtonElement).click()
    flushSync()
    expect(get(openDocsAnchor)).toEqual(anchor)
  })
})
