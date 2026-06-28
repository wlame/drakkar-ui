import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { api, wsUrl, downloadUrl } from './api'

// Hermetic: fetch is a stub (no network), localStorage comes from happy-dom.
const fetchMock = vi.fn()

function okJson(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response
}

function httpError(status: number, body: string) {
  return {
    ok: false,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as unknown as Response
}

// [url, init] of the n-th fetch call.
function call(n = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit]
  return { url, init }
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(okJson({}))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('query-string building', () => {
  it('omits the "?" entirely when there are no params', async () => {
    await api.events()
    expect(call().url).toBe('/api/v1/events')
  })

  it('drops nullish and empty params but keeps zero', async () => {
    await api.events({ partitions: '1,2', origin: '', after_id: 0, limit: 50 })
    expect(call().url).toBe('/api/v1/events?partitions=1%2C2&after_id=0&limit=50')
  })

  it('applies documented defaults', async () => {
    await api.recentTasks()
    expect(call().url).toBe('/api/v1/recent-tasks?minutes=2')
  })

  it('URL-encodes path parameters', async () => {
    await api.task('job/7 x')
    expect(call().url).toBe('/api/v1/task/job%2F7%20x')
  })
})

describe('auth header injection', () => {
  it('sends no Authorization header when no token is configured', async () => {
    await api.dashboard()
    expect(call().init.headers).toEqual({})
  })

  it('sends a Bearer header from the stored token', async () => {
    localStorage.setItem('drakkar_token', 'stored-tok')
    await api.dashboard()
    expect(call().init.headers).toEqual({ Authorization: 'Bearer stored-tok' })
  })

  it('prefers a ?token= from the URL and remembers it for later requests', async () => {
    localStorage.setItem('drakkar_token', 'old-tok')
    window.history.replaceState({}, '', '/?token=url-tok')
    await api.dashboard()
    expect(call().init.headers).toEqual({ Authorization: 'Bearer url-tok' })
    expect(localStorage.getItem('drakkar_token')).toBe('url-tok')

    // Deep link consumed: back on a token-less URL, the remembered token rides on.
    window.history.replaceState({}, '', '/')
    await api.dashboard()
    expect(call(1).init.headers).toEqual({ Authorization: 'Bearer url-tok' })
  })

  it('POSTs JSON with the auth header alongside Content-Type', async () => {
    localStorage.setItem('drakkar_token', 'tok')
    await api.arrangeTasks(['a', 'b'])
    const { url, init } = call()
    expect(url).toBe('/api/v1/live/arrange-tasks')
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tok',
    })
    expect(init.body).toBe('{"task_ids":["a","b"]}')
  })
})

describe('error surfacing', () => {
  it('includes method, path, status and the body text', async () => {
    fetchMock.mockResolvedValue(httpError(404, '{"error":"no such task"}'))
    await expect(api.task('x')).rejects.toThrow('GET /task/x → HTTP 404: {"error":"no such task"}')
  })

  it('omits the body suffix when the body is unreadable', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => {
        throw new Error('gone')
      },
    } as unknown as Response)
    await expect(api.dashboard()).rejects.toThrow('GET /dashboard → HTTP 500')
  })
})

describe('wsUrl', () => {
  it('builds a ws:// URL on the current host without a token', () => {
    expect(wsUrl()).toBe(`ws://${window.location.host}/ws`)
  })

  it('appends the token as an encoded query param (WS cannot set headers)', () => {
    localStorage.setItem('drakkar_token', 'a b/c')
    expect(wsUrl('/ws')).toBe(`ws://${window.location.host}/ws?token=a%20b%2Fc`)
  })
})

describe('downloadUrl', () => {
  it('is a plain /api/v1 path without a token', () => {
    expect(downloadUrl('/debug/download/w1.db')).toBe('/api/v1/debug/download/w1.db')
  })

  it('appends the token as a query param (an <a> navigation cannot set headers)', () => {
    localStorage.setItem('drakkar_token', 't&k')
    expect(downloadUrl('/debug/download/w1.db')).toBe('/api/v1/debug/download/w1.db?token=t%26k')
  })

  it('encodes filenames in the debug download helper', () => {
    expect(api.debugDownloadUrl('a b.db')).toBe('/api/v1/debug/download/a%20b.db')
  })
})
