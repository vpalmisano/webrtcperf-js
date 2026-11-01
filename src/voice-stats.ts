import { MicVAD } from '@ricky0123/vad-web'
import { EventEmitter } from 'events'
import { log } from './common'
import { fakeStreamManager, setMedia, setMediaFromStorage } from './fake-stream'
import { getTransceiversTrack } from './peer-connection'
import { MeasuredStats } from './stats'

export type VoiceActivityDetectorOptions = {
  /** The audio track to detect voice activity on. */
  track: MediaStreamTrack
  /** Minimum talking duration in ms before emitting `start`. Defaults to 40. */
  minTalkingDurationMs?: number
  /** Minimum silent duration in ms before emitting `stop`. Defaults to 500. */
  minSilentDurationMs?: number
  /**
   * Voice activity detector backend.
   * - `'simple'`: amplitude-based detection (default).
   * - `'silero'`: Silero VAD model.
   */
  detector?: 'simple' | 'silero'
}

/**
 * Detects voice activity on an audio track and emits `start` / `stop` events.
 *
 * Events:
 * - `start` — `{ startTime: number, stopTime: number }` when speech begins (`stopTime` is 0).
 * - `stop` — `{ startTime: number, stopTime: number }` when speech ends.
 *
 * Calling {@link VoiceActivityDetector.start} is a no-op if already started, or if the track
 * is not a live audio track. Stopping the underlying track also stops the detector.
 *
 * @example
 * ```ts
 * const vad = new VoiceActivityDetector({ track })
 * vad.on('start', ({ startTime }) => console.log('started', startTime))
 * vad.on('stop', ({ startTime, stopTime }) => console.log('stopped', startTime, stopTime))
 * await vad.start()
 * // later
 * vad.stop()
 * ```
 */
export class VoiceActivityDetector extends EventEmitter {
  readonly track: MediaStreamTrack
  readonly minTalkingDurationMs: number
  readonly minSilentDurationMs: number
  readonly detector: 'simple' | 'silero'

  private cleanup: (reason?: string) => void = () => {}
  private started = false
  private originalTrackStop: MediaStreamTrack['stop'] | undefined

  constructor({
    track,
    minTalkingDurationMs = 40,
    minSilentDurationMs = 500,
    detector = 'simple',
  }: VoiceActivityDetectorOptions) {
    super()
    this.track = track
    this.minTalkingDurationMs = minTalkingDurationMs
    this.minSilentDurationMs = minSilentDurationMs
    this.detector = detector
  }

