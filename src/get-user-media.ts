import { config, enabledForSession, log, overrides, params, sleep } from './common'
import { applyAudioTimestampWatermark } from './e2e-audio-stats'
import { applyVideoTimestampWatermark } from './e2e-video-stats'

async function applyGetDisplayMediaCrop(mediaStream: MediaStream) {
  if (!config.GET_DISPLAY_MEDIA_CROP) return
  const element = document.querySelector(config.GET_DISPLAY_MEDIA_CROP) as HTMLElement
  const videoTrack = mediaStream.getVideoTracks()[0]
  if (element && videoTrack) {
    if ('RestrictionTarget' in window) {
      log(`applyGetDisplayMediaCrop with RestrictionTarget to "${config.GET_DISPLAY_MEDIA_CROP}"`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const restrictionTarget = await (window as any).RestrictionTarget.fromElement(element)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (videoTrack as any).restrictTo(restrictionTarget)
    } else {
      log(`applyGetDisplayMediaCrop to "${config.GET_DISPLAY_MEDIA_CROP}"`)
      element.style.zIndex = '99999'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cropTarget = await (window as any).CropTarget.fromElement(element)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (videoTrack as any).cropTo(cropTarget)
    }
  }
}

/**
 * Set of audio tracks collected from getUserMedia or getDisplayMedia.
 */
const audioTracks = new Set<MediaStreamTrack>()

/**
 * Set of video tracks collected from getUserMedia.
 */
const videoTracks = new Set<MediaStreamTrack>()

/**
 * Get the active audio tracks collected from getUserMedia or getDisplayMedia.
 * @return {MediaStreamTrack[]} The active audio tracks array.
 */
export const getActiveAudioTracks = () => {
  cleanupClosedMediaTracks()
  return [...audioTracks.values()]
}

/**
 * Get the active video tracks collected from getUserMedia or getDisplayMedia.
 * @return {MediaStreamTrack[]} The active video tracks array.
 */
export const getActiveVideoTracks = () => {
  cleanupClosedMediaTracks()
  return [...videoTracks.values()]
}

/**
 * Cleanup the closed media tracks.
 */
function cleanupClosedMediaTracks() {
  for (const track of audioTracks.values()) {
    if (track.readyState === 'ended') {
      audioTracks.delete(track)
    }
  }
  for (const track of videoTracks.values()) {
    if (track.readyState === 'ended') {
      videoTracks.delete(track)
    }
  }
}

/**
 * It collects MediaTracks from MediaStream.
 * @param {MediaStream} mediaStream
 */
function collectMediaTracks(mediaStream: MediaStream, onEnded?: (track: MediaStreamTrack) => void) {
  const aTracks = mediaStream.getAudioTracks()
  if (aTracks.length) {
    const track = aTracks[0]
    if (track.readyState !== 'ended') {
      /* webrtcperf.log(`MediaStream new audio track ${track.id}`); */
      track.addEventListener(
        'ended',
        () => {
          audioTracks.delete(track)
          if (onEnded) {
            onEnded(track)
          }
        },
        { once: true },
      )
      audioTracks.add(track)
    }
  }
  const vTracks = mediaStream.getVideoTracks()
  if (vTracks.length) {
    const track = vTracks[0]
    if (track.readyState !== 'ended') {
      /* const settings = track.getSettings() */
      /* webrtcperf.log(`MediaStream new video track ${track.id} ${
        settings.width}x${settings.height} ${settings.frameRate}fps`); */
      const nativeApplyConstraints = track.applyConstraints.bind(track)
      track.applyConstraints = (constraints) => {
        log(`applyConstraints ${track.id} (${track.kind})`, { track, constraints })
        if (overrides.trackApplyConstraints) {
          constraints = overrides.trackApplyConstraints(track, constraints)
          log(`applyConstraints ${track.id} (${track.kind}) override:`, { track, constraints })
        }
        return nativeApplyConstraints(constraints)
      }
      track.addEventListener(
        'ended',
        () => {
          videoTracks.delete(track)
          if (onEnded) {
            onEnded(track)
          }
        },
        { once: true },
      )
      videoTracks.add(track)
    }
  }
  cleanupClosedMediaTracks()
  // Log applyConstraints calls.
  mediaStream.getTracks().forEach((track) => {
    const applyConstraintsNative = track.applyConstraints.bind(track)
    track.applyConstraints = (constraints) => {
      log(`applyConstraints ${track.id} (${track.kind})`, { track, constraints })
      if (overrides.trackApplyConstraints) {
        constraints = overrides.trackApplyConstraints(track, constraints)
      }
      return applyConstraintsNative(constraints)
    }
  })
}

export class FakeStream {
  private refcount = 0
  private readonly element: HTMLVideoElement | HTMLAudioElement
  private readonly streamPromise: Promise<MediaStream>

  constructor(url: string, elementType = 'video') {
    log(`[FakeStream] new ${url}`)
    this.element = document.createElement(elementType === 'video' ? 'video' : 'audio')
    this.element.src = url
    this.element.loop = true
    this.element.crossOrigin = 'anonymous'
    this.element.autoplay = true
    this.element.muted = true
    this.streamPromise = this.createStream()
  }

  private createStream() {
    return new Promise<MediaStream>((resolve, reject) => {
      this.element.addEventListener(
        'loadeddata',
        () => {
          log(`[FakeStream] Create stream done`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          resolve((this.element as any).captureStream() as MediaStream)
        },
        { once: true },
      )
      this.element.addEventListener(
        'error',
        (err) => {
          log(`[FakeStream] Create stream error:`, err)
          reject(err)
        },
        { once: true },
      )
      this.element.play()
    })
  }

  getTrack(kind: 'audio' | 'video') {
    return this.streamPromise.then((stream) => {
      const track = stream.getTracks().find((track) => track.kind === kind)
      if (!track) {
        throw new Error(`[FakeStream] track ${kind} not found`)
      }
      const clonedTrack = track.clone()
      const clonedTrackStop = clonedTrack.stop.bind(clonedTrack)
      clonedTrack.stop = () => {
        clonedTrackStop()
        this.decRefcount()
      }
      this.incRefcount()
      log(`[FakeStream] getTrack ${kind}: ${clonedTrack.id} count: ${this.refcount}`)
      return clonedTrack
    })
  }

  sync(currentTime?: number) {
    if (currentTime !== undefined) {
      this.element.currentTime = currentTime
    }
    this.element.play()
  }

  private incRefcount() {
    this.refcount++
    if (this.element.paused) {
      this.element.play()
    }
  }

  private decRefcount() {
    this.refcount = Math.max(this.refcount - 1, 0)
    if (this.refcount === 0) {
      this.element.pause()
    }
  }
}

export const fakeStreams = {
  media: null as FakeStream | null,
  audio: null as FakeStream | null,
  video: null as FakeStream | null,
}

/**
 * Synchronizes all the created fake tracks.
 * @param {number | undefined} [currentTime] - If specified, the current time to set.
 */
export function syncFakeTracks(currentTime?: number) {
  for (const kind of ['audio', 'video']) {
    const stream = fakeStreams[kind as keyof typeof fakeStreams]
    stream?.sync(currentTime)
  }
  fakeStreams.media?.sync(currentTime)
}

export const getFakeTrack = async (kind: 'audio' | 'video') => {
  if (config.MEDIA_URL && !fakeStreams.media) {
    fakeStreams.media = new FakeStream(config.MEDIA_URL)
  } else if (kind === 'video' && config.VIDEO_URL && !fakeStreams.video) {
    fakeStreams.video = new FakeStream(config.VIDEO_URL, kind)
  } else if (kind === 'audio' && config.AUDIO_URL && !fakeStreams.audio) {
    fakeStreams.audio = new FakeStream(config.AUDIO_URL, kind)
  }
  const stream = fakeStreams.media || (kind === 'video' ? fakeStreams.video : fakeStreams.audio)
  if (!stream) {
    throw new Error(`[getFakeTrack] stream not found`)
  }
  return stream.getTrack(kind)
}

if ('getUserMedia' in navigator) {
  const nativeGetUserMedia = (
    navigator.getUserMedia as (constraints: MediaStreamConstraints, ...args: unknown[]) => Promise<MediaStream>
  ).bind(navigator)
  navigator.getUserMedia = async function (constraints: MediaStreamConstraints, ...args: unknown[]) {
    log(`getUserMedia:`, constraints)
    if (overrides.getUserMedia) {
      constraints = overrides.getUserMedia(constraints)
      log(`getUserMedia override:`, JSON.stringify(constraints))
    }
    return nativeGetUserMedia(constraints, ...args)
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getUserMedia = async function (constraints) {
    log(`getUserMedia:`, JSON.stringify(constraints))
    if (overrides.getUserMedia) {
      constraints = overrides.getUserMedia(constraints)
      log(`getUserMedia override:`, JSON.stringify(constraints))
    }
    if (params.getUserMediaWaitTime > 0) {
      await sleep(params.getUserMediaWaitTime)
    }

    let mediaStream = new MediaStream()

    if (constraints?.audio && (config.AUDIO_URL || config.MEDIA_URL)) {
      const audioTrack = await getFakeTrack('audio')
      mediaStream.addTrack(audioTrack)
    }
    if (constraints?.video && (config.VIDEO_URL || config.MEDIA_URL)) {
      const videoTrack = await getFakeTrack('video')
      mediaStream.addTrack(videoTrack)
    }
    if (mediaStream.getTracks().length > 0) {
      syncFakeTracks(0)
    } else {
      mediaStream = await nativeGetUserMedia(constraints)
    }

    if (overrides.getUserMediaStream) {
      try {
        mediaStream = await overrides.getUserMediaStream(mediaStream)
      } catch (err) {
        log(`overrideGetUserMediaStream error:`, err)
      }
    }

    if (enabledForSession(params.timestampWatermarkAudio)) {
      mediaStream = applyAudioTimestampWatermark(mediaStream)
    }
    if (enabledForSession(params.timestampWatermarkVideo)) {
      mediaStream = applyVideoTimestampWatermark(mediaStream)
    }

    collectMediaTracks(mediaStream)
    return mediaStream
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) {
  const nativeGetDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
  navigator.mediaDevices.getDisplayMedia = async function (constraints) {
    log(`getDisplayMedia:`, JSON.stringify(constraints))

    if ('webrtcperf_startFakeScreenshare' in window) {
      await window.webrtcperf_startFakeScreenshare()
    }

    if (overrides.getDisplayMedia) {
      constraints = overrides.getDisplayMedia(constraints)
      log(`getDisplayMedia override:`, JSON.stringify(constraints))
    }
    if (params.getDisplayMediaWaitTime > 0) {
      await sleep(params.getDisplayMediaWaitTime)
    }
    let mediaStream = await nativeGetDisplayMedia(constraints)
    await applyGetDisplayMediaCrop(mediaStream)
    if (overrides.getDisplayMediaStream) {
      try {
        mediaStream = await overrides.getDisplayMediaStream(mediaStream)
      } catch (err) {
        log(`overrideGetDisplayMediaStream error:`, err)
      }
    }

    if (enabledForSession(params.timestampWatermarkAudio)) {
      mediaStream = applyAudioTimestampWatermark(mediaStream)
    }

    collectMediaTracks(mediaStream)
    return mediaStream
  }
}

if (navigator.mediaDevices && 'setCaptureHandleConfig' in navigator.mediaDevices) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setCaptureHandleConfig = (navigator.mediaDevices as any).setCaptureHandleConfig.bind(navigator.mediaDevices)
  navigator.mediaDevices.setCaptureHandleConfig = (config: unknown) => {
    log('setCaptureHandleConfig', config)
    return setCaptureHandleConfig(config)
  }
}

if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
  const NativeEnumerateDevices = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  navigator.mediaDevices.enumerateDevices = async () => {
    if (config.VIDEO_URL || config.AUDIO_URL || config.MEDIA_URL) {
      const devices = [] as MediaDeviceInfo[]
      if (config.VIDEO_URL || config.MEDIA_URL) {
        devices.push({
          deviceId: 'webrtcperf-video',
          kind: 'videoinput',
          label: 'WebRTCPerf Video',
          groupId: 'webrtcperf',
        } as MediaDeviceInfo)
      }
      if (config.AUDIO_URL || config.MEDIA_URL) {
        devices.push({
          deviceId: 'webrtcperf-audio',
          kind: 'audioinput',
          label: 'WebRTCPerf Audio',
          groupId: 'webrtcperf',
        } as MediaDeviceInfo)
      }
      return devices
    }
    const devices = await NativeEnumerateDevices()
    return devices
  }
}
