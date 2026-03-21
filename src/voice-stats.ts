import { log } from './common'

/**
 * It detects voice activity on an audio track and calls the callback with the start and stop times.
 * @param track - The track to detect voice activity on.
 * @param lowThreshold - The low threshold to detect voice stop.
 * @param highThreshold - The high threshold to detect voice start.
 * @param callback - The callback to call with the start and stop times.
 * @returns The cleanup function to stop the detection.
 */
export function detectVoiceActivity(
  track: MediaStreamTrack,
  lowThreshold = 0.001,
  highThreshold = 0.1,
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
  source.connect(analyser)

  const bufferLength = analyser.fftSize
  const dataArray = new Float32Array(bufferLength)

  let startTime = 0
  let stopTime = 0

  const { readable } = new window.MediaStreamTrackProcessor({ track })
  const controller = new AbortController()
  readable
    .pipeTo(
      new WritableStream({
        write(audioFrame: AudioData) {
          if (audioCtx.state === 'running') {
            analyser.getFloatTimeDomainData(dataArray)
            const max = Math.max(...dataArray)
            const now = Date.now()
            if (max > highThreshold && !startTime) {
              startTime = now
              if (stopTime) {
                log(
                  `voice started track id: ${track.id} max: ${max} at ${startTime} silence duration: ${startTime - stopTime}ms`,
                )
                callback?.('start', startTime, stopTime)
              }
              stopTime = 0
            } else if (max <= lowThreshold && startTime && !stopTime && now - startTime > 100) {
              stopTime = now
              log(
                `voice stopped track id: ${track.id} max: ${max} at ${stopTime} voice duration: ${stopTime - startTime}ms`,
              )
              callback?.('stop', startTime, stopTime)
              startTime = 0
            }
          }
          audioFrame.close()
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
    .catch((err) => log(`detectVoiceActivity error: ${err.message}`))

  const cleanup = (reason = 'unknown') => {
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

/**
 * Estimates the answer delay between two audio tracks.
 * The estimation is based on the voice activity detection between the two tracks.
 * @param sendTrack - The send track to estimate the answer delay.
 * @param recvTrack - The recv track to estimate the answer delay.
 * @returns The cleanup function to stop the estimation.
 */
export function estimateAnswerDelay(sendTrack: MediaStreamTrack, recvTrack: MediaStreamTrack) {
  if (sendTrack.kind !== 'audio' || recvTrack.kind !== 'audio') return

  log(`estimateAnswerDelay sendTrack id: ${sendTrack.id} recvTrack id: ${recvTrack.id}`)

  let sendEndTime = 0
  let recvStartTime = 0

  const cleanupSend = detectVoiceActivity(sendTrack, 0.001, 0.1, (event, _startTime, stopTime) => {
    if (event === 'stop') {
      sendEndTime = stopTime
    }
  })
  const cleanupRecv = detectVoiceActivity(recvTrack, 0.001, 0.1, (event, startTime) => {
    if (event === 'start') {
      recvStartTime = startTime
    }
    if (sendEndTime && recvStartTime && recvStartTime > sendEndTime) {
      const delay = (recvStartTime - sendEndTime) / 1000
      log(`estimateAnswerDelay delay: ${delay}s`)
      sendEndTime = 0
      recvStartTime = 0
    }
  })

  return () => {
    cleanupSend?.()
    cleanupRecv?.()
  }
}