  /** Starts voice activity detection. */
  async start() {
    if (this.started) return
    const { track, minTalkingDurationMs, minSilentDurationMs, detector } = this
    if (track.kind !== 'audio' || track.readyState !== 'live') return

    this.started = true

    if (detector === 'silero') {
      let speechStartTime = 0
      const vad = await MicVAD.new({
        minSpeechMs: minTalkingDurationMs,
        redemptionMs: minSilentDurationMs,
        model: 'v6',
        baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/',
        onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/',
        getStream: async () => new MediaStream([track]),
        pauseStream: async () => {}, // don't stop the track
        resumeStream: async () => new MediaStream([track]),
        onSpeechStart: () => {
          speechStartTime = Date.now() - minTalkingDurationMs
          this.emit('start', { startTime: speechStartTime, stopTime: 0 })
        },
        onSpeechEnd: () => {
          const stopTime = Date.now() - minSilentDurationMs
          this.emit('stop', { startTime: speechStartTime, stopTime })
        },
      })
      if (!this.started) {
        vad.destroy().catch(() => {})
        return
      }
      vad.start()
      this.cleanup = () => {
        vad.destroy().catch(() => {})
      }
    } else {
      const audioCtx = new AudioContext({
        sampleRate: 48000,
      })
      const source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.8
      source.connect(analyser)
      if (audioCtx.state !== 'running') {
        audioCtx.resume().catch((err) => log('[VoiceActivityDetector] audioCtx resume error:', err))
      }

      const bufferLength = analyser.fftSize
      const dataArray = new Float32Array(bufferLength)

      let duration = 0
      let startTime = 0
      let stopTime = 0
      let talkingDuration = 0
      let talkingStartedAt = 0
      let silentDuration = 0
      let silentStartedAt = 0

      const { readable } = new window.MediaStreamTrackProcessor({ track })
      const controller = new AbortController()
      readable
        .pipeTo(
          new WritableStream({
            write: (audioFrame: AudioData) => {
              const { numberOfFrames, sampleRate } = audioFrame
              duration += (numberOfFrames / sampleRate) * 1_000_000
              audioFrame.close()
              if (audioCtx.state === 'running' && duration >= 20_000) {
                analyser.getFloatTimeDomainData(dataArray)
                const max = Math.max(...dataArray)
                const now = Date.now()
                if (max > 0.001) {
                  silentDuration = 0
                  silentStartedAt = 0
                  if (!startTime) {
                    if (!talkingStartedAt) {
                      talkingStartedAt = now
                    }
                    talkingDuration += duration
                    if (talkingDuration >= minTalkingDurationMs * 1000) {
                      startTime = talkingStartedAt
                      this.emit('start', { startTime, stopTime })
                      stopTime = 0
                      talkingDuration = 0
                      talkingStartedAt = 0
                    }
                  }
                } else if (max <= 0.001) {
                  talkingDuration = 0
                  talkingStartedAt = 0
                  if (startTime && !stopTime) {
                    if (!silentStartedAt) {
                      silentStartedAt = now
                    }
                    silentDuration += duration
                    if (silentDuration >= minSilentDurationMs * 1000) {
                      stopTime = silentStartedAt
                      this.emit('stop', { startTime, stopTime })
                      startTime = 0
                      silentDuration = 0
                      silentStartedAt = 0
                    }
                  }
                }
                duration = 0
              }
            },
            close: () => {
              this.stop('close')
            },
            abort: (reason) => {
              this.stop(reason)
            },
          }),
          { signal: controller.signal },
        )
        .catch((err) => err && log(`VoiceActivityDetector error: ${err.message}`))

      this.cleanup = (reason = '') => {
        if (audioCtx.state !== 'closed') {
          controller.abort(reason)
          source.disconnect()
          audioCtx.close()
        }
      }
    }

    this.originalTrackStop = track.stop.bind(track)
    track.stop = () => {
      this.originalTrackStop?.()
      this.stop('stop')
    }
  }

  /**
   * Stops voice activity detection and restores the track's original `stop` method.
   * @param reason - Optional abort reason forwarded to the underlying cleanup.
   */
  stop(reason = '') {
    if (!this.started) return
    this.started = false
    this.cleanup(reason)
    this.cleanup = () => {}
    if (this.originalTrackStop) {
      this.track.stop = this.originalTrackStop
      this.originalTrackStop = undefined
    }
  }
}

const questionAnswerDelay = new MeasuredStats({ ttl: 30 })

export function collectQuestionAnswerDelay() {
  return questionAnswerDelay.mean()
}

export type QuestionAnswerTurn = {
  mediaFile: string
  questionStartTime: number
  questionEndTime: number
  answerStartTime: number
  answerEndTime: number
  phase: 'question-start' | 'question-end' | 'answer-start' | 'answer-end' | 'answer-interrupted'
  answerInterruptedAt?: number
  answerTalkingAfterInterruption?: number
}

/**
 * Estimates the question-to-answer delay from voice activity on the send (question)
 * and receive (answer) sides.
 *
 * Provide either ready-made {@link VoiceActivityDetector} instances via `sendVad` /
 * `recvVad`, or the corresponding tracks (`sendTrack` / `recvTrack`) so detectors are
 * created and started for you. Track options are ignored when a VAD is supplied.
 *
 * @param options.sendTrack - Send (question) audio track. Required when `sendVad` is omitted.
 * @param options.recvTrack - Recv (answer) audio track. Required when `recvVad` is omitted.
 * @param options.minTalkingDurationMs - Minimum talking duration in ms to detect voice start. Defaults to 40.
 * @param options.minSilentDurationMs - Minimum silent duration in ms to detect voice stop. Defaults to 500.
 * @param options.detector - VAD backend for auto-created detectors: `'simple'` (default) or `'silero'`.
 * @param options.sendVad - Existing send-side detector. When provided it is not started or stopped by this function.
 * @param options.recvVad - Existing recv-side detector. When provided it is not started or stopped by this function.
 * @param options.callback - Called on each turn phase change (`question-start`, `question-end`, `answer-start`, `answer-end`, `answer-interrupted`).
 * @returns Cleanup function that stops only the detectors created by this call.
 */
