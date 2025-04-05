import { log } from './common'

const requestOverrides = new Map<string, (response: Response) => Promise<Response>>()

export function addRequestOverride(url: string, override: (response: Response) => Promise<Response>) {
  requestOverrides.set(url, override)
}

export function removeRequestOverride(url: string) {
  requestOverrides.delete(url)
}

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

/* window.XMLHttpRequest = class extends XMLHttpRequest {
  private url: string = ''

  constructor() {
    super()
    this.addEventListener('load', () => {
      log(`XMLHttpRequest load`, this.url, this.response)
    })
  }

  open = ((method: string, url: string, async: boolean, user?: string, password?: string) => {
    log(`XMLHttpRequest open`, method, url)
    this.url = url
    super.open(method, url, async, user, password)
  }) as typeof XMLHttpRequest.prototype.open

  send(body?: string | Document | Blob | ArrayBufferView) {
    log(`XMLHttpRequest send`, this.url, body)
    return super.send(body)
  }
} */
