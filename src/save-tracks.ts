import { createWorker, overrides, log, config } from './common'

const saveFileWorkerFn = () => {
  const debug = (...args: unknown[]) => {
    console.log.apply(null, ['[webrtcperf-savefileworker]', ...args])
  }

  const wsClient = async (url: string) => {
    const client = new WebSocket(url, [])
    await new Promise<void>((resolve, reject) => {
      if (client.readyState === WebSocket.OPEN) {
        resolve()
      } else if (client.readyState === WebSocket.CLOSED) {
        reject(new Error('WebSocket closed'))
      }
      client.addEventListener('open', () => resolve(), { once: true })
      client.addEventListener('error', (err) => reject(err), { once: true })
    })
    return client
  }

  const stringToBinary = (str: string) => {
    return str.split('').reduce((prev, cur, index) => prev + (cur.charCodeAt(0) << (8 * index)), 0)
  }

  const writeIvfHeader = (
    ws: WebSocket,
    width: number,
    height: number,
    frameRateDenominator: number,
    frameRateNumerator: number,
    fourcc: string,
  ) => {
    const data = new ArrayBuffer(32)
    const view = new DataView(data)
    view.setUint32(0, stringToBinary('DKIF'), true)
    view.setUint16(4, 0, true) // version
    view.setUint16(6, 32, true) // header size
    view.setUint32(8, stringToBinary(fourcc), true)
    view.setUint16(12, width, true)
    view.setUint16(14, height, true)
    view.setUint32(16, frameRateDenominator, true)
    view.setUint32(20, frameRateNumerator, true)
    view.setUint32(24, 0, true) // frame count
    view.setUint32(28, 0, true) // unused
    ws.send(data)
  }

  const websocketControllers = new Map()

  onmessage = async ({ data }) => {
    const { action, id, url, readable, kind, x, y, width, height, frameRate } = data
    const controller = new AbortController()
    debug(`action=${action} id=${id} kind=${kind} url=${url}`)
    if (action === 'stop') {
      const controller = websocketControllers.get(id)
      controller?.abort('done')
      return
    }

    const ws = await wsClient(url)
    websocketControllers.set(id, controller)
    if (kind === 'video') {
      let currentWidth = 0
      let currentHeight = 0
      let headerSent = false
      let startTimestamp = -1
      let lastPts = 0
      let lastTimestamp = 0
      const header = new ArrayBuffer(12)
      const view = new DataView(header)

      const encoder = new VideoEncoder({
        output: (chunk) => {
          if (ws.readyState !== WebSocket.OPEN) return
          try {
            const { byteLength, timestamp } = chunk
            if (!headerSent) {
              writeIvfHeader(ws, currentWidth, currentHeight, frameRate, 1, 'VP80')
              headerSent = true
            }
            if (startTimestamp === -1) {
              startTimestamp = timestamp
            }
            const pts = Math.round((frameRate * (timestamp - startTimestamp)) / 1000000)
            if (pts <= lastPts) {
              debug(`skip pts: ${pts} <= ${lastPts} timestamp: ${timestamp} lastTimestamp: ${lastTimestamp}`)
              return
            }
            const data = new ArrayBuffer(byteLength)
            chunk.copyTo(data)
            view.setUint32(0, byteLength, true)
            view.setBigUint64(4, BigInt(pts), true)
            const buf = new Uint8Array(header.byteLength + byteLength)
            buf.set(new Uint8Array(header), 0)
            buf.set(new Uint8Array(data), header.byteLength)
            ws.send(buf)
            lastPts = pts
            lastTimestamp = timestamp
          } catch (err) {
            debug(`saveMediaTrack ${url} error=${(err as Error).message}`)
          }
        },
        error: (e) => debug(`encoder error: ${e.message}`),
      })

      const configureEncoder = (width: number, height: number) => {
        debug(`configureEncoder ${width}x${height}@${frameRate}`)
        if (encoder?.state === 'configured') {
          encoder.flush()
          encoder.reset()
        }
        encoder.configure({
          codec: 'vp8',
          width,
          height,
          framerate: frameRate,
          bitrate: 20_000_000,
          bitrateMode: 'variable',
          latencyMode: 'quality',
        })
        currentWidth = width
        currentHeight = height
      }

      const writableStream = new WritableStream(
        {
          async write(frame: VideoFrame) {
            const { codedWidth, codedHeight, timestamp, duration } = frame
            try {
              //log(`encode ${timestamp} ${duration} ${codedWidth}x${codedHeight} ${frame.format}`)
              if (!codedWidth || !codedHeight) return
              if (x || y || (width && width !== codedWidth) || (height && height !== codedHeight)) {
                const w = Math.min(width, codedWidth)
                const h = Math.min(height, codedHeight)
                const rect = { x, y, width: w, height: h }
                const buffer = new Uint8Array(frame.allocationSize({ rect, format: 'RGBA' }))
                await frame.copyTo(buffer, { rect, format: 'RGBA' })
                frame.close()
                frame = new VideoFrame(buffer, {
                  timestamp,
                  duration: duration ?? undefined,
                  codedWidth: w,
                  codedHeight: h,
                  format: 'RGBA',
                })
              }
              if (currentWidth !== frame.codedWidth || currentHeight !== frame.codedHeight) {
                configureEncoder(frame.codedWidth, frame.codedHeight)
              }
              encoder.encode(frame, { keyFrame: true })
            } catch (err) {
              debug(`saveMediaTrack ${url} error=${(err as Error).message}`)
            } finally {
              frame.close()
            }
          },
          close() {
            debug(`saveTrack ${url} close`)
            if (encoder?.state === 'configured') {
              encoder.flush()
            }
            encoder?.close()
            ws.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', id, kind })
          },
          abort(reason) {
            debug(`saveTrack ${url} abort reason:`, reason)
            if (encoder?.state === 'configured') {
              encoder.flush()
            }
            encoder?.close()
            ws.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', reason, id, kind })
          },
        },
        new CountQueuingStrategy({ highWaterMark: frameRate * 10 }),
      )
      readable.pipeTo(writableStream, { signal: controller.signal }).catch((err: unknown) => {
        debug(`saveMediaTrack ${url} error=${(err as Error).message}`)
      })
    } else {
      const writableStream = new WritableStream(
        {
          async write(frame: AudioData) {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                const { numberOfFrames } = frame
                const data = new Float32Array(numberOfFrames)
                frame.copyTo(data, { planeIndex: 0 })
                ws.send(data)
              } catch (err) {
                debug(`saveMediaTrack ${url} error=${(err as Error).message}`)
              }
            }
            frame.close()
          },
          close() {
            debug(`saveTrack ${url} close`)
            ws.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', id, kind })
          },
          abort(reason) {
            debug(`saveTrack ${url} abort reason:`, reason)
            ws.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', reason, id, kind })
          },
        },
        new CountQueuingStrategy({ highWaterMark: 100 }),
      )
      readable.pipeTo(writableStream, { signal: controller.signal }).catch((err: unknown) => {
        debug(`saveMediaTrack ${url} error=${(err as Error).message}`)
      })
    }
  }
}

