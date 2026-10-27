import { log } from './common'
import { averageFromTotal } from './peer-connection-stats'
import { MeasuredStats } from './stats'

let websocketCreated = 0

function getSize(data: string | Blob | BufferSource): number {
  if (typeof data === 'string') return data.length
  if (data instanceof Blob) return data.size
  return data.byteLength
}

const websocketConnectionDelayStats = new MeasuredStats({ ttl: 30 })

type WebSocketData = {
  id: number
  startTime: number
  connectionDelay: number
  sentBytes: number
  sentMessages: number
  recvBytes: number
  recvMessages: number
  errors: number
}

class WebSocketExt extends WebSocket {
  readonly __webrtcperf_data: WebSocketData

  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols)
    const id = websocketCreated++
    log(`WebSocket-${id} constructor, url: ${url}`)
    const data = (this.__webrtcperf_data = {
      id,
      startTime: Date.now(),
      connectionDelay: 0,
      sentBytes: 0,
      sentMessages: 0,
      recvBytes: 0,
      recvMessages: 0,
      errors: 0,
    })
    websockets.set(id, this)
    this.addEventListener(
      'open',
      () => {
        log(`WebSocket-${id} opened, url: ${this.url}`)
        const now = Date.now()
        data.connectionDelay = (now - data.startTime) / 1000
        websocketConnectionDelayStats.push(now, data.connectionDelay)
      },
      { once: true },
    )
    this.addEventListener('message', (event) => {
      const size = getSize(event.data)
      data.recvBytes += size
      data.recvMessages++
    })
    this.addEventListener('error', (event) => {
      log(`WebSocket-${id} error: ${event instanceof ErrorEvent ? event.message : event}`)
      data.errors++
    })
    this.addEventListener(
      'close',
      (event) => {
        log(`WebSocket-${id} closed, code: ${event.code}, reason: ${event.reason}`)
        websockets.delete(id)
      },
      { once: true },
    )
  }

  send(message: string | Blob | BufferSource) {
    super.send(message)
    const size = getSize(message)
    const data = this.__webrtcperf_data
    data.sentBytes += size
    data.sentMessages++
  }

  close(code?: number, reason?: string) {
    super.close(code, reason)
    log(`WebSocket-${this.__webrtcperf_data.id} close, code: ${code}, reason: ${reason}`)
    websockets.delete(this.__webrtcperf_data.id)
  }
}

window.WebSocket = WebSocketExt

export const websockets = new Map<number, WebSocketExt>()

type WebSocketStats = WebSocketData & {
  url: string
  sentBitrate?: number
  sentMessageRate?: number
  lastSentTime: number
  recvBitrate?: number
  recvMessageRate?: number
  lastRecvTime: number
}

const websocketStats = new Map<number, WebSocketStats>()

export function collectWebSocketStats() {
  const now = Date.now() / 1000
  const inactive = new Set(websocketStats.keys())
  for (const [id, websocket] of websockets) {
    const readyState = websocket.readyState
    if (readyState !== WebSocket.OPEN) {
      continue
    }
    const data = websocket.__webrtcperf_data
    const prevStats = websocketStats.get(id)
    const stats = {
      url: new URL(websocket.url).origin,
      ...data,
      sentBitrate: prevStats
        ? averageFromTotal(8 * data.sentBytes, 8 * prevStats.sentBytes, now, prevStats.lastSentTime)
        : undefined,
      sentMessageRate: prevStats
        ? averageFromTotal(data.sentMessages, prevStats.sentMessages, now, prevStats.lastSentTime)
        : undefined,
      lastSentTime: now,
      recvBitrate: prevStats
        ? averageFromTotal(8 * data.recvBytes, 8 * prevStats.recvBytes, now, prevStats.lastSentTime)
        : undefined,
      recvMessageRate: prevStats
        ? averageFromTotal(data.recvMessages, prevStats.recvMessages, now, prevStats.lastSentTime)
        : undefined,
      lastRecvTime: now,
    }
    websocketStats.set(id, stats)
    inactive.delete(id)
  }
  inactive.forEach((id) => websocketStats.delete(id))
  return [...websocketStats.values()]
}
