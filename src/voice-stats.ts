import { MicVAD } from '@ricky0123/vad-web'
import { log } from './common'
import { fakeStreamManager, setMedia, setMediaFromStorage } from './fake-stream'
import { getTransceiversTrack } from './peer-connection'
import { MeasuredStats } from './stats'

/**
 * It detects voice activity on an audio track and calls the callback with the start and stop times.
 * @param options.track - The track to detect voice activity on.
 * @param options.minTalkingDurationMs - The minimum talking duration in milliseconds to detect voice start.
 * @param options.minSilentDurationMs - The minimum silent duration in milliseconds to detect voice stop.
 * @param options.detector - The silence detector to use: 'simple' or 'silero'.
 *   - 'simple' uses the amplitude of the audio to detect voice activity.
 *   - 'silero' uses the silero VAD model to detect voice activity.
 * @param options.callback - The callback to call with the start and stop times.
 * @returns The cleanup function to stop the detection.
 */
export async function detectVoiceActivity({
  track,
  minTalkingDurationMs = 40,
  minSilentDurationMs = 500,
  detector = 'simple',
  callback,
}: {
  track: MediaStreamTrack
  minTalkingDurationMs?: number
  minSilentDurationMs?: number
  detector?: 'simple' | 'silero'
  callback?: (event: 'start' | 'stop', startTime: number, stopTime: number) => void
}) {
  if (track.kind !== 'audio' || track.readyState !== 'live') return
  let cleanup: (reason?: string) => void = () => {}
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
        speechStartTime = Date.now()
        callback?.('start', speechStartTime, 0)
      },
      onSpeechEnd: () => {
        const stopTime = Date.now() - minSilentDurationMs
        callback?.('stop', speechStartTime, stopTime)
      },
    })
    vad.start()
    cleanup = () => {
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
      audioCtx.resume().catch((err) => log('[detectVoiceActivity] audioCtx resume error:', err))
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
          write(audioFrame: AudioData) {
            const { numberOfFrames, sampleRate } = audioFrame
            duration += (numberOfFrames / sampleRate) * 1_000_000
            audioFrame.close()
            if (audioCtx.state === 'running' && duration >= 20_000) {
              analyser.getFloatTimeDomainData(dataArray)
              const max = Math.max(...dataArray)
              const now = Date.now()
              if (max > 0.1) {
                silentDuration = 0
                silentStartedAt = 0
                if (!startTime) {
                  if (!talkingStartedAt) {
                    talkingStartedAt = now
                  }
                  talkingDuration += duration
                  if (talkingDuration >= minTalkingDurationMs * 1000) {
                    startTime = talkingStartedAt
                    callback?.('start', startTime, stopTime)
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
                    callback?.('stop', startTime, stopTime)
                    startTime = 0
                    silentDuration = 0
                    silentStartedAt = 0
                  }
                }
              }
              duration = 0
            }
          },
          close() {
            cleanup('close')
          },
          abort(reason) {
            cleanup(reason)
          },
        }),
        { signal: controller.signal },
      )
      .catch((err) => err && log(`detectVoiceActivity error: ${err.message}`))

    cleanup = (reason = '') => {
      if (audioCtx.state !== 'closed') {
        controller.abort(reason)
        source.disconnect()
        audioCtx.close()
      }
    }
  }

  const trackStop = track.stop.bind(track)
  track.stop = () => {
    trackStop()
    cleanup('stop')
  }

  return cleanup
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
 * Estimates the question to answer delay.
 * The estimation is based on the voice activity detection between the question and answer audio tracks.
 * @param options.sendTrack - The send track to estimate the answer delay.
 * @param options.recvTrack - The recv track to estimate the answer delay.
 * @param options.minTalkingDurationMs - The minimum talking duration in milliseconds to detect voice start.
 * @param options.minSilentDurationMs - The minimum silent duration in milliseconds to detect voice stop.
 * @param options.detector - The silence detector to use: 'simple' or 'silero'.
 *   - 'simple' uses the amplitude of the audio to detect voice activity.
 *   - 'silero' uses the silero VAD model to detect voice activity.
 * @param options.callback - The callback called at the end of the question and answer.
 * @returns The cleanup function to stop the estimation.
 */
export async function estimateQuestionAnswerDelay({
  sendTrack,
  recvTrack,
  minTalkingDurationMs = 40,
  minSilentDurationMs = 500,
  detector = 'simple',
  callback,
}: {
  sendTrack: MediaStreamTrack
  recvTrack: MediaStreamTrack
  minTalkingDurationMs?: number
  minSilentDurationMs?: number
  detector?: 'simple' | 'silero'
  callback?: (turn: QuestionAnswerTurn) => void
}) {
  if (sendTrack.kind !== 'audio' || recvTrack.kind !== 'audio') return

  log(`estimateQuestionAnswerDelay sendTrack id: ${sendTrack.id} recvTrack id: ${recvTrack.id}`)

  let currentTurn: QuestionAnswerTurn | undefined = undefined
  let previousTurn: QuestionAnswerTurn | undefined = undefined

  const cleanupSend = await detectVoiceActivity({
    track: sendTrack,
    minTalkingDurationMs,
    minSilentDurationMs: 500,
    detector,
    callback: (event, startTime, stopTime) => {
      if (event === 'start') {
        if (currentTurn?.phase === 'answer-start') {
          currentTurn.phase = 'answer-interrupted'
          currentTurn.answerInterruptedAt = Date.now()
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
      } else if (event === 'stop' && currentTurn?.phase === 'question-start') {
        currentTurn.questionEndTime = stopTime
        currentTurn.phase = 'question-end'
        callback?.(currentTurn)
      }
    },
  })
  const cleanupRecv = await detectVoiceActivity({
    track: recvTrack,
    minTalkingDurationMs: 40,
    minSilentDurationMs,
    detector,
    callback: (event, startTime, stopTime) => {
      if (event === 'start' && currentTurn?.phase === 'question-end' && startTime > currentTurn.questionEndTime) {
        currentTurn.answerStartTime = startTime
        currentTurn.phase = 'answer-start'
        const delay = (currentTurn.answerStartTime - currentTurn.questionEndTime) / 1000
        log(`estimateQuestionAnswerDelay delay: ${delay}s`)
        questionAnswerDelay.push(Date.now(), delay)
        callback?.(currentTurn)
      } else if (event === 'stop') {
        if (previousTurn?.phase === 'answer-interrupted') {
          previousTurn.answerEndTime = stopTime
          previousTurn.answerTalkingAfterInterruption = Date.now() - previousTurn.answerInterruptedAt!
          callback?.(previousTurn)
          previousTurn = undefined
        }
        if (currentTurn?.phase === 'answer-start') {
          currentTurn.answerEndTime = stopTime
          currentTurn.phase = 'answer-end'
          callback?.(currentTurn)
        }
      }
    },
  })

  return () => {
    log(`estimateQuestionAnswerDelay cleanup sendTrack id: ${sendTrack.id} recvTrack id: ${recvTrack.id}`)
    cleanupSend?.()
    cleanupRecv?.()
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
