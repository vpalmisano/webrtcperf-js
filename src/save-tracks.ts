import { createWorker, overrides, log, config } from './common'
import { createMediaStorageWritable, STORAGE_DIRECTORY } from './fake-stream'

async function WsClient(url: string) {
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
  return {
    write: (data: Uint8Array) => {
      if (client.readyState !== WebSocket.OPEN) return
      client.send(data)
    },
    close: () => {
      client.close()
    },
  }
}

const saveFileWorkerFn = () => {
  const debug = (...args: unknown[]) => {
    console.log.apply(null, ['[webrtcperf-savefileworker]', ...args])
  }

  const stringToBinary = (str: string) => {
    return str.split('').reduce((prev, cur, index) => prev + (cur.charCodeAt(0) << (8 * index)), 0)
  }

  const buildIvfHeader = (
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
    return new Uint8Array(data)
  }

  const buildWaveHeader = (sampleRate: number, bitsPerSample: number, channels: number) => {
    const data = new ArrayBuffer(44)
    const view = new DataView(data)
    view.setUint32(0, stringToBinary('RIFF'), true)
    view.setUint32(4, 0xffffffff, true) // file size unknown (streaming)
    view.setUint32(8, stringToBinary('WAVE'), true)
    view.setUint32(12, stringToBinary('fmt '), true)
    view.setUint32(16, 16, true) // fmt chunk size
    view.setUint16(20, bitsPerSample === 32 ? 3 : 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, (sampleRate * bitsPerSample * channels) / 8, true)
    view.setUint16(32, (bitsPerSample * channels) / 8, true)
    view.setUint16(34, bitsPerSample, true)
    view.setUint32(36, stringToBinary('data'), true)
    view.setUint32(40, 0xffffffff, true) // data size unknown (streaming)
    return new Uint8Array(data)
  }

  let audioFrameToPcm16Supported = true

  const floatToPcm16 = (sample: number) => {
    const s = Math.max(-1, Math.min(1, sample))
    return s < 0 ? s * 0x8000 : s * 0x7fff
  }

  const audioFrameToPcm16 = (frame: AudioData) => {
    const { numberOfFrames, numberOfChannels, format } = frame
    const pcm = new Int16Array(numberOfFrames * numberOfChannels)

    if (format === 's16') {
      frame.copyTo(pcm, { planeIndex: 0 })
      return new Uint8Array(pcm.buffer)
    }

    if (format === 's16-planar') {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const plane = new Int16Array(numberOfFrames)
        frame.copyTo(plane, { planeIndex: ch })
        for (let i = 0; i < numberOfFrames; i++) {
          pcm[i * numberOfChannels + ch] = plane[i]
        }
      }
      return new Uint8Array(pcm.buffer)
    }

    if (audioFrameToPcm16Supported) {
      try {
        frame.copyTo(pcm, { planeIndex: 0, format: 's16' })
        return new Uint8Array(pcm.buffer)
      } catch {
        // Browsers may only support copy conversion to f32-planar.
        audioFrameToPcm16Supported = false
      }
    }

    const isPlanar = format?.includes('planar') ?? true

    if (isPlanar) {
      for (let ch = 0; ch < numberOfChannels; ch++) {
        const float = new Float32Array(numberOfFrames)
        frame.copyTo(float, { planeIndex: ch })
        for (let i = 0; i < numberOfFrames; i++) {
          pcm[i * numberOfChannels + ch] = floatToPcm16(float[i])
        }
      }
    } else {
      const float = new Float32Array(numberOfFrames * numberOfChannels)
      frame.copyTo(float, { planeIndex: 0 })
      for (let i = 0; i < pcm.length; i++) {
        pcm[i] = floatToPcm16(float[i])
      }
    }

    return new Uint8Array(pcm.buffer)
  }

  const websocketControllers = new Map()

  onmessage = async ({ data }) => {
    const { action, id, writable, readable, kind, x, y, width, height, frameRate, bitrate } = data as {
      action: string
      id: string
      writable: WritableStream
      readable: ReadableStream
      kind: string
      x: number
      y: number
      width: number
      height: number
      frameRate: number
      bitrate: number
    }
    const controller = new AbortController()
    debug(`action=${action} id=${id} kind=${kind} bitrate=${bitrate}`)
    if (action === 'stop') {
      const controller = websocketControllers.get(id)
      controller?.abort('done')
      return
    }

    websocketControllers.set(id, controller)
    const writer = writable.getWriter()
    if (kind === 'video') {
      let currentWidth = 0
      let currentHeight = 0
      let headerSent = false
      let startTimestamp = -1
      let lastPts = -1
      let lastTimestamp = 0
      const header = new ArrayBuffer(12)
      const view = new DataView(header)

      const encoder = new VideoEncoder({
        output: async (chunk) => {
          try {
            const { byteLength, timestamp } = chunk
            if (!headerSent) {
              await writer.write(buildIvfHeader(currentWidth, currentHeight, frameRate, 1, 'VP80'))
              headerSent = true
            }
            if (startTimestamp === -1) {
              startTimestamp = timestamp
            }
            const pts = Math.round((frameRate * (timestamp - startTimestamp)) / 1000000)
            if (lastPts >= 0 && pts <= lastPts) {
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
            await writer.write(buf)
            lastPts = pts
            lastTimestamp = timestamp
          } catch (err) {
            debug(`saveMediaTrack error=${(err as Error).message}`)
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
          bitrate,
          bitrateMode: 'variable',
          latencyMode: 'quality',
        })
        currentWidth = width
        currentHeight = height
      }

      const onClose = async () => {
        try {
          if (encoder?.state === 'configured') {
            encoder.flush()
          }
          encoder?.close()
        } catch (err) {
          debug(`saveMediaTrack error=${(err as Error).message}`)
        }
        await writer.close()
        writer.releaseLock()
        websocketControllers.delete(id)
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
              debug(`saveMediaTrack error=${(err as Error).message}`)
            } finally {
              frame.close()
            }
          },
          async close() {
            debug(`saveTrack close`)
            await onClose()
            postMessage({ name: 'close', id, kind })
          },
          async abort(reason) {
            debug(`saveTrack abort reason:`, reason)
            await onClose()
            postMessage({ name: 'close', reason, id, kind })
          },
        },
        new CountQueuingStrategy({ highWaterMark: frameRate * 10 }),
      )
      readable.pipeTo(writableStream, { signal: controller.signal }).catch((err: unknown) => {
        debug(`saveMediaTrack error=${(err as Error).message}`)
      })
    } else {
      let headerSent = false
      const writableStream = new WritableStream(
        {
          async write(frame: AudioData) {
            try {
              if (!headerSent) {
                await writer.write(buildWaveHeader(frame.sampleRate, 16, frame.numberOfChannels))
                headerSent = true
              }
              await writer.write(audioFrameToPcm16(frame))
            } catch (err) {
              debug(`saveMediaTrack error=${(err as Error).message}`)
            }
            frame.close()
          },
          async close() {
            debug(`saveTrack close`)
            await writer.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', id, kind })
          },
          async abort(reason) {
            debug(`saveTrack abort reason:`, reason)
            await writer.close()
            websocketControllers.delete(id)
            postMessage({ name: 'close', reason, id, kind })
          },
        },
        new CountQueuingStrategy({ highWaterMark: 100 }),
      )
      readable.pipeTo(writableStream, { signal: controller.signal }).catch((err: unknown) => {
        debug(`saveMediaTrack error=${(err as Error).message}`)
      })
    }
  }
}

