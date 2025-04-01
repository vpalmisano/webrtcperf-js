import { MeasuredStats } from './stats'

export const httpBitrateStats = new MeasuredStats({ ttl: 30 })
export const httpLatencyStats = new MeasuredStats({ ttl: 30 })
export const httpResourcesStats = {
  recvBytes: 0,
  recvBitrate: 0,
  recvLatency: 0,
}

export function collectHttpResourcesStats() {
  httpResourcesStats.recvBitrate = httpBitrateStats.mean() || 0
  httpResourcesStats.recvLatency = httpLatencyStats.mean() || 0
  return httpResourcesStats
}

if (typeof window.PerformanceObserver === 'function') {
  // https://nicj.net/resourcetiming-in-practice/
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const processEntries = (entries: any[]) => {
    const timestamp = Date.now()
    entries
      .filter((entry) => {
        const { duration, transferSize } = entry
        // Filter cached entries.
        if (!transferSize || duration < 10) {
          return false
        }
        httpResourcesStats.recvBytes += transferSize
        return true
      })
      .forEach((entry) => {
        const { duration, transferSize } = entry
        httpBitrateStats.push(timestamp, Math.round((8000 * transferSize) / duration))
        httpLatencyStats.push(timestamp, duration / 1000)
      })
  }
  const observer = new PerformanceObserver((list) => processEntries(list.getEntries()))
  observer.observe({ entryTypes: ['resource', 'navigation'], buffered: true })
}
