// Live WebSocket client for the /ws recorder-event stream. The server sends ONE
// event JSON object per text frame (batching is server-side and invisible on the
// wire), so the client just parses each frame and dispatches it. Reconnect is a
// fixed 3s retry with no backoff, matching the reference; on reconnect the page
// does a full DB resync to reconcile events missed during the gap.
//
// Auth/origin failures (close codes 4401/4403) are surfaced as distinct statuses
// and NOT retried — reconnecting with a bad token would loop forever.

import { wsUrl } from './api'
import type { WsEvent } from './types'

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized' | 'forbidden'

const RECONNECT_MS = 3000

export interface LiveSocketOptions {
  onEvent: (e: WsEvent) => void
  onStatus: (s: WsStatus) => void
  onOpen?: () => void
}

export interface LiveSocket {
  close: () => void
  setFrozen: (frozen: boolean) => void
}

export function createLiveSocket(opts: LiveSocketOptions): LiveSocket {
  let ws: WebSocket | null = null
  let frozen = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function connect() {
    opts.onStatus('connecting')
    try {
      ws = new WebSocket(wsUrl('/ws'))
    } catch {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      opts.onStatus('connected')
      opts.onOpen?.()
    }
    ws.onmessage = (msg) => {
      if (frozen) return
      let e: WsEvent
      try {
        e = JSON.parse(msg.data) as WsEvent
      } catch {
        return // ignore malformed frames
      }
      opts.onEvent(e)
    }
    ws.onclose = (ev) => {
      if (closed) return
      if (ev.code === 4401) {
        opts.onStatus('unauthorized')
        return
      }
      if (ev.code === 4403) {
        opts.onStatus('forbidden')
        return
      }
      opts.onStatus('disconnected')
      scheduleReconnect()
    }
  }

  function scheduleReconnect() {
    if (closed) return
    timer = setTimeout(connect, RECONNECT_MS)
  }

  connect()

  return {
    close() {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    },
    setFrozen(f: boolean) {
      frozen = f
    },
  }
}
