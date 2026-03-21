import { config, enabledForSession, log, overrides, params, sleep } from './common'
import { applyAudioTimestampWatermark } from './e2e-audio-stats'
import { applyVideoTimestampWatermark } from './e2e-video-stats'
import { fakeStreamManager, syncFakeTracks } from './fake-stream'
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

export const getFakeTrack = async (kind: 'audio' | 'video', constraints?: MediaTrackConstraints) => {
  const configUrl = config.MEDIA_URL || config.VIDEO_URL || config.AUDIO_URL
  if (configUrl) {
    await fakeStreamManager.setMedia(configUrl, config.LOOP_MEDIA)
  }
  return fakeStreamManager.getTrack(kind, constraints)
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
    const useFakeMedia = enabledForSession(params.fakeMediaEnabled) || config.MEDIA_URL

    if (constraints?.audio && useFakeMedia) {
      const audioTrack = await getFakeTrack('audio')
      mediaStream.addTrack(audioTrack)
    }
    if (constraints?.video && useFakeMedia) {
      const videoTrack = await getFakeTrack(
        'video',
        typeof constraints.video === 'object' ? constraints.video : undefined,
      )
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
      mediaStream = await applyAudioTimestampWatermark(mediaStream)
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
    } else if (enabledForSession(params.fakeScreenshareEnabled)) {
      await startFakeScreenshare()
      if (!constraints) {
        constraints = {}
      }
      Object.assign(constraints, { preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' })
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
      mediaStream = await applyAudioTimestampWatermark(mediaStream)
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
    const useFakeMedia = enabledForSession(params.fakeMediaEnabled) || config.MEDIA_URL
    if (useFakeMedia) {
      const devices = [
        {
          deviceId: 'webrtcperf-video',
          kind: 'videoinput',
          label: 'WebRTCPerf Video',
          groupId: 'webrtcperf',
        },
        {
          deviceId: 'webrtcperf-audio',
          kind: 'audioinput',
          label: 'WebRTCPerf Audio',
          groupId: 'webrtcperf',
        },
      ] as MediaDeviceInfo[]
      return devices
    }
    const devices = await NativeEnumerateDevices()
    return devices
  }
}
