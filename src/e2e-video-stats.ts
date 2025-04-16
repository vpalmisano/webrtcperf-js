import { createWorker, loadScript, log, overrides, params } from './common'
import { MeasuredStats } from './stats'

/**
 * Video end-to-end delay stats.
 */
export const videoEndToEndDelayStats = new MeasuredStats({ ttl: 15 })
export const screenEndToEndDelayStats = new MeasuredStats({ ttl: 15 })

export const videoStartFrameDelayStats = new MeasuredStats({ ttl: 60 })
export let videoStartFrameTime = null as number | null

export const screenStartFrameDelayStats = new MeasuredStats({ ttl: 60 })
export let screenStartFrameTime = null as number | null

/**
 * It sets the start frame time used for calculating the videoStartFrameDelay metric.
 * @param value The start frame time in seconds.
 */
export function setVideoStartFrameTime(value: number) {
  videoStartFrameTime = value
}

/**
 * It sets the start frame time used for calculating the screenStartFrameDelay metric.
 * @param value The start frame time in seconds.
 */
export function setScreenStartFrameTime(value: number) {
  screenStartFrameTime = value
}

export function collectVideoEndToEndStats() {
  const videoStartFrameDelay = videoStartFrameDelayStats.mean()
  const screenStartFrameDelay = screenStartFrameDelayStats.mean()
  return {
    videoDelay: videoEndToEndDelayStats.mean(),
    videoStartFrameDelay:
      videoStartFrameDelay !== undefined && videoStartFrameTime !== null && videoStartFrameDelay > videoStartFrameTime
        ? videoStartFrameDelay - videoStartFrameTime
        : undefined,
    screenDelay: screenEndToEndDelayStats.mean(),
    screenStartFrameDelay:
      screenStartFrameDelay !== undefined &&
      screenStartFrameTime !== null &&
      screenStartFrameDelay > screenStartFrameTime
        ? screenStartFrameDelay - screenStartFrameTime
        : undefined,
  }
}

const applyVideoTimestampWatermarkFn = () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const debug = (...args: any[]) => {
    console.log.apply(null, ['[webrtcperf-applyVideoTimestampWatermarkWorker]', ...args])
  }

  onmessage = ({ data }) => {
    const { readable, writable, width, height, participantName, drawGrid } = data
    debug(`participantName=${participantName} ${width}x${height}`)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const fontSize = Math.round(canvas.height / 18)
    ctx.font = `${fontSize}px Noto Mono`
    ctx.textAlign = 'center'
    const textHeight = Math.round(canvas.height / 15)
    const participantNameIndex = parseInt(participantName.split('-')[1]) || 0

    const transformer = new TransformStream({
      async transform(videoFrame, controller) {
        const text = `${participantNameIndex}-${Date.now()}`
        const timestamp = videoFrame.timestamp

        const bitmap = await createImageBitmap(videoFrame)
        videoFrame.close()
        ctx.drawImage(bitmap, 0, 0, width, height)
        bitmap.close()

        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, width, textHeight)

        if (drawGrid) {
          ctx.beginPath()
          for (let d = 0; d < height; d += 25) {
            ctx.moveTo(0, textHeight + d)
            ctx.lineTo(width, textHeight + d)
          }
          for (let d = 0; d < width; d += 25) {
            ctx.moveTo(d, 0)
            ctx.lineTo(d, height)
          }
          ctx.strokeStyle = 'black'
          ctx.stroke()
        }

        ctx.fillStyle = 'white'
        ctx.fillText(text, width / 2, fontSize)

        const newBitmap = await createImageBitmap(canvas)

        const newFrame = new VideoFrame(newBitmap, { timestamp })
        newBitmap.close()
        controller.enqueue(newFrame)
      },

      flush(controller) {
        controller.terminate()
      },
    })

    readable
      .pipeThrough(transformer)
      .pipeTo(writable)
      .catch((err: unknown) => {
        debug(`applyVideoTimestampWatermark error: ${(err as Error).message}`)
      })
  }
}

let applyVideoTimestampWatermarkWorker: Worker | null = null

function getApplyVideoTimestampWatermarkWorker() {
  if (applyVideoTimestampWatermarkWorker) {
    return applyVideoTimestampWatermarkWorker
  }
  applyVideoTimestampWatermarkWorker = createWorker(applyVideoTimestampWatermarkFn)
  return applyVideoTimestampWatermarkWorker
}

/**
 * Replaces the MediaStream video track with a new generated one with
 * timestamp watermark.
 * @param {MediaStream} mediaStream
 * @returns {MediaStream}
 */
export function applyVideoTimestampWatermark(mediaStream: MediaStream) {
  if (!('MediaStreamTrackProcessor' in window) || !('MediaStreamTrackGenerator' in window)) {
    log(`[e2e-video-stats] unsupported MediaStreamTrackProcessor and MediaStreamTrackGenerator`)
    return mediaStream
  }
  const track = mediaStream.getVideoTracks()[0]
  if (!track) {
    return mediaStream
  }

  const trackSettings = track.getSettings()
  const trackConstraints = track.getConstraints()

  const { width, height } = trackSettings
  const participantName = overrides.getParticipantName()

  log(`[e2e-video-stats] applyVideoTimestampWatermark ${track.id}`, { track, trackSettings, trackConstraints })

  const trackProcessor = new window.MediaStreamTrackProcessor({ track })
  const trackGenerator = new window.MediaStreamTrackGenerator({ kind: 'video' })
  track.addEventListener('ended', () => {
    trackGenerator.close()
    trackProcessor.close()
  })
  const trackGeneratorStop = trackGenerator.stop.bind(trackGenerator)
  trackGenerator.stop = () => {
    log(`applyVideoTimestampWatermark ${track.id} stop`)
    trackGeneratorStop()
    track.stop()
  }
  trackGenerator.getSettings = () => trackSettings
  trackGenerator.getConstraints = () => trackConstraints

  const { readable } = trackProcessor
  const { writable } = trackGenerator

  getApplyVideoTimestampWatermarkWorker().postMessage(
    {
      readable,
      writable,
      width,
      height,
      participantName,
      drawGrid: params.drawWatermarkGrid,
    },
    [readable, writable],
  )

  mediaStream.removeTrack(track)
  mediaStream.addTrack(trackGenerator)
  return mediaStream
}

