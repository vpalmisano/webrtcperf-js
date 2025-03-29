declare global {
  interface Window {
    serializedConsoleLog: (method: string, msg: string) => void
  }
}

type Action = {
  name: string
  at: number
  every: number
  times: number
  index: number
  params: unknown[]
  relaxedAt: number
}

const startTime = performance.now()

export const webrtcperf = {
  WEBRTC_PERF_INDEX: 0,
  LOCAL_STORAGE: '',
  params: {
    actions: [] as Action[],
  },
  elapsedTime: () => performance.now() - startTime,
}

if ('webrtcperf' in window) {
  Object.assign(webrtcperf, window.webrtcperf)
  overrideLocalStorage()
}

if (window.serializedConsoleLog) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function safeStringify(obj: any) {
    const values = new Set()
    try {
      const ret = JSON.stringify(obj, (_, v) => {
        if (v instanceof Error) return `Error: ${v.stack}`
        if (typeof v !== 'object' || v === null || v === undefined) return v
        if (values.has(v)) return
        values.add(v)
        return v
      })
      if (ret === '{}') {
        return obj.toString()
      }
      return ret
    } catch {
      return obj.toString()
    } finally {
      values.clear()
    }
  }

  ;['error', 'warn', 'info', 'log', 'debug'].forEach((method) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nativeFn = (console as any)[method].bind(console)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(console as any)[method] = function (...args: unknown[]) {
      const msg = args
        .map((arg) => {
          if (arg instanceof Error) {
            return `Error: ${arg.stack}`
          } else if (typeof arg === 'object') {
            return safeStringify(arg)
          } else if (typeof arg === 'string') {
            if (arg.match(/^color: /)) {
              return ''
            }
            return arg.replace(/%c/g, '')
          }
          return arg !== undefined ? arg.toString() : 'undefined'
        })
        .filter((arg) => arg.length > 0)
        .join(' ')
      
      void window.serializedConsoleLog(method, msg)
      return nativeFn(...args)
    }
  })
}

/**
 * Logging utility.
 */
export function log(...args: unknown[]) {
  console.log.apply(null, [`[webrtcperf-${webrtcperf.WEBRTC_PERF_INDEX}]`, ...args])
}

/**
 * Sleep utility.
 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Get the name of the webrtcperf participant.
 */
export function getParticipantName(index = webrtcperf.WEBRTC_PERF_INDEX || 0) {
  return `Participant-${index.toString().padStart(6, '0')}`
}

export function getParticipantNameForSave(sendrecv: string, track: MediaStreamTrack) {
  return `${getParticipantName()}_${sendrecv}_${track.id}`
}

/**
 * Returns the name of the sender participant for a given track.
 */
export function getReceiverParticipantName(track: MediaStreamTrack) {
  return track.id
}

/**
 * getElement
 * @param {string} selector
 * @param {number} timeout
 * @param {boolean} throwError
 * @return {Promise<HTMLElement>}
 */
export async function getElement(selector: string, timeout = 60000, throwError = false) {
  let element = document.querySelector(selector)
  if (timeout) {
    const startTime = Date.now()
    while (!element && Date.now() - startTime < timeout) {
      await sleep(Math.max(timeout / 2, 200))
      element = document.querySelector(selector)
    }
  }
  if (!element && throwError) {
    throw new Error(`Timeout getting "${selector}"`)
  }
  return element
}

/**
 * getElements
 * @param {string} selector
 * @param {number} timeout
 * @param {boolean} throwError
 * @param {string} innerText
 * @return {Promise<HTMLElement[]>}
 */
export async function getElements(selector: string, timeout = 60000, throwError = false, innerText = '') {
  let elements = document.querySelectorAll(selector)
  if (timeout) {
    const startTime = Date.now()
    while (!elements.length && Date.now() - startTime < timeout) {
      await sleep(Math.min(timeout / 2, 1000))
      elements = document.querySelectorAll(selector)
    }
  }
  if (!elements.length && throwError) {
    throw new Error(`Timeout getting "${selector}"`)
  }
  if (innerText) {
    return [...elements].filter((e) =>
      (e as HTMLElement).innerText.trim().toLowerCase().includes(innerText.trim().toLowerCase()),
    )
  } else {
    return [...elements]
  }
}

