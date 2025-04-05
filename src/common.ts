import { FakeScreenshareParams } from './screenshare'

declare global {
  interface Window {
    webrtcperf?: {
      config: typeof config
      params: typeof params
    }
    webrtcperf_serializedConsoleLog: (method: string, msg: string) => Promise<void>
    webrtcperf_keyPress: (key: string) => Promise<void>
    webrtcperf_keypressText: (selector: string, text: string) => Promise<void>
    webrtcperf_startFakeScreenshare: () => Promise<void>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MediaStreamTrackProcessor: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    MediaStreamTrackGenerator: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    BrowserCaptureMediaStreamTrack: any
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

export type EnableValue = boolean | string | number

export const VERSION = process.env.VERSION || 'dev'

export const config = {
  START_TIMESTAMP: Date.now(),
  WEBRTC_PERF_INDEX: 0,
  WEBRTC_PERF_URL: '',
  VIDEO_WIDTH: 1920,
  VIDEO_HEIGHT: 1080,
  VIDEO_FRAMERATE: 30,
  GET_DISPLAY_MEDIA_CROP: '',
  MEDIA_URL: '',
  VIDEO_URL: '',
  AUDIO_URL: '',
  SAVE_MEDIA_URL: '',
  GET_CAPABILITIES_DISABLED_VIDEO_CODECS: [] as string[],
}

export const params = {
  actions: [] as Action[],
  enableVideoStats: false as EnableValue,
  getUserMediaWaitTime: 0 as number,
  getDisplayMediaWaitTime: 0 as number,
  timestampWatermarkAudio: false as EnableValue,
  timestampWatermarkVideo: false as EnableValue,
  fakeScreenshare: null as FakeScreenshareParams | null,
  drawWatermarkGrid: false,
  timestampInsertableStreams: false,
  peerConnectionDebug: false as EnableValue,
  // Save tracks
  saveSendVideoTrack: false as EnableValue,
  saveVideoTrackEnableStart: 0 as number,
  saveVideoTrackEnableEnd: 0 as number,
  saveSendAudioTrack: false as EnableValue,
  saveAudioTrackEnableStart: 0 as number,
  saveAudioTrackEnableEnd: 0 as number,
  saveRecvVideoTrack: false as EnableValue,
  saveRecvAudioTrack: false as EnableValue,
  // Playout delay hint
  playoutDelayHint: null as number | null,
  jitterBufferTarget: null as number | { audio: number | null; video: number | null } | null,
}

if ('webrtcperf' in window && window.webrtcperf) {
  Object.assign(config, window.webrtcperf.config || {})
  Object.assign(params, window.webrtcperf.params || {})
}

if (localStorage.getItem('webrtcperf.config')) {
  try {
    Object.assign(config, JSON.parse(localStorage.getItem('webrtcperf.config') || '{}') || {})
  } catch (e) {
    console.error('Error parsing webrtcperf.config', e)
  }
}

if (localStorage.getItem('webrtcperf.params')) {
  try {
    Object.assign(params, JSON.parse(localStorage.getItem('webrtcperf.params') || '{}') || {})
  } catch (e) {
    console.error('Error parsing webrtcperf.params', e)
  }
}

/**
 * Get the name of the webrtcperf participant.
 */
function getParticipantName(index = getIndex()) {
  return `Participant-${index.toString().padStart(6, '0')}`
}

function getParticipantNameForSave(sendrecv: string, track: MediaStreamTrack) {
  return `${overrides.getParticipantName()}_${sendrecv}_${track.id}`
}

/**
 * Returns the name of the sender participant for a given track.
 */
function getReceiverParticipantName(track: MediaStreamTrack) {
  return track.id
}

/**
 * Check if the track is a sender display track.
 * @param {MediaStreamTrack} track
 * @returns {boolean}
 */
function isSenderDisplayTrack(track: MediaStreamTrack) {
  if (track.kind !== 'video') return false

  if (['detail', 'text'].indexOf(track.contentHint) !== -1) return true
  if (track instanceof window.BrowserCaptureMediaStreamTrack) return true

  const trackSettings = track.getSettings()
  const trackConstraints = track.getConstraints()

  if ('mediaSource' in trackConstraints && trackConstraints.mediaSource !== undefined) {
    return trackConstraints.mediaSource === 'window' || trackConstraints.mediaSource === 'screen'
  } else if (trackSettings.displaySurface || ('logicalSurface' in trackSettings && trackSettings.logicalSurface)) {
    return true
  } else {
    return !trackSettings.deviceId
  }
}

function isReceiverDisplayTrack(track: MediaStreamTrack) {
  return isSenderDisplayTrack(track)
}

export const overrides = {
  trackApplyConstraints: null as
    | ((track: MediaStreamTrack, constraints?: MediaTrackConstraints) => MediaTrackConstraints)
    | null,
  getUserMedia: null as ((constraints?: MediaStreamConstraints) => MediaStreamConstraints) | null,
  getUserMediaStream: null as ((stream: MediaStream) => MediaStream) | null,
  getDisplayMedia: null as ((constraints?: MediaStreamConstraints) => MediaStreamConstraints) | null,
  getDisplayMediaStream: null as ((stream: MediaStream) => MediaStream) | null,
  createOffer: null as ((offer: RTCSessionDescriptionInit) => RTCSessionDescriptionInit) | null,
  setLocalDescription: null as ((description: RTCSessionDescriptionInit) => RTCSessionDescriptionInit) | null,
  setRemoteDescription: null as ((description: RTCSessionDescriptionInit) => RTCSessionDescriptionInit) | null,
  setParameters: null as ((parameters: RTCRtpSendParameters) => RTCRtpSendParameters) | null,
  setStreams: null as ((streams: MediaStream[]) => MediaStream[]) | null,
  replaceTrack: null as ((track: MediaStreamTrack | null) => MediaStreamTrack) | null,
  isSenderDisplayTrack,
  isReceiverDisplayTrack,
  getReceiverParticipantName,
  getParticipantName,
  getParticipantNameForSave,
}

export function elapsedTime() {
  return Date.now() - config.START_TIMESTAMP
}

if (window.webrtcperf_serializedConsoleLog) {
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

      void window.webrtcperf_serializedConsoleLog(method, msg)
      return nativeFn(...args)
    }
  })
}

