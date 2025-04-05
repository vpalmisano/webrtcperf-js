import { saveMediaTrack, stopSaveMediaTrack } from './save-tracks'
import { setAudioStartFrameTime } from './e2e-audio-stats'
import { setVideoStartFrameTime } from './e2e-video-stats'
import { getIndex, params } from './common'
import { elapsedTime } from './common'
import { enabledForSession, log } from './common'
import { saveTransceiversTracks, setTransceiversTracks, stopSaveTransceiversTracks } from './peer-connection'
import { syncFakeTracks } from './get-user-media'

let actionsStarted = false

const ACTIONS = {
  saveMediaTrack,
  stopSaveMediaTrack,
  setAudioStartFrameTime,
  setVideoStartFrameTime,
  saveTransceiversTracks,
  stopSaveTransceiversTracks,
  syncFakeTracks,
  setTransceiversTracks,
}

export async function setupActions() {
  if (!params.actions || actionsStarted) {
    return
  }
  actionsStarted = true

  const actions = params.actions
  actions
    .sort((a, b) => (a.at || 0) - (b.at || 0))
    .forEach((action) => {
      const { name, at, relaxedAt, every, times, index, params } = action

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (window as any)[name] || ACTIONS[name as keyof typeof ACTIONS]
      if (!fn) {
        log(`setupActions undefined action: "${name}"`)
        return
      }

      if (index !== undefined) {
        if (!enabledForSession(index)) {
          return
        }
      }

      const setupTime = elapsedTime()
      let startTime = at > 0 ? at * 1000 - setupTime : 0
      if (startTime < 0) {
        if (relaxedAt) {
          log(
            `setupActions action "${name}" already passed (setupTime: ${setupTime / 1000} at: ${at}), running immediately`,
          )
          startTime = 0
        } else {
          log(`setupActions action "${name}" already passed (setupTime: ${setupTime / 1000} at: ${at})`)
          if (every > 0) {
            startTime = Math.ceil(-startTime / (every * 1000)) * every * 1000 + startTime
          } else {
            return
          }
        }
      }
      log(
        `scheduling action ${name}(${params || ''}) at ${at}s${every ? ` every ${every}s` : ''}${
          times ? ` ${times} times` : ''
        } with startTime: ${startTime}ms setupTime: ${setupTime}ms`,
      )
      let currentIteration = 0
      const cb = async () => {
        const now = elapsedTime()
        const ts = (now / 1000).toFixed(0)
        log(
          `run action [${ts}s] ${name}(${params || ''})${every ? ` every ${every}s` : ''}${
            times ? ` (${times - currentIteration}/${times} times remaining)` : ''
          } (system time: ${Date.now()})`,
        )
        try {
          if (params && params.length) {
            await fn(...params)
          } else {
            await fn()
          }
          const elapsed = ((elapsedTime() - now) / 1000).toFixed(3)
          log(`run action [${ts}s] [${getIndex()}] ${name} done (${elapsed}s elapsed)`)
        } catch (err) {
          log(`run action [${ts}s] [${getIndex()}] ${name} error: ${(err as Error).message}`)
        } finally {
          currentIteration += 1
          if (every > 0 && currentIteration < (times || Infinity)) {
            setTimeout(cb, every * 1000)
          }
        }
      }
      setTimeout(cb, startTime)
    })
}
