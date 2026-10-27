import { describe, it, expect } from 'vitest'
import { peerBaseUrl, sameClusterPeers } from './cluster'
import type { WorkerPeer } from './types'

function worker(over: Partial<WorkerPeer>): WorkerPeer {
  return {
    worker_name: 'worker-a',
    cluster: 'analytics-prod',
    url: 'http://worker-a:8080/',
    is_current: false,
    ip_address: null,
    debug_port: null,
    debug_url: null,
    ...over,
  }
}

describe('sameClusterPeers', () => {
  it('returns the non-current workers of the current cluster, sorted by name', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-c' }),
      worker({ worker_name: 'worker-a' }),
      worker({ worker_name: 'other', cluster: 'analytics-staging' }),
    ])
    expect(peers.map((w) => w.worker_name)).toEqual(['worker-a', 'worker-c'])
  })

  it('returns [] when no worker is marked current', () => {
    expect(sameClusterPeers([worker({}), worker({ worker_name: 'worker-b' })])).toEqual([])
  })

  it('leaves out a worker with ui_enabled false and keeps null or absent', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-a', ui_enabled: false }),
      worker({ worker_name: 'worker-c', ui_enabled: null }),
      worker({ worker_name: 'worker-d', ui_enabled: true }),
      worker({ worker_name: 'worker-e' }),
    ])
    expect(peers.map((w) => w.worker_name)).toEqual(['worker-c', 'worker-d', 'worker-e'])
  })

  it('excludes offline peers so no WebSocket targets a dead worker', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-a', online: true }),
      worker({ worker_name: 'worker-c', online: false, last_seen_ts: 123 }),
    ])
    expect(peers.map((w) => w.worker_name)).toEqual(['worker-a'])
  })

  it('keeps peers whose liveness is unknown (v1.23 online=null)', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-a', online: null }),
    ])
    expect(peers.map((w) => w.worker_name)).toEqual(['worker-a'])
  })

  it('keeps peers without the v1.18 online field (pre-v1.18 backend)', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-a' }),
    ])
    expect(peers.map((w) => w.worker_name)).toEqual(['worker-a'])
  })
})

describe('peerBaseUrl', () => {
  it('prefers the advertised URL, stripping trailing slashes', () => {
    expect(peerBaseUrl(worker({ url: 'http://worker-a:8080/' }))).toBe('http://worker-a:8080')
  })

  it('falls back to ip:debug_port when no URL is advertised', () => {
    expect(peerBaseUrl(worker({ url: '', ip_address: '10.0.0.5', debug_port: 8081 }))).toBe(
      'http://10.0.0.5:8081',
    )
  })

  it('returns an empty string when the peer advertised nothing reachable', () => {
    expect(peerBaseUrl(worker({ url: '' }))).toBe('')
  })
})

describe('peerBaseUrl scheme check', () => {
  const peer = (url: string) =>
    ({
      worker_name: 'w',
      cluster: 'c',
      url,
      is_current: false,
      ip_address: null,
      debug_port: null,
    }) as WorkerPeer

  it.each([
    ['a javascript: url', 'javascript:alert(1)//'],
    ['a data: url', 'data:text/html,<script>1</script>'],
    ['a relative value', '/other/path'],
    ['a scheme-less host', 'w-2:8080'],
  ])('refuses %s', (_name, url) => {
    expect(peerBaseUrl(peer(url))).toBe('')
  })

  it('accepts http and https and drops trailing slashes', () => {
    expect(peerBaseUrl(peer('http://w-2:8080/'))).toBe('http://w-2:8080')
    expect(peerBaseUrl(peer('https://w-2.example/'))).toBe('https://w-2.example')
  })
})