export let saveFileWorker: Worker | null = null
const savingTracks = {
  audio: new Set(),
  video: new Set(),
}

function getSaveFileWorker() {
  if (!saveFileWorker) {
    saveFileWorker = createWorker(saveFileWorkerFn)
    saveFileWorker.onmessage = (event) => {
      const { name, reason, kind, id } = event.data
      log(`saveFileWorker event: ${name} kind: ${kind} id: ${id} reason: ${reason}`)
      savingTracks[kind as keyof typeof savingTracks].delete(id)
    }
  }
  return saveFileWorker
}

/**
 * Saves the media track to file. Audio tracks are saved as a raw float32 array,
 * video tracks are saved as VP8 encoded packets in an IVF container.
 * The file is sent to the server defined in `config.SAVE_MEDIA_URL` using a WebSocket connection.
 * @param {MediaStreamTrack} track The media track to save.
 * @param {'send'|'recv'} sendrecv If 'send', it is a local track. If 'recv', it is a remote track.
 * @param {Number} enableStart If greater than 0, the track is enabled after this time in milliseconds.
 * @param {Number} enableEnd If greater than 0, the track is disabled after this time in milliseconds.
 * @param {Number} x If greater than 0, the video is cropped to this x coordinate.
 * @param {Number} y If greater than 0, the video is cropped to this y coordinate.
 * @param {Number} width If greater than 0, the video is cropped to this width.
 * @param {Number} height If greater than 0, the video is cropped to this height.
 * @param {Number} frameRate The video frame rate.
 *
 * Examples
 * --------
 *
 * Run a simple websocket server:
 * ```javascript
 * const ws = require('ws')
 * const fs = require('fs')
 * const wss = new ws.Server({ port: 8080 })
 * wss.on('connection', (ws, req) => {
 *   const query = req.url.split('?')[1]
 *   const filename = new URLSearchParams(query).get('filename')
 *   const file = fs.createWriteStream(filename)
 *   console.log(`Saving media to ${filename}`)
 *   ws.on('message', message => file.write(message))
 *   ws.on('close', () => {
 *     console.log(`done saving ${filename}`)
 *     file.end()
 *   })
 * })
 * ```
 *
 * Run the test:
 * ```javascript
 * webrtcperf.config.SAVE_MEDIA_URL = 'ws://localhost:8080'
 * await saveMediaTrack(track, 'send')
 * ```
 * The file will sent to the server as `Participant-000000_send_<track.id>.ivf.raw`.
 */
export async function saveMediaTrack(
  track: MediaStreamTrack,
  sendrecv: 'send' | 'recv',
  enableStart = 0,
  enableEnd = 0,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  frameRate = config.VIDEO_FRAMERATE,
) {
  if (!config.SAVE_MEDIA_URL) {
    throw new Error('config.SAVE_MEDIA_URL is not set')
  }
  const { id, kind } = track
  if (savingTracks[kind as keyof typeof savingTracks].has(id)) {
    return
  }
  const { readable } = new window.MediaStreamTrackProcessor({ track })
  savingTracks[kind as keyof typeof savingTracks].add(id)

  if (enableStart > 0) {
    track.enabled = false
    setTimeout(() => {
      track.enabled = true
    }, enableStart)
  }
  if (enableEnd > 0) {
    setTimeout(() => {
      track.enabled = false
    }, enableEnd)
  }

  const filename = `${overrides.getParticipantNameForSave(sendrecv, track)}${kind === 'audio' ? '.f32le.raw' : '.ivf.raw'}`
  const url = `${config.SAVE_MEDIA_URL}${config.SAVE_MEDIA_URL.includes('?') ? '&' : '?'}filename=${filename}`

  log(`saveMediaTrack ${filename}`)
  getSaveFileWorker().postMessage(
    {
      action: 'start',
      id,
      url,
      readable,
      kind,
      x,
      y,
      width,
      height,
      frameRate,
    },
    [readable],
  )
}

export async function stopSaveMediaTrack(track: MediaStreamTrack) {
  const { id, kind } = track
  if (!savingTracks[kind as keyof typeof savingTracks].has(id)) {
    return
  }
  log(`stopSaveMediaTrack ${id}`)
  getSaveFileWorker().postMessage({ action: 'stop', id, kind })
}
