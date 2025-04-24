import { Action } from './actions'
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

export type EnableValue = boolean | string | number

export const VERSION = process.env.VERSION || 'dev'

/**
 * Configuration for the webrtcperf tool.
 */
export const config = {
  /**
   * The timestamp of the start of the webrtcperf test or the page load timestamp.
   */
  START_TIMESTAMP: Date.now(),
  /**
   * The index of the webrtcperf participant.
   */
  WEBRTC_PERF_INDEX: 0,
  /**
   * The page URL of the webrtcperf test.
   */
  WEBRTC_PERF_URL: '',
  /**
   * The width of the fake video.
   */
  VIDEO_WIDTH: 1920,
  /**
   * The height of the fake video.
   */
  VIDEO_HEIGHT: 1080,
  /**
   * The frame rate of the fake video.
   */
  VIDEO_FRAMERATE: 30,
  /**
   * The crop target for the getDisplayMedia call.
   */
  GET_DISPLAY_MEDIA_CROP: '',
  /**
   * The URL of the fake media.
   */
  MEDIA_URL: '',
  /**
   * The URL of the fake media (video track only).
   */
  VIDEO_URL: '',
  /**
   * The URL of the fake media (audio track only).
   */
  AUDIO_URL: '',
  /**
   * The URL of the WebSocket server to save the the media content.
   */
  SAVE_MEDIA_URL: '',
  /**
   * List of video codecs to disable overriding the SDP capabilities.
   */
  GET_CAPABILITIES_DISABLED_VIDEO_CODECS: [] as string[],
}

/**
 * Parameters for the webrtcperf tool.
 */