export async function estimateQuestionAnswerDelay({
  sendTrack,
  recvTrack,
  minTalkingDurationMs = 40,
  minSilentDurationMs = 500,
  detector = 'simple',
  sendVad,
  recvVad,
  callback,
}: {
  sendTrack?: MediaStreamTrack
  recvTrack?: MediaStreamTrack
  minTalkingDurationMs?: number
  minSilentDurationMs?: number
  detector?: 'simple' | 'silero'
  sendVad?: VoiceActivityDetector
  recvVad?: VoiceActivityDetector
  callback?: (turn: QuestionAnswerTurn) => void
}) {
  let sendVadManaged = false
  let recvVadManaged = false

  if (!sendVad) {
    if (!sendTrack) throw new Error('sendTrack is required')
    sendVad = new VoiceActivityDetector({
      track: sendTrack,
      minTalkingDurationMs,
      minSilentDurationMs,
      detector,
    })
    sendVadManaged = true
  }

  if (!recvVad) {
    if (!recvTrack) throw new Error('recvTrack is required')
    recvVad = new VoiceActivityDetector({
      track: recvTrack,
      minTalkingDurationMs,
      minSilentDurationMs,
      detector,
    })
    recvVadManaged = true
  }

  log(`estimateQuestionAnswerDelay`)

  let currentTurn: QuestionAnswerTurn | undefined = undefined
  let previousTurn: QuestionAnswerTurn | undefined = undefined

  const sendVadStart = ({ startTime }: { startTime: number }) => {
    if (currentTurn?.phase === 'answer-start') {
      currentTurn.phase = 'answer-interrupted'
      currentTurn.answerInterruptedAt = startTime
    }
    previousTurn = currentTurn
    currentTurn = {
      mediaFile: (fakeStreamManager.url ?? '').split('/').pop() ?? '',
      questionStartTime: startTime,
      questionEndTime: 0,
      answerStartTime: 0,
      answerEndTime: 0,
      phase: 'question-start',
    }
    callback?.(currentTurn)
  }

  const sendVadStop = ({ stopTime }: { stopTime: number }) => {
    if (currentTurn?.phase === 'question-start') {
      currentTurn.questionEndTime = stopTime
      currentTurn.phase = 'question-end'
      callback?.(currentTurn)
    }
  }

  const recvVadStart = ({ startTime }: { startTime: number }) => {
    if (currentTurn?.phase === 'question-end' && startTime > currentTurn.questionEndTime) {
      currentTurn.answerStartTime = startTime
      currentTurn.phase = 'answer-start'
      const delay = (currentTurn.answerStartTime - currentTurn.questionEndTime) / 1000
      log(`estimateQuestionAnswerDelay delay: ${delay}s`)
      questionAnswerDelay.push(Date.now(), delay)
      callback?.(currentTurn)
    }
  }

  const recvVadStop = ({ stopTime }: { stopTime: number }) => {
    if (previousTurn?.phase === 'answer-interrupted') {
      previousTurn.answerEndTime = stopTime
      if (previousTurn.answerInterruptedAt) {
        previousTurn.answerTalkingAfterInterruption = Math.max(0, stopTime - previousTurn.answerInterruptedAt)
      }
      callback?.(previousTurn)
      previousTurn = undefined
    }
    if (currentTurn?.phase === 'answer-start') {
      currentTurn.answerEndTime = stopTime
      currentTurn.phase = 'answer-end'
      callback?.(currentTurn)
    }
  }

  sendVad.on('start', sendVadStart)
  sendVad.on('stop', sendVadStop)
  recvVad.on('start', recvVadStart)
  recvVad.on('stop', recvVadStop)

  if (sendVadManaged) {
    await sendVad.start()
  }
  if (recvVadManaged) {
    await recvVad.start()
  }

  return () => {
    log(`estimateQuestionAnswerDelay cleanup`)
    sendVad.off('start', sendVadStart)
    sendVad.off('stop', sendVadStop)
    recvVad.off('start', recvVadStart)
    recvVad.off('stop', recvVadStop)
    if (sendVadManaged) {
      sendVad.stop()
    }
    if (recvVadManaged) {
      recvVad.stop()
    }
  }
}

