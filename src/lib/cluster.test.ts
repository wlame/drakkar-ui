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

  it('excludes offline peers so no WebSocket targets a dead worker', () => {
    const peers = sameClusterPeers([
      worker({ worker_name: 'worker-b', is_current: true }),
      worker({ worker_name: 'worker-a', online: true }),
      worker({ worker_name: 'worker-c', online: false, last_seen_ts: 123 }),
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
