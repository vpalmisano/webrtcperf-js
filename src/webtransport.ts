import { log } from './common'
import { averageFromTotal } from './peer-connection-stats'

type WebTransportGetStats = {
  datagrams: {
    droppedIncoming: number
    expiredOutgoing: number
    lostOutgoing: number
  }
  estimatedSendRate: number
  minRtt: number
  rttVariation: number
  smoothedRtt: number
}

type WebTransportData = {
  id: number
  url: string
  connectionDelay: number
  droppedIncoming: number
  expiredOutgoing: number
  lostOutgoing: number
  estimatedSendRate: number
  minRtt: number
  rttVariation: number
  smoothedRtt: number
  sentBytes: number
  sentMessages: number
  sentErrors: number
  recvBytes: number
  recvMessages: number
  recvErrors: number
}

let webtransportCreated = 0

export const webtransports = new Map<number, WebTransportExt>()

export class WebTransportExt extends globalThis.WebTransport {
  readonly __webrtcperf_data: WebTransportData

  constructor(url: string | URL, options?: WebTransportOptions) {
    const id = webtransportCreated++
    const startTime = Date.now()
    super(url, options)

    const data: WebTransportData = (this.__webrtcperf_data = {
      id,
      url: new URL(url).origin,
      connectionDelay: 0,
      droppedIncoming: 0,
      expiredOutgoing: 0,
      lostOutgoing: 0,
      estimatedSendRate: 0,
      minRtt: 0,
      rttVariation: 0,
      smoothedRtt: 0,
      sentBytes: 0,
      sentMessages: 0,
      sentErrors: 0,
      recvBytes: 0,
      recvMessages: 0,
      recvErrors: 0,
    })
    log(`WebTransport-${id} constructor, url: ${url}`, { options })

    let closed = false
    this.ready.then(
      () => {
        if (closed) return
        data.connectionDelay = (Date.now() - startTime) / 1000
        webtransports.set(id, this)
        log(`WebTransport-${id} opened, url: ${url}`)
      },
      (error) => {
        log(`WebTransport-${id} connection error: ${error}`)
      },
    )
    this.closed.finally(() => {
      closed = true
      webtransports.delete(id)
      log(`WebTransport-${id} closed, url: ${url}`)
    })

    const writable = this.datagrams.writable
    if (writable) {
      const getWriter = writable.getWriter.bind(writable)
      writable.getWriter = () => {
        const writer = getWriter()
        const write = writer.write.bind(writer)
        writer.write = async (buf: ArrayBuffer | Uint8Array) => {
          try {
            await write(buf)
            const size = buf instanceof ArrayBuffer ? buf.byteLength : buf.length
            data.sentBytes += size
            data.sentMessages++
          } catch (error) {
            data.sentErrors++
            throw error
          }
        }
        return writer
      }
    }

    const readable = this.datagrams.readable
    const getReader = readable.getReader.bind(readable)
    readable.getReader = () => {
      const reader = getReader()
      const read = reader.read.bind(reader)
      reader.read = async () => {
        try {
          const result = await read()
          if (!result.done) {
            const size = result.value instanceof ArrayBuffer ? result.value.byteLength : result.value.length
            data.recvBytes += size
            data.recvMessages++
          }
          return result
        } catch (error) {
          data.recvErrors++
          throw error
        }
      }
      return reader
    }
  }

  getStats(): Promise<WebTransportGetStats> {
    const baseProto = Object.getPrototypeOf(WebTransport.prototype) as {
      getStats?: (this: WebTransport) => Promise<WebTransportGetStats>
    }
    if (typeof baseProto.getStats !== 'function') {
      return Promise.reject(new Error('WebTransport.getStats() is not available'))
    }
    return baseProto.getStats.call(this)
  }
}

globalThis.WebTransport = WebTransportExt

type WebTransportStats = WebTransportData & {
  sentBitrate?: number
  sentMessageRate?: number
  recvBitrate?: number
  recvMessageRate?: number
  timestamp: number
}

const webtransportStats = new Map<number, WebTransportStats>()

export async function collectWebTransportStats() {
  const now = Date.now() / 1000
  for (const [id, webtransport] of webtransports) {
    const data = webtransport.__webrtcperf_data
    const prevStats = webtransportStats.get(id)
    const stats = {
      ...data,
      sentBitrate: prevStats
        ? averageFromTotal(8 * data.sentBytes, 8 * prevStats.sentBytes, now, prevStats.timestamp)
        : undefined,
      sentMessageRate: prevStats
        ? averageFromTotal(data.sentMessages, prevStats.sentMessages, now, prevStats.timestamp)
        : undefined,
      recvBitrate: prevStats
        ? averageFromTotal(8 * data.recvBytes, 8 * prevStats.recvBytes, now, prevStats.timestamp)
        : undefined,
      recvMessageRate: prevStats
        ? averageFromTotal(data.recvMessages, prevStats.recvMessages, now, prevStats.timestamp)
        : undefined,
      timestamp: now,
    }

    try {
      const { datagrams, estimatedSendRate, minRtt, rttVariation, smoothedRtt } = await webtransport.getStats()
      const { droppedIncoming, expiredOutgoing, lostOutgoing } = datagrams
      Object.assign(stats, {
        droppedIncoming,
        expiredOutgoing,
        lostOutgoing,
        estimatedSendRate,
        minRtt,
        rttVariation,
        smoothedRtt,
      })
    } catch (error) {
      log(`WebTransport-${id} getStats() error: ${error}`)
    }

    webtransportStats.set(id, stats)
  }
  return [...webtransportStats.values()]
}
