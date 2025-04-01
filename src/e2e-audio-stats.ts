import { enabledForSession, log, params } from './common'
import { MeasuredStats } from './stats'

type GgwaveParameters = {
  sampleRateInp: number
  sampleRateOut: number
  operatingMode: number
  samplesPerFrame: number
}
interface Ggwave {
  disableLog(): void
  init(parameters: GgwaveParameters): number
  free(instance: number): void
  getDefaultParameters(): GgwaveParameters
  GGWAVE_OPERATING_MODE_TX: number
  GGWAVE_OPERATING_MODE_USE_DSS: number
  GGWAVE_OPERATING_MODE_RX: number
  ProtocolId: {
    GGWAVE_PROTOCOL_AUDIBLE_FAST: number
  }
  encode(instance: number, data: string, protocolId: number, frameDurationMs: number): Float32Array
  decode(instance: number, data: Int8Array): Uint8Array
  rxDurationFrames(instance: number): number
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ggwave_factory = require('@vpalmisano/ggwave') as () => Promise<Ggwave>

export const audioEndToEndDelayStats = new MeasuredStats({ ttl: 15 })

export const audioStartFrameDelayStats = new MeasuredStats({ ttl: 60 })
export let audioStartFrameTime: number | undefined

/**
 * It sets the start frame time used for calculating the startFrameDelay metric.
 * @param value The start frame time in seconds.
 */
export const setAudioStartFrameTime = (value: number) => {
  audioStartFrameTime = value
}

export const collectAudioEndToEndStats = () => {
  const delay = audioEndToEndDelayStats.mean()
  return {
    delay: audioEndToEndDelayStats.mean(),
    startFrameDelay:
      audioStartFrameDelayStats.size &&
      audioStartFrameTime !== undefined &&
      delay !== undefined &&
      delay > audioStartFrameTime
        ? delay - audioStartFrameTime
        : undefined,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertTypedArray(src: any, type: any) {
  const buffer = new ArrayBuffer(src.byteLength)
  new src.constructor(buffer).set(src)
  return new type(buffer)
}

export let ggwave: Ggwave | null = null

if (enabledForSession(params.timestampWatermarkAudio)) {
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      ggwave = await ggwave_factory()
      ggwave.disableLog()
    } catch (e) {
      log(`ggwave error: ${e}`)
    }
  })
}

let audioContext = null as AudioContext | null
let audioDestination = null as MediaStreamAudioDestinationNode | null

function initAudioTimestampWatermarkSender(interval = 5000) {
  if (audioContext || audioDestination || !ggwave) return
  log(`[e2e-audio-stats] initAudioTimestampWatermarkSender with interval ${interval}ms`)

  audioContext = new AudioContext({
    latencyHint: 'interactive',
    sampleRate: 48000,
  })
  audioDestination = audioContext.createMediaStreamDestination()
  const parameters = ggwave.getDefaultParameters()
  parameters.sampleRateInp = audioContext.sampleRate
  parameters.sampleRateOut = audioContext.sampleRate
  parameters.operatingMode = ggwave.GGWAVE_OPERATING_MODE_TX | ggwave.GGWAVE_OPERATING_MODE_USE_DSS
  const instance = ggwave.init(parameters)

  setInterval(() => {
    if (!audioContext || !audioDestination || !ggwave) return
    const now = Date.now()
    const waveform = ggwave.encode(instance, now.toString(), ggwave.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST, 10)
    const buf = convertTypedArray(waveform, Float32Array)
    const buffer = audioContext.createBuffer(1, buf.length, audioContext.sampleRate)
    buffer.copyToChannel(buf, 0)
    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioDestination)
    source.start()
  }, interval)
}