export async function clickOn(selector: string, timeout = 0, text = '') {
  let el = null
  if (text) {
    el = (await getElements(selector, timeout, false, text))[0]
  } else {
    el = await getElement(selector, timeout)
  }
  if (!el) {
    return undefined
  }
  ;(el as HTMLElement).click()
  return el
}

export function simulateMouseClick(element: HTMLElement) {
  ;['mousedown', 'click', 'mouseup'].forEach((event) =>
    element.dispatchEvent(
      new MouseEvent(event, {
        view: window,
        bubbles: true,
        cancelable: true,
        buttons: 1,
      }),
    ),
  )
}

/**
 * overrideLocalStorage
 */
export function overrideLocalStorage() {
  if (!webrtcperf.LOCAL_STORAGE) {
    return
  }
  try {
    const values = JSON.parse(webrtcperf.LOCAL_STORAGE)
    Object.entries(values).map(([key, value]) => localStorage.setItem(key, value as string))
  } catch (err) {
    log(`overrideLocalStorage error: ${(err as Error).message}`)
  }
}

export function injectCss(css: string, id = 'custom') {
  id = `webrtcperf-css-${id}`
  let style = document.getElementById(id)
  if (!style) {
    style = document.createElement('style')
    style.setAttribute('id', id)
    style.setAttribute('type', 'text/css')
    document.head.appendChild(style)
  }
  style.innerHTML = css
  return style
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watchObjectProperty(object: any, name: string, cb: (newValue: unknown, oldValue: unknown) => void) {
  let value = object[name]
  Object.defineProperty(object, name, {
    get: function () {
      return value
    },
    set: function (newValue) {
      cb(newValue, value)
      value = newValue
    },
  })
}

export function loadScript(name: string, src = '', textContent = '') {
  return new Promise((resolve, reject) => {
    let script = document.getElementById(name)
    if (script) {
      resolve(script)
      return
    }
    script = document.createElement('script')
    script.setAttribute('id', name)
    if (src) {
      script.setAttribute('src', src)
      script.setAttribute('referrerpolicy', 'no-referrer')
      script.addEventListener('load', () => script && resolve(script), false)
      script.addEventListener('error', (err) => reject(err), false)
    } else if (textContent) {
      script.textContent = textContent
    } else {
      reject(new Error('src or textContent must be provided'))
    }
    document.head.appendChild(script)
    if (textContent) {
      resolve(script)
    }
  })
}

export function harmonicMean(array: number[]) {
  return array.length
    ? 1 /
        (array.reduce((sum, b) => {
          sum += 1 / b
          return sum
        }, 0) /
          array.length)
    : 0
}

export function unregisterServiceWorkers() {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister()
    }
  })
}

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

/**
 * Check if the current session is included into the value setting configuration.
 * @param {number | string | boolean} value A session ID number, a range of numbers separated by a dash, a comma separated list of numbers or a boolean.
 */
export function enabledForSession(value: number | string | boolean) {
  if (value === true || value === 'true') {
    return true
  } else if (value === false || value === 'false' || value === undefined) {
    return false
  } else if (typeof value === 'string') {
    if (value.indexOf('-') !== -1) {
      const [start, end] = value.split('-').map((s) => parseInt(s))
      if (isFinite(start) && webrtcperf.WEBRTC_PERF_INDEX < start) {
        return false
      }
      if (isFinite(end) && webrtcperf.WEBRTC_PERF_INDEX > end) {
        return false
      }
      return true
    } else {
      const indexes = value
        .split(',')
        .filter((s) => s.length)
        .map((s) => parseInt(s))
      return indexes.includes(webrtcperf.WEBRTC_PERF_INDEX)
    }
  } else if (webrtcperf.WEBRTC_PERF_INDEX === value) {
    return true
  }
  return false
}

