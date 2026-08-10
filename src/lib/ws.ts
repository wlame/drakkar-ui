// Live WebSocket client for the /ws recorder-event stream.
//
// Wire format: one frame carries a BATCH of events plus a drop count —
// `{"dropped": N, "events": [...]}`. The server drains whatever is queued into
// a single frame rather than sending one frame per event, which matters on a
// high-fan-out worker where a message can produce a thousand tasks: per-event
// framing cost a header, a syscall and a separate parse + reactive update each.
//
// `dropped` is non-zero when this client fell behind and the server discarded
// events for it. That used to be silent, and it is why live counts could
// disagree with the database with no visible cause — the page now resyncs
// instead of drifting.
//
// Subscription filter: the page declares which event types it renders, so the
// server never encodes, queues or sends the rest.
//
// Reconnect is a fixed 3s retry with no backoff; on reconnect the page does a
// full DB resync to reconcile events missed during the gap. Auth/origin
// failures (close codes 4401/4403) are surfaced as distinct statuses and NOT
// retried — reconnecting with a bad token would loop forever.

import { wsUrl, wsUrlFor } from './api'
import type { WsEvent } from './types'

export type WsStatus = 'connecting' | 'connected' | 'disconnected' | 'unauthorized' | 'forbidden'

/** Operator-facing wording for each status, shared by every WS badge. */
export const WS_STATUS_LABELS: Record<WsStatus, string> = {
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden origin',
}

const RECONNECT_MS = 3000

interface WsFrame {
  dropped?: number
  events?: WsEvent[]
}

export interface LiveSocketOptions {
  onEvent: (e: WsEvent) => void
  onStatus: (s: WsStatus) => void
  onOpen?: () => void
  /**
   * Called when the server reports it dropped events for this client. The page
   * should resync from the database — its in-memory state has a hole in it.
   */
  onGap?: (dropped: number) => void
  /** Event types this page renders. Omit to receive everything. */
  eventTypes?: string[]
  /**
   * http(s) origin of the worker to connect to. Omit for the page's own
   * worker (the normal case); cluster view sets it to reach each peer's /ws.
   */
  baseUrl?: string
}

export interface LiveSocket {
  close: () => void
  /** Operator-driven pause (the Live/Frozen button and the Space bar). */
  setFrozen: (frozen: boolean) => void
  /**
   * Suspend delivery because nobody is looking at the tab.
   *
   * Deliberately separate from `setFrozen`: the operator did not pause
   * anything, so the button must keep reading "Live". Both flags gate the
   * same handler, and neither one clears the other.
   *
   * The check happens before JSON.parse, so a suspended page pays nothing
   * per frame. The caller resyncs from the database on resume, which is what
   * closes the resulting gap in state.
   */
  setSuspended: (suspended: boolean) => void
}

export function createLiveSocket(opts: LiveSocketOptions): LiveSocket {
  let ws: WebSocket | null = null
  let frozen = false
  let suspended = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function connect() {
    opts.onStatus('connecting')
    try {
      const path = opts.eventTypes?.length
        ? `/ws?events=${encodeURIComponent(opts.eventTypes.join(','))}`
        : '/ws'
      ws = new WebSocket(opts.baseUrl ? wsUrlFor(opts.baseUrl, path) : wsUrl(path))
    } catch {
      scheduleReconnect()
      return
    }
    ws.onopen = () => {
      opts.onStatus('connected')
      opts.onOpen?.()
    }
    ws.onmessage = (msg) => {
      // Both checks precede JSON.parse: on a fan-out workload a frame can
      // carry a hundred events, and parsing one only to discard it is the
      // single largest avoidable cost in a hidden tab.
      if (frozen || suspended) return
      let frame: WsFrame
      try {
        frame = JSON.parse(msg.data) as WsFrame
      } catch {
        return // ignore malformed frames
      }
      // Report the gap BEFORE dispatching this frame's events: the resync it
      // triggers should account for the events in this frame too.
      if (frame.dropped) opts.onGap?.(frame.dropped)
      if (!frame.events) return
      for (const e of frame.events) opts.onEvent(e)
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
    setSuspended(s: boolean) {
      suspended = s
    },
  }
}