export const params = {
  /**
   * List of actions to perform.
   */
  actions: [] as Action[],
  /**
   * Enable video stats.
   */
  enableVideoStats: false as EnableValue,
  /**
   * It set, the getUserMedia will wait for the specified time before returning.
   */
  getUserMediaWaitTime: 0 as number,
  /**
   * It set, the getDisplayMedia will wait for the specified time before returning.
   */
  getDisplayMediaWaitTime: 0 as number,
  /**
   * It set, a watermark with the current timestamp will be added to the sent audio tracks.
   * It will recognize the watermark on the received audio tracks and collect the delay
   * into the `audioEndToEndDelayStats` object.
   */
  timestampWatermarkAudio: false as EnableValue,
  /**
   * It set, a watermark with the current timestamp will be added to the sent video tracks.
   * It will recognize the watermark on the received video tracks and collect the delay
   * into the `videoEndToEndDelayStats` object.
   */
  timestampWatermarkVideo: false as EnableValue,
  /**
   * It set, the fake screenshare will be created with the specified parameters.
   */
  fakeScreenshare: null as FakeScreenshareParams | null,
  /**
   * It set, a grid will be drawn on the video track.
   */
  drawWatermarkGrid: false,
  timestampInsertableStreams: false,
  /**
   * It set, the peer connection will run with additional debug logs.
   */
  peerConnectionDebug: false as EnableValue,
  /**
   * It set, the RTCPeerConnection sent video tracks will be saved.
   */
  saveSendVideoTrack: false as EnableValue,
  /**
   * It set, the RTCPeerConnection sent audio tracks will be saved.
   */
  saveSendAudioTrack: false as EnableValue,
  /**
   * The time in milliseconds after which the RTCPeerConnection sent video track will be enabled.
   */
  saveVideoTrackEnableStart: 0 as number,
  /**
   * The time in milliseconds after which the RTCPeerConnection sent video track will be disabled.
   */
  saveVideoTrackEnableEnd: 0 as number,
  /**
   * The time in milliseconds after which the RTCPeerConnection sent audio track will be enabled.
   */
  saveAudioTrackEnableStart: 0 as number,
  /**
   * The time in milliseconds after which the RTCPeerConnection sent audio track will be disabled.
   */
  saveAudioTrackEnableEnd: 0 as number,
  /**
   * It set, the RTCPeerConnection received video tracks will be saved.
   */
  saveRecvVideoTrack: false as EnableValue,
  /**
   * If set, the RTCPeerConnection received audio tracks will be saved.
   */
  saveRecvAudioTrack: false as EnableValue,
  /**
   * If set, all the created RTCRtpReceivers will be configured with the specified playout delay hint (in seconds).
   */
  playoutDelayHint: null as number | null,
  /**
   * If set, all the created RTCRtpReceivers will be configured with the specified jitter buffer target (in seconds).
   * It can be configured for each track kind or bo
   */
  jitterBufferTarget: null as number | { audio: number | null; video: number | null } | null,
  /**
   * If set, the RTCPeerConnection offer will be modified to include the abs-capture-time extension.
   */
  absCaptureTime: false as EnableValue,
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
 * When running inside the webrtcperf tool, it returns the name of the webrtcperf participant.
 * When used stand-alone, it returns a string in the format `Participant-<index>`,
 * where `<index>` is the index defined in the `config.WEBRTC_PERF_INDEX` configuration.
 * @param {number} index The index of the participant.
 * @returns {string} The name of the participant.
 */
function getParticipantName(index = getIndex()) {
  return `Participant-${index.toString().padStart(6, '0')}`
}

/**
 * Returns the name of the participant for a given track used by the save media feature.
 * @param {string} sendrecv The direction of the track.
 * @param {MediaStreamTrack} track The track to get the name for.
 * @returns {string} The name of the participant.
 */
function getParticipantNameForSave(sendrecv: string, track: MediaStreamTrack) {
  return `${overrides.getParticipantName()}_${sendrecv}_${track.id}`
}

/**
 * Returns the name of the sender participant for a given track.
 * @param {MediaStreamTrack} track The track to get the name for.
 * @returns {string} The name of the participant.
 */
function getReceiverParticipantName(track: MediaStreamTrack) {
  return track.id
}

/**
 * Checks if the track is a sender display track.
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

/**
 * Checks if the track is a receiver display track.
 * @param {MediaStreamTrack} track
 * @returns {boolean}
 */
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

/**
 * Returns the elapsed time since the start of the test in webrtcperf, or since the page load.
 * @returns {number} The elapsed time in milliseconds.
 */
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
 * Logs a message to the console.
 * @param {...unknown[]} args The message to log.
 */
export function log(...args: unknown[]) {
  console.log.apply(null, [`[webrtcperf-${getIndex()}]`, ...args])
}

/**
 * Sleeps for a given number of milliseconds.
 * @param {number} ms The number of milliseconds to sleep.
 * @returns {Promise<void>} A promise that resolves when the sleep is over.
 */
export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Returns the index of the webrtcperf participant.
 * @returns {number} The index of the participant.
 */
export function getIndex() {
  return config.WEBRTC_PERF_INDEX || 0
}

/**
 * Returns the URL of the webrtcperf participant.
 * @returns {string} The URL of the participant.
 */
export function getUrl() {
  return config.WEBRTC_PERF_URL || document.location.href
}

/**
 * Returns the first element matching the selector.
 * @param {string} selector The selector to get the element from.
 * @param {number} timeout The timeout to wait for the element to be present in the DOM.
 * @param {boolean} throwError Whether to throw an error if the element is not found.
 * @return {Promise<HTMLElement>} The element matching the selector.
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
 * Returns all the elements matching the selector, waiting for them to be present in the DOM.
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

/**
 * Clicks on the first element matching the selector.
 * @param {string} selector The selector to click on.
 * @param {number} timeout The timeout to wait for the element to be present in the DOM.
 * @param {string} text The text to filter the elements by.
 * @returns {Promise<HTMLElement>} The element that was clicked.
 */
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

/**
 * Simulates a mouse click on an element.
 * @param {HTMLElement} element The element to click on.
 */
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
 * Injects a CSS string into the document.
 * @param {string} css The CSS string to inject.
 * @param {string} id The id of the style element to create.
 * @returns {HTMLElement} The style element that was created.
 */
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

/**
 * Watches a property of an object.
 * @param object The object to watch.
 * @param name The name of the property to watch.
 * @param cb The callback to call when the property changes. It receives the new value and the old value.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function watchObjectProperty(object: any, name: string, cb: (newValue: any, oldValue: any) => void) {
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

/**
 * Loads a script into the document.
 * @param {string} name The name of the script to load.
 * @param {string} src The source URL of the script.
 * @param {string} textContent The text content of the script.
 * @returns {Promise<HTMLElement>} The script element that was created.
 */
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

/**
 * Returns the harmonic mean of an array of numbers.
 * @param {number[]} array The array of numbers to calculate the harmonic mean of.
 * @returns {number} The harmonic mean of the array.
 */
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

/**
 * Unregisters all service workers.
 */
export function unregisterServiceWorkers() {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const registration of registrations) {
      registration.unregister()
    }
  })
}

/**
 * Checks if the current webrtcperf session is included into the value setting configuration.
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

/**
 * Converts a string to a binary number.
 * @param {string} str The string to convert.
 * @returns {number} The binary number.
 */
export function stringToBinary(str: string) {
  return str.split('').reduce((prev, cur, index) => prev + (cur.charCodeAt(0) << (8 * index)), 0)
}

/**
 * Creates a worker from a function.
 * @param {Function} fn The function to create the worker from.
 * @returns {Worker} The worker.
 */
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
 * Waits until the time is reached.
 * @param {number} waitUtilTime The time in seconds to wait from the start of the webrtcperf tool or the page load.
 * @param {number} waitUtilTimeRate An additional time to wait calculated as `participant_index / waitUtilTimeRate`.
 * @returns {Promise<void>} A promise that resolves when the time is reached.
 * Examples:
 * ```javascript
 * await waitUtilTime(10)
 * ```
 * This will wait until 10 seconds have passed from the start.
 *
 * ```javascript
 * await waitUtilTime(10, 2)
 * ```
 * This will wait until 10 seconds have passed from the start, plus 2 seconds for each participant
 * (`Participant-000000` will wait 10 seconds, `Participant-000001` will wait 12 seconds,
 * `Participant-000002`  will wait 14 seconds, etc.).
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