export type QuestionAnswerStats = {
  file: string
  question?: number
  delay?: number
  answer?: number
  answerAfterInterruption?: number
}

/**
 * Run a question answer test getting the send and recv tracks from the running transceivers.
 * It evaluates the time interval between the end of the question and the start of the answer.
 * When another question interrupts the current answer, it tracks the amount of time required
 * by the service to stop processing the previous answer and start with the new one.
 * @param mediaFiles - The media files to use for the test. It can be an array of URLs or an array of storage names or parts of the names.
 * @param sendTrackFilter - The filter function to use to filter the send track.
 * @param recvTrackFilter - The filter function to use to filter the recv track.
 * @param endTestCallback - The callback called when the test ends.
 * @returns The stop function to interrupt the test and the collected stats.
 */
export async function runQuestionAnswerTest(
  mediaFiles: string[],
  sendTrackFilter: (tranceiver: RTCRtpTransceiver, track: MediaStreamTrack, index: number) => Promise<boolean> = () =>
    Promise.resolve(true),
  recvTrackFilter: (tranceiver: RTCRtpTransceiver, track: MediaStreamTrack, index: number) => Promise<boolean> = () =>
    Promise.resolve(true),
  interruptAnswerAfter = 0,
  endTestCallback?: (stats: QuestionAnswerStats[]) => void,
) {
  log(`runQuestionAnswerTest mediaFiles: ${mediaFiles.length} interruptAnswerAfter: ${interruptAnswerAfter}`)
  const files = mediaFiles.slice()
  const stats: QuestionAnswerStats[] = []
  const sendTrack = await getTransceiversTrack('send', 'audio', sendTrackFilter)
  const recvTrack = await getTransceiversTrack('recv', 'audio', recvTrackFilter)
  let currentFile = ''
  let nextFileTimeout: ReturnType<typeof setTimeout> | undefined = undefined

  fakeStreamManager.stopMedia()
  fakeStreamManager.muted = false
  fakeStreamManager.volume = 1.0

  const nextFile = async () => {
    if (files.length) {
      currentFile = files.splice(0, 1)[0]
      if (currentFile.startsWith('http://') || currentFile.startsWith('https://')) {
        await setMedia(currentFile)
      } else {
        await setMediaFromStorage(currentFile)
      }
    } else {
      stop?.()
      endTestCallback?.(stats)
      fakeStreamManager.stopMedia()
      fakeStreamManager.muted = true
      fakeStreamManager.volume = 1.0
      log('runQuestionAnswerTest ended', stats)
    }
  }

  const stop = await estimateQuestionAnswerDelay({
    sendTrack,
    recvTrack,
    minTalkingDurationMs: 40,
    minSilentDurationMs: 1000,
    callback: async (turn) => {
      const file = turn.mediaFile
      log(`runQuestionAnswerTest "${file}" turn phase: ${turn.phase}`)
      if (turn.phase === 'answer-start' && interruptAnswerAfter > 0 && files.length) {
        if (nextFileTimeout) {
          clearTimeout(nextFileTimeout)
        }
        nextFileTimeout = setTimeout(() => nextFile(), interruptAnswerAfter * 1000)
      } else if (['answer-end', 'answer-interrupted'].includes(turn.phase)) {
        const question = turn.questionEndTime - turn.questionStartTime
        const delay = turn.answerStartTime - turn.questionEndTime
        const answer = turn.answerEndTime - turn.answerStartTime
        const answerAfterInterruption = turn.answerTalkingAfterInterruption
        log(
          `runQuestionAnswerTest "${file}" question: ${question / 1000}s delay: ${delay / 1000}s answer: ${answer / 1000}s` +
            `${answerAfterInterruption ? ` after interruption: ${answerAfterInterruption / 1000}s` : ''}`,
        )
        stats.push({ file, question, delay, answer, answerAfterInterruption })
        if (turn.phase === 'answer-end') {
          if (nextFileTimeout) {
            clearTimeout(nextFileTimeout)
          }
          await nextFile()
        }
      }
    },
  })
  await nextFile()
  return { stop, stats }
}
