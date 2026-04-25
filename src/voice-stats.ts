import { log } from './common'
import { setMedia, setMediaFromStorage } from './fake-stream'
import { getTransceiversTrack } from './peer-connection'
import { MeasuredStats } from './stats'

/**
 * It detects voice activity on an audio track and calls the callback with the start and stop times.
 * @param track - The track to detect voice activity on.
 * @param minTalkingDurationMs - The minimum talking duration in milliseconds to detect voice start.
 * @param minSilentDurationMs - The minimum silent duration in milliseconds to detect voice stop.
 * @param callback - The callback to call with the start and stop times.
 * @returns The cleanup function to stop the detection.
 */
export function detectVoiceActivity(
  track: MediaStreamTrack,
  minTalkingDurationMs = 40,
  minSilentDurationMs = 500,
  callback?: (event: 'start' | 'stop', startTime: number, stopTime: number) => void,
) {
  if (track.kind !== 'audio' || track.readyState !== 'live') return
  log(`detectVoiceActivity track id: ${track.id}`)
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
                  log(`detectVoiceActivity voice started track id: ${track.id} at ${startTime}`)
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
                  log(
                    `detectVoiceActivity voice stopped track id: ${track.id} at ${stopTime} duration: ${stopTime - startTime}ms`,
                  )
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

  const cleanup = (reason = '') => {
    if (audioCtx.state !== 'closed') {
      log(`detectVoiceActivity track id: ${track.id} cleanup reason: ${reason}`)
      controller.abort(reason)
      source.disconnect()
      audioCtx.close()
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

/**
 * Estimates the question to answer delay.
 * The estimation is based on the voice activity detection between the question and answer audio tracks.
 * @param sendTrack - The send track to estimate the answer delay.
 * @param recvTrack - The recv track to estimate the answer delay.
 * @param minTalkingDurationMs - The minimum talking duration in milliseconds to detect voice start.
 * @param minSilentDurationMs - The minimum silent duration in milliseconds to detect voice stop.
 * @param callback - The callback called at the end of the question and answer.
 * @returns The cleanup function to stop the estimation.
 */
export function estimateQuestionAnswerDelay(
  sendTrack: MediaStreamTrack,
  recvTrack: MediaStreamTrack,
  minTalkingDurationMs = 40,
  minSilentDurationMs = 500,
  callback?: (question: { startTime: number; endTime: number }, answer: { startTime: number; endTime: number }) => void,
) {
  if (sendTrack.kind !== 'audio' || recvTrack.kind !== 'audio') return

  log(`estimateQuestionAnswerDelay sendTrack id: ${sendTrack.id} recvTrack id: ${recvTrack.id}`)

  let sendStartTime = 0
  let sendEndTime = 0
  let recvStartTime = 0
  let recvEndTime = 0
  let delay = 0

  const cleanupSend = detectVoiceActivity(sendTrack, minTalkingDurationMs, 500, (event, startTime, stopTime) => {
    if (event === 'start') {
      sendStartTime = startTime
      sendEndTime = 0
    } else if (event === 'stop' && sendStartTime) {
      sendEndTime = stopTime
    }
  })
  const cleanupRecv = detectVoiceActivity(recvTrack, 40, minSilentDurationMs, (event, startTime, stopTime) => {
    if (!sendStartTime || !sendEndTime) return
    if (event === 'start' && startTime > sendEndTime) {
      recvStartTime = startTime
      delay = (recvStartTime - sendEndTime) / 1000
      log(`estimateQuestionAnswerDelay delay: ${delay}s`)
      questionAnswerDelay.push(Date.now(), delay)
    } else if (event === 'stop' && recvStartTime) {
      recvEndTime = stopTime
      const question = { startTime: sendStartTime, endTime: sendEndTime }
      const answer = { startTime: recvStartTime, endTime: recvEndTime }
      sendStartTime = 0
      sendEndTime = 0
      recvStartTime = 0
      recvEndTime = 0
      delay = 0
      callback?.(question, answer)
    }
  })

  return () => {
    log(`estimateQuestionAnswerDelay cleanup sendTrack id: ${sendTrack.id} recvTrack id: ${recvTrack.id}`)
    cleanupSend?.()
    cleanupRecv?.()
  }
}

export type QuestionAnswerStats = { file: string; question: number; delay: number; answer: number }

/**
 * Run a question answer test getting the send and recv tracks from the running transceivers.
 * @param mediaFiles - The media files to use for the test. It can be an array of URLs or an array of storage names or parts of the names.
 * @param sendTrackIndex - The index of the send track. Use this to get a specific send track from the running transceivers.
 * @param recvTrackIndex - The index of the recv track. Use this to get a specific recv track from the running transceivers.
 * @param endTestCallback - The callback called when the test ends.
 * @returns The stop function to interrupt the test and the collected stats.
 */
export async function runQuestionAnswerTest(
  mediaFiles: string[],
  sendTrackIndex = 0,
  recvTrackIndex = 0,
  endTestCallback?: (stats: QuestionAnswerStats[]) => void,
) {
  log(
    `runQuestionAnswerTest mediaFiles: ${mediaFiles.length} sendTrackIndex: ${sendTrackIndex} recvTrackIndex: ${recvTrackIndex}`,
  )
  const files = mediaFiles.slice()
  const stats: QuestionAnswerStats[] = []
  const sendTrack = await getTransceiversTrack('send', 'audio', sendTrackIndex)
  const recvTrack = await getTransceiversTrack('recv', 'audio', recvTrackIndex)
  let currentFile = files.splice(0, 1)[0]

  const setCurrentFile = async () => {
    if (currentFile.startsWith('http://') || currentFile.startsWith('https://')) {
      await setMedia(currentFile)
    } else {
      await setMediaFromStorage(currentFile)
    }
  }

  const stop = estimateQuestionAnswerDelay(sendTrack, recvTrack, 40, 1000, async (send, recv) => {
    const question = send.endTime - send.startTime
    const delay = recv.startTime - send.endTime
    const answer = recv.endTime - recv.startTime
    log(
      `runQuestionAnswerTest file: ${currentFile} question: ${question / 1000}s delay: ${delay / 1000}s answer: ${answer / 1000}s`,
    )
    stats.push({ file: currentFile, question, delay, answer })
    if (files.length) {
      currentFile = files.splice(0, 1)[0]
      await setCurrentFile()
    } else {
      stop?.()
      endTestCallback?.(stats)
    }
  })
  await setCurrentFile()
  return { stop, stats }
}