// Common page actions
let actionsStarted = false

export async function setupActions() {
  if (!webrtcperf.params.actions || actionsStarted) {
    return
  }
  actionsStarted = true

  const actions = webrtcperf.params.actions
  actions
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .forEach((action) => {
      const { name, at, relaxedAt, every, times, index, params } = action
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (window as any)[name] || (webrtcperf as any)[name]
      if (!fn) {
        log(`setupActions undefined action: "${name}"`)
        return
      }

      if (index !== undefined) {
        if (!enabledForSession(index)) {
          return
        }
      }

      const setupTime = webrtcperf.elapsedTime()
      let startTime = at > 0 ? at * 1000 - setupTime : 0
      if (startTime < 0) {
        if (relaxedAt) {
          log(
            `setupActions action "${name}" already passed (setupTime: ${setupTime / 1000} at: ${at}), running immediately`,
          )
          startTime = 0
        } else {
          log(`setupActions action "${name}" already passed (setupTime: ${setupTime / 1000} at: ${at})`)
          if (every > 0) {
            startTime = Math.ceil(-startTime / (every * 1000)) * every * 1000 + startTime
          } else {
            return
          }
        }
      }
      log(
        `scheduling action ${name}(${params || ''}) at ${at}s${every ? ` every ${every}s` : ''}${
          times ? ` ${times} times` : ''
        } with startTime: ${startTime}ms setupTime: ${setupTime}ms`,
      )
      let currentIteration = 0
      const cb = async () => {
        const now = webrtcperf.elapsedTime()
        const ts = (now / 1000).toFixed(0)
        log(
          `run action [${ts}s] ${name}(${params || ''})${every ? ` every ${every}s` : ''}${
            times ? ` (${times - currentIteration}/${times} times remaining)` : ''
          } (system time: ${Date.now()})`,
        )
        try {
          if (params && params.length) {
            await fn(...params)
          } else {
            await fn()
          }
          const elapsed = ((webrtcperf.elapsedTime() - now) / 1000).toFixed(3)
          log(`run action [${ts}s] [${webrtcperf.WEBRTC_PERF_INDEX}] ${name} done (${elapsed}s elapsed)`)
        } catch (err) {
          log(`run action [${ts}s] [${webrtcperf.WEBRTC_PERF_INDEX}] ${name} error: ${(err as Error).message}`)
        } finally {
          currentIteration += 1
          if (every > 0 && currentIteration < (times || Infinity)) {
            setTimeout(cb, every * 1000)
          }
        }
      }

      setTimeout(cb, startTime)
    })
}

export function stringToBinary(str: string) {
  return str.split('').reduce((prev, cur, index) => prev + (cur.charCodeAt(0) << (8 * index)), 0)
}

export function createWorker(fn: () => void) {
  const blob = new Blob(
    [
      fn
        .toString()
        .replace(/^[^{]*{\s*/, '')
        .replace(/\s*}[^}]*$/, ''),
    ],
    {
      type: 'text/javascript',
    },
  )
  const url = URL.createObjectURL(blob)
  return new Worker(url)
}

/**
 * It waits until the time is reached.
 * @param {number} waitUtilTime The time in seconds to wait from the start of the test.
 * @param {number} waitUtilTimeRate An additional time to wait calcualted as `participant_index / waitUtilTime
 */
export async function waitUtilTime(waitUtilTime: number, waitUtilTimeRate = 0) {
  if (!waitUtilTime) return
  const participantWaitTime = waitUtilTimeRate > 0 ? webrtcperf.WEBRTC_PERF_INDEX / waitUtilTimeRate : 0
  const t = waitUtilTime * 1000 + participantWaitTime * 1000 - webrtcperf.elapsedTime()
  if (t > 0) {
    log(`Waiting ${t / 1000}s`)
    await sleep(t)
  }
}

/**
 * It implements a simple timer.
 */
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
/**
 * It implements an on/off timer.
 */
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
