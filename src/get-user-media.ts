import { config, enabledForSession, log, overrides, params, sleep } from './common'
import { applyAudioTimestampWatermark } from './e2e-audio-stats'
import { applyVideoTimestampWatermark } from './e2e-video-stats'
import { startFakeScreenshare } from './screenshare'

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

export const audioTracks = new Set<MediaStreamTrack>()
export const videoTracks = new Set<MediaStreamTrack>()

/**
 * getActiveAudioTracks
 * @return {*} The active audio tracks array.
 */
export const getActiveAudioTracks = () => {
  cleanupClosedMediaTracks()
  return [...audioTracks.values()]
}

/**
 * getActiveVideoTracks
 * @return {*} The active video tracks array.
 */
export const getActiveVideoTracks = () => {
  cleanupClosedMediaTracks()
  return [...videoTracks.values()]
}

export const cleanupClosedMediaTracks = () => {
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
export const collectMediaTracks = (mediaStream: MediaStream, onEnded?: (track: MediaStreamTrack) => void) => {
  const aTracks = mediaStream.getAudioTracks()
  if (aTracks.length) {
    const track = aTracks[0]
    /* webrtcperf.log(`MediaStream new audio track ${track.id}`); */
    track.addEventListener('ended', () => audioTracks.delete(track))
    audioTracks.add(track)
  }
  const vTracks = mediaStream.getVideoTracks()
  if (vTracks.length) {
    const track = vTracks[0]
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
    track.addEventListener('ended', () => {
      videoTracks.delete(track)
      if (onEnded) {
        onEnded(track)
      }
    })
    videoTracks.add(track)
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
  kind: 'audio' | 'video'
  refcount = 0
  element: HTMLVideoElement | HTMLAudioElement
  trackPromise: Promise<MediaStreamTrack>

  constructor(kind: 'audio' | 'video') {
    log(`[FakeStream] new ${kind}`)
    this.kind = kind
    this.element = document.createElement(this.kind)
    this.element.src = this.kind === 'video' ? config.VIDEO_URL : config.AUDIO_URL
    this.element.loop = true
    this.element.crossOrigin = 'anonymous'
    this.element.autoplay = true
    this.element.muted = this.kind === 'video'
    this.trackPromise = this.createStream().then((stream) => {
      const track = (stream as MediaStream).getTracks().find((track) => track.kind === kind)
      if (!track) {
        throw new Error(`[FakeStream] track ${kind} not found`)
      }
      return track
    })
  }

  createStream() {
    return new Promise((resolve, reject) => {
      this.element.addEventListener(
        'loadeddata',
        () => {
          log(`[FakeStream] Create fake ${this.kind} stream done`)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          resolve((this.element as any).captureStream() as MediaStream)
        },
        { once: true },
      )
      this.element.addEventListener(
        'error',
        (err) => {
          log(`[FakeStream] Create fake ${this.kind} stream error:`, err)
          reject(err)
        },
        { once: true },
      )
      this.element.play()
    })
  }

  incRefcount() {
    this.refcount++
    if (this.element.paused) {
      this.element.play()
    }
  }

  decRefcount() {
    this.refcount--
    if (this.refcount === 0) {
      this.element.pause()
    }
  }
}

export const fakeStreams = {
  audio: null as FakeStream | null,
  video: null as FakeStream | null,
}

/**
 * Synchronize all the created fake tracks.
 * @param {number | undefined} [currentTime] - If specified, the current time to set.
 */
export function syncFakeTracks(currentTime?: number) {
  for (const kind of ['audio', 'video']) {
    const stream = fakeStreams[kind as keyof typeof fakeStreams]
    if (stream) {
      if (currentTime !== undefined) {
        stream.element.currentTime = currentTime
      }
      stream.element.play()
    }
  }
}

export const getFakeTrack = async (kind: keyof typeof fakeStreams) => {
  let stream = fakeStreams[kind]
  if (!stream) {
    stream = new FakeStream(kind)
    fakeStreams[kind] = stream
  }
  const track = await stream.trackPromise
  stream.incRefcount()
  const clonedTrack = track.clone()
  log(`[getFakeTrack] new ${kind} track ${clonedTrack.id} count: ${stream.refcount}`)
  const clonedTrackStop = clonedTrack.stop.bind(clonedTrack)
  clonedTrack.stop = () => {
    clonedTrackStop()
    stream.decRefcount()
  }
  return clonedTrack
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
  navigator.mediaDevices.getUserMedia = async function (constraints, ...args) {
    log(`getUserMedia:`, JSON.stringify(constraints))
    if (overrides.getUserMedia) {
      constraints = overrides.getUserMedia(constraints)
      log(`getUserMedia override:`, JSON.stringify(constraints))
    }
    if (params.getUserMediaWaitTime > 0) {
      await sleep(params.getUserMediaWaitTime)
    }

    let mediaStream = new MediaStream()

    if (constraints?.audio && config.AUDIO_URL) {
      const audioTrack = await getFakeTrack('audio')
      mediaStream.addTrack(audioTrack)
    }
    if (constraints?.video && config.VIDEO_URL) {
      const videoTrack = await getFakeTrack('video')
      mediaStream.addTrack(videoTrack)
    }
    if (mediaStream.getTracks().length > 0) {
      syncFakeTracks(0)
    } else {
      mediaStream = await nativeGetUserMedia(constraints, ...args)
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
  navigator.mediaDevices.getDisplayMedia = async function (constraints, ...args) {
    log(`getDisplayMedia:`, JSON.stringify(constraints))

    if ('webrtcperf_startFakeScreenshare' in window) {
      await window.webrtcperf_startFakeScreenshare()
    } else {
      await startFakeScreenshare()
    }

    if (overrides.getDisplayMedia) {
      constraints = overrides.getDisplayMedia(constraints)
      log(`getDisplayMedia override:`, JSON.stringify(constraints))
    }
    if (params.getDisplayMediaWaitTime > 0) {
      await sleep(params.getDisplayMediaWaitTime)
    }
    let mediaStream = await nativeGetDisplayMedia(constraints, ...args)
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
    if (config.VIDEO_URL || config.AUDIO_URL) {
      const devices = [] as MediaDeviceInfo[]
      if (config.VIDEO_URL) {
        devices.push({
          deviceId: 'webrtcperf-video',
          kind: 'videoinput',
          label: 'WebRTCPerf Video',
          groupId: 'webrtcperf',
        } as MediaDeviceInfo)
      }
      if (config.AUDIO_URL) {
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