export function applyAudioTimestampWatermark(mediaStream: MediaStream) {
  if (mediaStream.getAudioTracks().length === 0) {
    return mediaStream
  }
  if (!audioContext || !audioDestination) {
    initAudioTimestampWatermarkSender()
  }
  const track = mediaStream.getAudioTracks()[0]
  log(`[e2e-audio-stats] applyAudioTimestampWatermark`, mediaStream.getAudioTracks()[0].id, '->', track.id)

  // Mix original track with watermark.
  const trackSource = audioContext!.createMediaStreamSource(new MediaStream([track]))
  const gain = audioContext!.createGain()
  gain.gain.value = 0.005
  trackSource.connect(gain)
  gain.connect(audioDestination!)

  track.addEventListener(
    'ended',
    () => {
      trackSource.disconnect(gain)
      if (audioDestination) gain.disconnect(audioDestination)
    },
    { once: true },
  )

  const newMediaStream = new MediaStream([
    audioDestination!.stream.getAudioTracks()[0].clone(),
    ...mediaStream.getVideoTracks(),
  ])

  return newMediaStream
}

const processingAudioTracks = new Set()

export function recognizeAudioTimestampWatermark(track: MediaStreamTrack) {
  if (processingAudioTracks.has(track) || processingAudioTracks.size > 10 || track.readyState === 'ended') return
  log(`[e2e-audio-stats] recognizeAudioTimestampWatermark ${track.id}`)
  processingAudioTracks.add(track)
  track.addEventListener('ended', () => {
    processingAudioTracks.delete(track)
  })

  const samplesPerFrame = 1024
  const buf = new Float32Array(samplesPerFrame)
  let bufIndex = 0
  let instance: number | null = null

  const writableStream = new window.WritableStream(
    {
      async write(audioFrame) {
        if (!ggwave) {
          audioFrame.close()
          return
        }

        const now = Date.now()
        const { numberOfFrames, sampleRate } = audioFrame
        if (instance === null) {
          const parameters = ggwave.getDefaultParameters()
          parameters.sampleRateInp = sampleRate
          parameters.sampleRateOut = sampleRate
          parameters.samplesPerFrame = samplesPerFrame
          parameters.operatingMode = ggwave.GGWAVE_OPERATING_MODE_RX | ggwave.GGWAVE_OPERATING_MODE_USE_DSS
          instance = ggwave.init(parameters)
          if (instance < 0) {
            log(`[e2e-audio-stats] recognizeAudioTimestampWatermark init failed: ${instance}`)
            return
          }
        }

        try {
          const tmp = new Float32Array(numberOfFrames)
          audioFrame.copyTo(tmp, { planeIndex: 0 })

          const addedFrames = Math.min(numberOfFrames, samplesPerFrame - bufIndex)
          buf.set(tmp.slice(0, addedFrames), bufIndex)
          bufIndex += numberOfFrames

          if (bufIndex < samplesPerFrame) return

          const res = ggwave.decode(instance, convertTypedArray(buf, Int8Array))
          buf.set(tmp.slice(addedFrames), 0)
          bufIndex = numberOfFrames - addedFrames

          if (res && res.length > 0) {
            const data = new TextDecoder('utf-8').decode(res)
            try {
              const ts = parseInt(data)
              const rxFrames = ggwave.rxDurationFrames(instance) + 4
              const rxFramesDuration = (rxFrames * 1000 * samplesPerFrame) / sampleRate
              const delay = now - ts - rxFramesDuration
              log(
                `[e2e-audio-stats] rx delay: ${delay}ms rxFrames: ${rxFrames} rxFramesDuration: ${rxFramesDuration}ms`,
              )
              if (isFinite(delay) && delay > 0 && delay < 30000) {
                audioEndToEndDelayStats.push(now, delay / 1000)
              }
            } catch (e) {
              log(`[e2e-audio-stats] rx failed to parse ${data}: ${(e as Error).message}`)
            }
          }
        } catch (err) {
          log(`[e2e-audio-stats] error: ${(err as Error).message}`)
        } finally {
          audioFrame.close()
        }
      },
      close() {
        processingAudioTracks.delete(track)
        if (instance && ggwave) ggwave.free(instance)
      },
      abort(err) {
        log('AudioTimestampWatermark error:', err)
        processingAudioTracks.delete(track)
      },
    },
    new CountQueuingStrategy({ highWaterMark: 100 }),
  )
  const trackProcessor = new window.MediaStreamTrackProcessor({ track })
  trackProcessor.readable.pipeTo(writableStream).catch((err: Error) => {
    log(`[e2e-audio-stats] recognizeAudioTimestampWatermark pipeTo error: ${err.message}`)
  })
}
