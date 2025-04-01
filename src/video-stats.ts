import { log, enabledForSession, params } from './common'
import { MeasuredStats } from './stats'
import { Timer } from './timers'

export const videoStats = {
  collectedVideos: new Map<HTMLVideoElement, { playingTimer: Timer; bufferingTimer: Timer }>(),
  bufferedTime: new MeasuredStats({ ttl: 15 }),
  width: new MeasuredStats({ ttl: 15 }),
  height: new MeasuredStats({ ttl: 15 }),
  playingTime: new MeasuredStats({ ttl: 15 }),
  bufferingTime: new MeasuredStats({ ttl: 15 }),
  bufferingEvents: new MeasuredStats({ ttl: 15 }),

  scheduleNext(timeout = 2000) {
    setTimeout(() => {
      try {
        this.update()
      } catch (e) {
        log('VideoStats error', e)
      }
    }, timeout)
  },
  watchVideo(video: HTMLVideoElement) {
    if (this.collectedVideos.has(video)) return
    log('VideoStats watchVideo', video)
    const playingTimer = new Timer()
    const bufferingTimer = new Timer()
    this.collectedVideos.set(video, { playingTimer, bufferingTimer })
    video.addEventListener(
      'play',
      () => {
        playingTimer.start()
        bufferingTimer.stop()
      },
      { once: true },
    )
    video.addEventListener('playing', () => {
      playingTimer.start()
      bufferingTimer.stop()
    })
    video.addEventListener('waiting', () => {
      playingTimer.stop()
      bufferingTimer.start()
    })
  },
  update() {
    const now = Date.now()
    document.querySelectorAll('video').forEach((el) => this.watchVideo(el))
    const entries = Array.from(this.collectedVideos.entries()).filter(([video]) => !!video.src && !video.ended)
    if (entries.length) {
      const arrayAverage = (
        cb: (video: HTMLVideoElement, stats: { playingTimer: Timer; bufferingTimer: Timer }) => number,
      ) => entries.reduce((acc, entry) => acc + cb(...entry), 0) / entries.length

      this.bufferedTime.push(
        now,
        arrayAverage((video) => {
          if (video.buffered.length) {
            return Math.max(video.buffered.end(video.buffered.length - 1) - video.currentTime, 0)
          }
          return 0
        }),
      )
      this.width.push(
        now,
        arrayAverage((video) => video.videoWidth),
      )
      this.height.push(
        now,
        arrayAverage((video) => video.videoHeight),
      )
      this.playingTime.push(
        now,
        arrayAverage((_video, stats) => stats.playingTimer.duration),
      )
      this.bufferingTime.push(
        now,
        arrayAverage((_video, stats) => stats.bufferingTimer.duration),
      )
      this.bufferingEvents.push(
        now,
        arrayAverage((_video, stats) => stats.bufferingTimer.startEvents),
      )
    }
    this.scheduleNext()
  },
  collect() {
    return {
      bufferedTime: this.bufferedTime.mean(),
      width: this.width.mean(),
      height: this.height.mean(),
      playingTime: this.playingTime.mean(),
      bufferingTime: this.bufferingTime.mean(),
      bufferingEvents: this.bufferingEvents.mean(),
    }
  },
}

export function collectVideoStats() {
  return videoStats.collect()
}

document.addEventListener('DOMContentLoaded', () => {
  if (enabledForSession(params.enableVideoStats)) {
    videoStats.scheduleNext()
  }
})
