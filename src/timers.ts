export class Timer {
  duration: number
  lastTime: number
  timer: NodeJS.Timeout | null
  startEvents: number
  stopEvents: number

  constructor() {
    this.duration = 0
    this.lastTime = 0
    this.timer = null
    this.startEvents = 0
    this.stopEvents = 0
  }

  start() {
    if (this.timer) return
    this.lastTime = Date.now()
    this.startEvents++
    this.timer = setInterval(() => {
      const now = Date.now()
      this.duration += (now - this.lastTime) / 1000
      this.lastTime = now
    }, 1000)
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
    if (this.lastTime) {
      this.duration += (Date.now() - this.lastTime) / 1000
      this.lastTime = 0
    }
    this.stopEvents++
  }
}

export class OnOffTimer {
  onTimer: Timer
  offTimer: Timer
  ids: Set<string>

  constructor() {
    this.onTimer = new Timer()
    this.offTimer = new Timer()
    this.ids = new Set()
  }

  get onDuration() {
    return this.onTimer.duration
  }

  get offDuration() {
    return this.offTimer.duration
  }

  add(id: string) {
    if (this.ids.has(id)) return
    this.ids.add(id)
    this.offTimer.stop()
    this.onTimer.start()
  }

  remove(id: string) {
    if (!this.ids.has(id)) return
    this.ids.delete(id)
    if (this.ids.size > 0) return
    this.onTimer.stop()
    this.offTimer.start()
  }
}
