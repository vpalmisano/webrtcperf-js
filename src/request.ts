import { log } from './common'

/**
 * The type of the request override function.
 * @param {Response} response The response to override.
 * @returns {Promise<Response>} The overridden response.
 */
export type RequestOverride = (response: Response) => Promise<Response>

const requestOverrides = new Map<string, RequestOverride>()

/**
 * Adds a request override for a given URL.
 * @param {string} url The URL to override (regex supported).
 * @param {RequestOverride} override The override function.
 */
export function addRequestOverride(url: string, override: RequestOverride) {
  requestOverrides.set(url, override)
}

/**
 * Removes a request override for a given URL.
 * @param {string} url The URL override to remove.
 */
export function removeRequestOverride(url: string) {
  requestOverrides.delete(url)
}

/**
 * Adds a JSON request override for a given URL.
 * @param {string} url The URL to override (regex supported).
 * @param {any} override The override javascript object.
 * Any fetch response with a `Content-Type` header of `application/json` will
 * be merged with the given javascript object.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function addJsonRequestOverride(url: string, override: any) {
  addRequestOverride(url, async (response: Response) => {
    if (response.headers.get('Content-Type') !== 'application/json') {
      return response
    }
    const json = await response.json()
    Object.assign(json, override)
    log(`request override json response:`, response, json)
    return new Response(JSON.stringify(json), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  })
}

const NativeFetch = window.fetch.bind(window)
window.fetch = async function (input: URL | RequestInfo, init?: RequestInit) {
  const url = typeof input === 'string' ? input : (input as Request).url
  const override = Array.from(requestOverrides.entries()).find(([key]) => url.match(RegExp(key)))
  if (!override) {
    return NativeFetch(input, init)
  }
  const overrideFn = override[1]
  log(`request override`, url)
  const response = await NativeFetch(input, init)
  return overrideFn(response)
}

/*
window.XMLHttpRequest = class extends XMLHttpRequest {
  private url: string = ''
  private overriddenResponse: string | ArrayBuffer | Blob | Document | object | null = null
  private overriddenResponseText: string | null = null
  private isOverridden: boolean = false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onload: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onloadend: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _onreadystatechange: ((this: XMLHttpRequest, ev: Event) => any) | null = null

  constructor() {
    super()

    // Intercept the load event to apply overrides before listeners are notified
    const originalAddEventListener = this.addEventListener.bind(this)
    const listeners: Array<{
      type: string
      listener: EventListenerOrEventListenerObject
      options?: boolean | AddEventListenerOptions
    }> = []

    // Override addEventListener to capture user listeners
    this.addEventListener = function (
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === 'load' || type === 'loadend' || type === 'readystatechange') {
        listeners.push({ type, listener, options })
        return
      }
      originalAddEventListener(type, listener, options)
    } as typeof XMLHttpRequest.prototype.addEventListener

    // Add our own load handler that runs first
    originalAddEventListener('load', async () => {
      const override = Array.from(requestOverrides.entries()).find(([key]) => this.url.match(RegExp(key)))
      if (override) {
        try {
          const overrideFn = override[1]
          log(`XMLHttpRequest override`, { url: this.url, responseType: this.responseType, response: this.response })

          // Create a Response object from the XMLHttpRequest response
          const headers = new Headers()
          const allHeaders = this.getAllResponseHeaders()
          allHeaders.split('\r\n').forEach((line) => {
            const parts = line.split(': ')
            if (parts.length === 2) {
              headers.append(parts[0], parts[1])
            }
          })

          const originalResponse = new Response(this.response, {
            status: this.status,
            statusText: this.statusText,
            headers,
          })

          // Apply the override
          const overriddenResponse = await overrideFn(originalResponse)

          // Extract the overridden content
          if (this.responseType === '' || this.responseType === 'text') {
            this.overriddenResponseText = await overriddenResponse.text()
            this.overriddenResponse = this.overriddenResponseText
          } else if (this.responseType === 'json') {
            this.overriddenResponse = await overriddenResponse.json()
            this.overriddenResponseText = JSON.stringify(this.overriddenResponse)
          } else if (this.responseType === 'blob') {
            this.overriddenResponse = await overriddenResponse.blob()
          } else if (this.responseType === 'arraybuffer') {
            this.overriddenResponse = await overriddenResponse.arrayBuffer()
          }

          this.isOverridden = true
          log(`XMLHttpRequest override applied`, { url: this.url, overriddenResponse: this.overriddenResponse })
        } catch (error) {
          log(`XMLHttpRequest override error`, { url: this.url, error })
        }
      }

      // Now trigger the user's listeners
      listeners.forEach(({ type, listener, options }) => {
        originalAddEventListener(type, listener, options)
      })

      // Trigger onload handler if set
      if (this._onload) {
        this._onload.call(this, new ProgressEvent('load'))
      }
    })

    // Also handle onloadend
    originalAddEventListener('loadend', async () => {
      if (this._onloadend) {
        this._onloadend.call(this, new ProgressEvent('loadend'))
      }
    })

    // Also handle onreadystatechange
    originalAddEventListener('readystatechange', async () => {
      if (this._onreadystatechange) {
        this._onreadystatechange.call(this, new Event('readystatechange'))
      }
    })
  }

  get onload() {
    return this._onload
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set onload(handler: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null) {
    this._onload = handler
  }

  get onloadend() {
    return this._onloadend
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set onloadend(handler: ((this: XMLHttpRequest, ev: ProgressEvent) => any) | null) {
    this._onloadend = handler
  }

  get onreadystatechange() {
    return this._onreadystatechange
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set onreadystatechange(handler: ((this: XMLHttpRequest, ev: Event) => any) | null) {
    this._onreadystatechange = handler
  }

  get response() {
    if (this.isOverridden && this.overriddenResponse !== null) {
      return this.overriddenResponse
    }
    return super.response
  }

  get responseText() {
    if (this.isOverridden && this.overriddenResponseText !== null) {
      return this.overriddenResponseText
    }
    return super.responseText
  }

  open = ((method: string, url: string, async: boolean, user?: string, password?: string) => {
    this.url = url
    this.isOverridden = false
    this.overriddenResponse = null
    this.overriddenResponseText = null
    this._onload = null
    this._onloadend = null
    this._onreadystatechange = null
    super.open(method, url, async, user, password)
  }) as typeof XMLHttpRequest.prototype.open
}
*/
