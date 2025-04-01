import { log } from './common'

export class MeasuredStats {
  ttl: number
  secondsPerSample: number
  storeId: string
  maxItems: number
  stats: { timestamp: number; value: number; count: number }[]
  statsSum: number
  statsCount: number
  statsMin: number | undefined
  statsMax: number | undefined

  constructor({ ttl = 0, maxItems = 0, secondsPerSample = 1, storeId = '' }) {
    this.ttl = ttl
    this.secondsPerSample = secondsPerSample
    this.storeId = storeId
    this.maxItems = maxItems
    this.stats = []
    this.statsSum = 0
    this.statsCount = 0
    this.statsMin = undefined
    this.statsMax = undefined
    // Restore from localStorage.
    this.load()
  }

  store() {
    if (!this.storeId) {
      return
    }
    try {
      localStorage.setItem(
        `webrtcperf-MeasuredStats-${this.storeId}`,
        JSON.stringify({
          stats: this.stats,
          statsSum: this.statsSum,
          statsCount: this.statsCount,
          statsMin: this.statsMin,
          statsMax: this.statsMax,
        }),
      )
    } catch (err) {
      log(`MeasuredStats store error: ${(err as Error).message}`)
    }
  }

  load() {
    if (!this.storeId) {
      return
    }
    try {
      const data = localStorage.getItem(`webrtcperf-MeasuredStats-${this.storeId}`)
      if (data) {
        const { stats, statsSum, statsCount, statsMin, statsMax } = JSON.parse(data)
        this.stats = stats
        this.statsSum = statsSum
        this.statsCount = statsCount
        this.statsMin = statsMin
        this.statsMax = statsMax
      }
    } catch (err) {
      log(`MeasuredStats load error: ${(err as Error).message}`)
    }
  }

  clear() {
    this.stats = []
    this.statsSum = 0
    this.statsCount = 0
    this.statsMin = undefined
    this.statsMax = undefined
    this.store()
  }

  purge() {
    let changed = false
    if (this.ttl > 0) {
      const now = Date.now()
      let removeToIndex = -1
      for (const [index, { timestamp }] of this.stats.entries()) {
        if (now - timestamp > this.ttl * 1000) {
          removeToIndex = index
        } else {
          break
        }
      }
      if (removeToIndex >= 0) {
        for (const { value, count } of this.stats.splice(0, removeToIndex + 1)) {
          this.statsSum -= value
          this.statsCount -= count
        }
        changed = true
      }
    }
    if (this.maxItems && this.stats.length > this.maxItems) {
      for (const { value, count } of this.stats.splice(0, this.stats.length - this.maxItems)) {
        this.statsSum -= value
        this.statsCount -= count
      }
      changed = true
    }
    if (changed) {
      this.store()
    }
  }

  /**
   * push
   * @param {number} timestamp
   * @param {number} value
   */
  push(timestamp: number, value: number) {
    if (timestamp === undefined || value === undefined || isNaN(timestamp) || isNaN(value)) {
      log(`MeasuredStats.push invalid value: timestamp=${timestamp} value=${value}`)
      return
    }
    const last = this.stats[this.stats.length - 1]
    if (last && timestamp - last.timestamp < this.secondsPerSample * 1000) {
      last.value += value
      last.count += 1
    } else {
      this.stats.push({ timestamp, value, count: 1 })
    }
    this.statsSum += value
    this.statsCount += 1
    if (this.statsMin === undefined || value < this.statsMin) this.statsMin = value
    if (this.statsMax === undefined || value > this.statsMax) this.statsMax = value
    this.purge()
  }

  /**
   * mean
   * @returns {number | undefined} The mean value.
   */
  mean() {
    this.purge()
    return this.statsCount ? this.statsSum / this.statsCount : undefined
  }

  get size() {
    return this.statsCount
  }

  get min() {
    return this.statsMin
  }

  get max() {
    return this.statsMax
  }
}