const TESSERACT_VERSION = '6.0.0'

interface TesseractScheduler {
  addWorker(worker: TesseractWorker): void
  addJob(job: string, data: OffscreenCanvas): Promise<{ data: { text: string; confidence: number } }>
}
interface TesseractWorker {
  setParameters(parameters: { tessedit_pageseg_mode: number; tessedit_char_whitelist: string }): Promise<void>
}
interface TesseractTypes {
  setLogging(logging: boolean): void
  createScheduler(): TesseractScheduler
  createWorker(
    lang: string,
    oem: string,
    options: {
      workerPath?: string
      langPath?: string
      corePath?: string
      logger?: (m: { status: string }) => void
      errorHandler?: (e: Error) => void
    },
  ): Promise<TesseractWorker>
  PSM: { SINGLE_LINE: number }
  OEM: { LSTM_ONLY: string }
}
declare const Tesseract: TesseractTypes

let tesseractData: Promise<{ scheduler: TesseractScheduler; worker: TesseractWorker }> | null = null

async function loadTesseract() {
  if (tesseractData) {
    return await tesseractData
  }
  const load = async () => {
    await loadScript('tesseract', `https://unpkg.com/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`)
    log('[e2e-video-stats]Creating Tesseract worker')
    try {
      Tesseract.setLogging(false)
      const scheduler = Tesseract.createScheduler()
      const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
        logger: (m: { status: string }) => {
          if (!m.status.startsWith('recognizing')) log(`[tesseract]`, m)
        },
        errorHandler: (e: Error) => {
          log(`[tesseract] error: ${e.message}`)
        },
      })
      await worker.setParameters({
        tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
        tessedit_char_whitelist: '0123456789-',
      })
      scheduler.addWorker(worker)
      log('[e2e-video-stats] Creating Tesseract worker done')
      return { scheduler, worker }
    } catch (err) {
      log(`Creating Tesseract worker error: ${(err as Error).message}`)
      throw err
    }
  }
  tesseractData = load()
  return await tesseractData
}

const processingVideoTracks = new Set<MediaStreamTrack>()

/**
 * recognizeVideoTimestampWatermark
 * @param {MediaStreamTrack} track
 * @param {number} measureInterval
 */
export async function recognizeVideoTimestampWatermark(track: MediaStreamTrack, measureInterval = 5) {
  if (track.readyState === 'ended' || track.kind !== 'video' || processingVideoTracks.has(track)) return
  processingVideoTracks.add(track)
  track.addEventListener('ended', () => processingVideoTracks.delete(track))
  log(`[e2e-video-stats] recognizeVideoTimestampWatermark ${track.id} ${track.label}`, track.getSettings())
  const { scheduler } = await loadTesseract()
  let lastTimestamp = 0

  const trackProcessor = new window.MediaStreamTrackProcessor({ track })
  const writableStream = new window.WritableStream(
    {
      async write(/** @type VideoFrame */ videoFrame) {
        const now = Date.now()
        const { timestamp, codedWidth, codedHeight } = videoFrame

        if (timestamp - lastTimestamp > measureInterval * 1000000 && codedWidth && codedHeight) {
          lastTimestamp = timestamp
          const textHeight = Math.max(Math.round(codedHeight / 15), 24)
          const bitmap = await createImageBitmap(videoFrame, 0, 0, codedWidth, textHeight)
          const canvas = new OffscreenCanvas(codedWidth, textHeight)
          const ctx = canvas.getContext('bitmaprenderer')!
          ctx.transferFromImageBitmap(bitmap)
          bitmap.close()

          scheduler
            .addJob('recognize', canvas)
            .then(async ({ data }) => {
              const cleanText = data.text.trim()
              if (cleanText && data.confidence > 50) {
                const recognizedTimestamp = parseInt(cleanText.split('-')[1])
                const delay = now - recognizedTimestamp
                if (isFinite(delay) && delay > 0 && delay < 30000) {
                  const elapsed = Date.now() - now
                  log(
                    `[e2e-video-stats] rx delay: ${delay.toFixed(2)}ms confidence: ${data.confidence} elapsed: ${elapsed.toFixed(2)}ms`,
                  )
                  if (await overrides.isReceiverDisplayTrack(track)) {
                    screenEndToEndDelayStats.push(now, delay / 1000)
                  } else {
                    videoEndToEndDelayStats.push(now, delay / 1000)
                  }
                }
              }
            })
            .catch((err: unknown) => {
              log(`[e2e-video-stats] recognizeVideoTimestampWatermark error: ${(err as Error).message}`)
            })
        }
        videoFrame.close()
      },
      close() {
        processingVideoTracks.delete(track)
      },
      abort(err) {
        log('WritableStream error:', err)
        processingVideoTracks.delete(track)
      },
    },
    new CountQueuingStrategy({ highWaterMark: 30 }),
  )
  trackProcessor.readable.pipeTo(writableStream).catch((err: unknown) => {
    log(`[e2e-video-stats]recognizeVideoTimestampWatermark error: ${(err as Error).message}`)
  })
}