export let saveFileWorker: Worker | null = null
const savingTracks = {
  audio: new Set(),
  video: new Set(),
}

export function getSaveFileWorker() {
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
 * Saves the media track to file. Audio tracks are saved as 16-bit PCM in a WAV container,
 * video tracks are saved as VP8 encoded packets in an IVF container.
 * If `config.SAVE_MEDIA_URL` is set, the file is sent to that server using a WebSocket connection.
 * Otherwise, it is saved to the browser's storage as `storage://webrtcperf/<filename>`.
 * @param {MediaStreamTrack} track The media track to save.
 * @param {'send'|'recv'} sendrecv If 'send', it is a local track. If 'recv', it is a remote track.
 * @param {Number} enableStart If greater than 0, the track is enabled after this time in milliseconds.
 * @param {Number} enableEnd If greater than 0, the track is disabled after this time in milliseconds.
 * @param {Number} x If greater than 0, the video is cropped to this x coordinate.
 * @param {Number} y If greater than 0, the video is cropped to this y coordinate.
 * @param {Number} width If greater than 0, the video is cropped to this width.
 * @param {Number} height If greater than 0, the video is cropped to this height.
 * @param {Number} frameRate The video frame rate.
 * @param {Number} bitrate The video bitrate.
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
 * await saveMediaTrack(videoTrack, 'send')
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
  bitrate = 20_000_000,
) {
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

  const filename = `${overrides.getParticipantNameForSave(sendrecv, track)}${kind === 'audio' ? '.wav' : '.ivf.raw'}`
  let writable: WritableStream
  if (config.SAVE_MEDIA_URL) {
    const destination = `${config.SAVE_MEDIA_URL}${config.SAVE_MEDIA_URL.includes('?') ? '&' : '?'}filename=${filename}`
    const wsClient = await WsClient(destination)
    writable = new WritableStream({
      write(chunk) {
        wsClient.write(chunk)
      },
      close() {
        wsClient.close()
      },
    })
  } else {
    const writableStream = await createMediaStorageWritable(filename)
    writable = new WritableStream({
      async write(chunk) {
        await writableStream.write(chunk)
      },
      async close() {
        await writableStream.close()
      },
    })
  }

  log(`saveMediaTrack ${config.SAVE_MEDIA_URL ? filename : `storage://${STORAGE_DIRECTORY}/${filename}`}`)
  getSaveFileWorker().postMessage(
    {
      action: 'start',
      id,
      writable,
      readable,
      kind,
      x,
      y,
      width,
      height,
      frameRate,
      bitrate,
    },
    [writable, readable],
  )
}

export function stopSaveMediaTrack(track: MediaStreamTrack) {
  const { id, kind } = track
  if (!savingTracks[kind as keyof typeof savingTracks].has(id)) {
    return
  }
  log(`stopSaveMediaTrack ${id}`)
  getSaveFileWorker().postMessage({ action: 'stop', id, kind })
}