/**
 * Logging utility.
 */
export function log(...args: unknown[]) {
  console.log.apply(null, [`[webrtcperf-${getIndex()}]`, ...args])
}

/**
 * Sleep utility.
 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Get the index of the webrtcperf participant.
 */
export function getIndex() {
  return config.WEBRTC_PERF_INDEX || 0
}

/**
 * Get the URL of the webrtcperf participant.
 */
export function getUrl() {
  return config.WEBRTC_PERF_URL || document.location.href
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
 * It gets the elements matching the selector, waiting for them to be present in the DOM.
 * @param {string} selector The selector to get the elements from.
 * @param {number} timeout The timeout to wait for the elements to be present in the DOM.
 * @param {boolean} throwError Whether to throw an error if the elements are not found.
 * @param {string} innerText The inner text to filter the elements by.
 * @return {Promise<HTMLElement[]>} The elements matching the selector.
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

/**
 * Check if the current session is included into the value setting configuration.
 * @param value A session ID number, a range of numbers separated by a dash, a comma separated list of numbers or a boolean.
 */
export function enabledForSession(value: EnableValue) {
  if (value === true || value === 'true') {
    return true
  } else if (value === false || value === 'false' || value === undefined) {
    return false
  } else if (typeof value === 'string') {
    if (value.indexOf('-') !== -1) {
      const [start, end] = value.split('-').map((s) => parseInt(s))
      if (isFinite(start) && getIndex() < start) {
        return false
      }
      if (isFinite(end) && getIndex() > end) {
        return false
      }
      return true
    } else {
      const indexes = value
        .split(',')
        .filter((s) => s.length)
        .map((s) => parseInt(s))
      return indexes.includes(getIndex())
    }
  } else if (getIndex() === value) {
    return true
  }
  return false
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
  const participantWaitTime = waitUtilTimeRate > 0 ? getIndex() / waitUtilTimeRate : 0
  const t = waitUtilTime * 1000 + participantWaitTime * 1000 - elapsedTime()
  if (t > 0) {
    log(`Waiting ${t / 1000}s`)
    await sleep(t)
  }
}
