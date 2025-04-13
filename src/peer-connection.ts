import { config, elapsedTime, enabledForSession, log, overrides, params } from './common'
import { OnOffTimer } from './timers'
import { MeasuredStats } from './stats'
import { audioStartFrameDelayStats, recognizeAudioTimestampWatermark } from './e2e-audio-stats'
import {
  recognizeVideoTimestampWatermark,
  screenStartFrameDelayStats,
  videoStartFrameDelayStats,
} from './e2e-video-stats'
import { handleTransceiverForJitterBufferTarget, handleTransceiverForPlayoutDelayHint } from './playout-delay-hint'
import { saveMediaTrack, stopSaveMediaTrack } from './save-tracks'

const timestampInsertableStreams = !!params.timestampInsertableStreams

export let peerConnectionsCreated = 0
export let peerConnectionsConnected = 0
export let peerConnectionsDisconnected = 0
export let peerConnectionsFailed = 0
export let peerConnectionsClosed = 0
export const connectionTimer = new OnOffTimer()

/**
 * Map of peer connections created.
 */
export const PeerConnections = new Map<number, RTCPeerConnection>()

/**
 * Measured stats for peer connections delay.
 */
export const peerConnectionsDelayStats = new MeasuredStats({ ttl: 15 })

/**
 * Wait for a track to be ready.
 * @param {MediaStreamTrack} track - The track to wait for.
 * @param {number} startTime - The start time.
 * @param {number} minWidth - The minimum width after which the promise is resolved.
 * @param {number} minHeight - The minimum height after which the promise is resolved.
 * @param {number} minNumberOfFrames - The minimum number of audio frames after which the promise is resolved.
 */
export async function waitTrackMedia(
  track: MediaStreamTrack,
  startTime = Date.now(),
  minWidth = 0,
  minHeight = 0,
  minNumberOfFrames = 0,
) {
  const { id, kind } = track
  const debug = (...args: unknown[]) => {
    if (enabledForSession(params.peerConnectionDebug)) {
      log(`waitTrackMedia ${id} (${kind})`, ...args)
    }
  }
  return new Promise<{
    now: number
    fromStart: number
    codedWidth?: number
    codedHeight?: number
    numberOfFrames?: number
  }>((resolve, reject) => {
    const { readable } = new window.MediaStreamTrackProcessor({ track })
    const controller = new AbortController()
    const writeable = new WritableStream(
      {
        async write(frame) {
          const { codedWidth, codedHeight, numberOfFrames } = frame
          frame.close()
          if (
            (kind === 'audio' && numberOfFrames >= minNumberOfFrames) ||
            (kind === 'video' && codedWidth >= minWidth && codedHeight >= minHeight)
          ) {
            const now = Date.now()
            const fromStart = now - startTime
            debug(`done, fromStart: ${fromStart}ms`, { codedWidth, codedHeight, numberOfFrames })
            controller.abort('done')
            resolve({ now, fromStart, codedWidth, codedHeight, numberOfFrames })
          }
        },
        abort(reason) {
          if (reason === 'done') return
          log(`waitTrackMedia ${id} ${kind} error:`, reason)
          reject(reason)
        },
      },
      new CountQueuingStrategy({ highWaterMark: 1 }),
    )
    readable.pipeTo(writeable, { signal: controller.signal }).catch(reject)
  })
}

window.RTCPeerConnection = class extends RTCPeerConnection {
  id: number
  encodedInsertableStreams: boolean
  debug: (...args: unknown[]) => void

  constructor(conf?: RTCConfiguration & { encodedInsertableStreams?: boolean; sdpSemantics?: string }) {
    const encodedInsertableStreams =
      conf?.encodedInsertableStreams || (timestampInsertableStreams && conf?.sdpSemantics === 'unified-plan')

    const id = peerConnectionsCreated++
    super({
      ...(conf || {}),
      encodedInsertableStreams,
    } as RTCConfiguration)

    this.id = id
    this.encodedInsertableStreams = encodedInsertableStreams
    this.debug = (...args: unknown[]) => {
      if (enabledForSession(params.peerConnectionDebug)) {
        log(`RTCPeerConnection-${id}`, ...args)
      }
    }
    this.debug(`created`, { conf, pc: this })

    PeerConnections.set(id, this)

    let peerConnectionsDelayStatsDone = false
    const startTime = Date.now()

    this.addEventListener('connectionstatechange', () => {
      this.debug(`connectionState: ${this.connectionState}`)
      switch (this.connectionState) {
        case 'connected': {
          peerConnectionsConnected++
          connectionTimer.add(id.toString())
          if (!peerConnectionsDelayStatsDone) {
            const now = Date.now()
            peerConnectionsDelayStats.push(now, (now - startTime) / 1000)
            peerConnectionsDelayStatsDone = true
          }
          break
        }
        case 'disconnected': {
          peerConnectionsDisconnected++
          connectionTimer.remove(id.toString())
          break
        }
        case 'failed': {
          peerConnectionsFailed++
          connectionTimer.remove(id.toString())
          break
        }
      }
    })

    this.addEventListener('track', async (event) => {
      const { receiver, transceiver, streams } = event
      if (receiver?.track && receiver.track.label !== 'probator') {
        this.debug(`ontrack ${receiver.track.kind} ${receiver.track.id}`, { streams })
        /* if (encodedInsertableStreams && timestampInsertableStreams) {
          webrtcperf.handleTransceiverForInsertableStreams(id, transceiver)
        } */

        /**
         * @event {CustomEvent} webrtcperf:peerconnection:track
         * @property {number} id - The id of the peer connection.
         * @property {RTCPeerConnection} pc - The peer connection.
         * @property {RTCRtpReceiver} receiver - The receiver.
         * @property {RTCRtpTransceiver} transceiver - The transceiver.
         * @property {MediaStream[]} streams - The streams.
         */
        window.dispatchEvent(
          new CustomEvent('webrtcperf:peerconnection:track', {
            bubbles: true,
            detail: { id, pc: this, receiver, transceiver, streams },
          }),
        )

        waitTrackMedia(receiver.track)
          .then(async ({ now }) => {
            const t = elapsedTime() / 1000
            if (receiver.track.kind === 'video') {
              if (overrides.isReceiverDisplayTrack(receiver.track)) {
                this.debug(`ontrack screen ${receiver.track.id} from start: ${t}s`)
                screenStartFrameDelayStats.push(now, t)
              } else {
                this.debug(`ontrack video ${receiver.track.id} from start: ${t}s`)
                videoStartFrameDelayStats.push(now, t)
              }
            } else if (receiver.track.kind === 'audio') {
              this.debug(`ontrack audio ${receiver.track.id} from start: ${t}s`)
              audioStartFrameDelayStats.push(now, t)
            }
          })
          .catch((err) => log(`waitTrackMedia error: ${err.message}`))

        if (receiver.track.kind === 'video') {
          if (enabledForSession(params.timestampWatermarkVideo)) {
            await recognizeVideoTimestampWatermark(receiver.track)
          }
          if (enabledForSession(params.saveRecvVideoTrack)) {
            saveMediaTrack(receiver.track, 'recv')
          }
        } else if (receiver.track.kind === 'audio') {
          if (enabledForSession(params.timestampWatermarkAudio)) {
            await recognizeAudioTimestampWatermark(receiver.track)
          }
          if (enabledForSession(params.saveRecvAudioTrack)) {
            saveMediaTrack(receiver.track, 'recv')
          }
        }
      }
      handleTransceiverForPlayoutDelayHint(id, transceiver, 'track')
      handleTransceiverForJitterBufferTarget(id, transceiver, 'track')
    })

    window.dispatchEvent(
      new CustomEvent('webrtcperf:peerconnectioncreated', {
        bubbles: true,
        detail: { id, pc: this },
      }),
    )
  }

  close() {
    this.debug(`close`)
    if (PeerConnections.has(this.id)) {
      PeerConnections.delete(this.id)
      peerConnectionsClosed++
      connectionTimer.remove(this.id.toString())
    }
    super.close()
  }

  createOffer = (async (options?: RTCOfferOptions) => {
    let offer = await super.createOffer(options)
    if (overrides.createOffer) {
      offer = overrides.createOffer(offer as RTCSessionDescriptionInit)
      this.debug(`createOffer override`, offer)
    } else {
      this.debug(`createOffer`, { options, offer })
    }
    return offer
  }) as typeof RTCPeerConnection.prototype.createOffer

  setLocalDescription(description: RTCSessionDescriptionInit) {
    this.debug(`setLocalDescription`, description)
    if (overrides.setLocalDescription) {
      description = overrides.setLocalDescription(description)
      this.debug(`setLocalDescription override`, description)
    }
    return super.setLocalDescription(description)
  }

  setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.debug(`setRemoteDescription`, description)
    if (overrides.setRemoteDescription) {
      description = overrides.setRemoteDescription(description)
      this.debug(`setRemoteDescription override`, description)
    }
    return super.setRemoteDescription(description)
  }

  private checkSaveStream(transceiver: RTCRtpTransceiver) {
    if (!transceiver?.sender?.track) return
    if (transceiver.sender.track.kind === 'video' && enabledForSession(params.saveSendVideoTrack)) {
      saveMediaTrack(transceiver.sender.track, 'send', params.saveVideoTrackEnableStart, params.saveVideoTrackEnableEnd)
    } else if (transceiver.sender.track.kind === 'audio' && enabledForSession(params.saveSendAudioTrack)) {
      saveMediaTrack(transceiver.sender.track, 'send', params.saveAudioTrackEnableStart, params.saveAudioTrackEnableEnd)
    }
  }

  addTransceiver(trackOrKind: string | MediaStreamTrack, init?: RTCRtpTransceiverInit) {
    this.debug(`addTransceiver`, { trackOrKind, init })
    const transceiver = super.addTransceiver(trackOrKind, init)
    if (transceiver.sender) {
      const setParametersNative = transceiver.sender.setParameters.bind(transceiver.sender)
      transceiver.sender.setParameters = (parameters) => {
        this.debug(`transceiver.setParameters`, parameters)
        if (overrides.setParameters) {
          parameters = overrides.setParameters(parameters)
        }
        return setParametersNative(parameters)
      }

      const setStreamsNative = transceiver.sender.setStreams.bind(transceiver.sender)
      transceiver.sender.setStreams = (...streams) => {
        this.debug(`transceiver.setStreams`, streams)
        if (overrides.setStreams) {
          streams = overrides.setStreams(streams)
        }
        setStreamsNative(...streams)
        this.checkSaveStream(transceiver)
      }

      const replaceTrackNative = transceiver.sender.replaceTrack.bind(transceiver.sender)
      transceiver.sender.replaceTrack = async (track) => {
        this.debug(`transceiver.replaceTrack`, track)
        if (overrides.replaceTrack) {
          track = overrides.replaceTrack(track)
        }
        await replaceTrackNative(track)
        /* if (encodedInsertableStreams && timestampInsertableStreams) {
          webrtcperf.handleTransceiverForInsertableStreams(id, transceiver)
        } */
        this.checkSaveStream(transceiver)
      }
    }

    /* if (transceiver.receiver) {
      watchObjectProperty(transceiver.receiver, 'playoutDelayHint' as keyof RTCRtpReceiver, (value, oldValue) => {
        this.debug(`receiver ${transceiver.receiver.track.kind} playoutDelayHint ${oldValue} -> ${value}`)
      })
      watchObjectProperty(transceiver.receiver, 'jitterBufferTarget' as keyof RTCRtpReceiver, (value, oldValue) => {
        this.debug(`receiver ${transceiver.receiver.track.kind} jitterBufferTarget ${oldValue} -> ${value}`)
      })
    } */

    /* if (encodedInsertableStreams && timestampInsertableStreams) {
      webrtcperf.handleTransceiverForInsertableStreams(id, transceiver)
    } */

    handleTransceiverForPlayoutDelayHint(this.id, transceiver, 'addTransceiver')
    handleTransceiverForJitterBufferTarget(this.id, transceiver, 'addTransceiver')
    return transceiver
  }

  addStream(stream: MediaStream) {
    this.debug(`addStream`, stream)
    const addStreamNative = this.addStream.bind(this)
    addStreamNative(stream)
    for (const transceiver of this.getTransceivers()) {
      if (['sendonly', 'sendrecv'].includes(transceiver.direction)) {
        /* if (encodedInsertableStreams && timestampInsertableStreams) {
          webrtcperf.handleTransceiverForInsertableStreams(id, transceiver)
        } */
        handleTransceiverForPlayoutDelayHint(this.id, transceiver, 'addStream')
        handleTransceiverForJitterBufferTarget(this.id, transceiver, 'addStream')
        this.checkSaveStream(transceiver)
      }
    }
  }

  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]) {
    this.debug(`addTrack`, track, streams)
    const sender = super.addTrack(track, ...streams)
    for (const transceiver of this.getTransceivers()) {
      if (['sendonly', 'sendrecv'].includes(transceiver.direction)) {
        /* if (encodedInsertableStreams && timestampInsertableStreams) {
          webrtcperf.handleTransceiverForInsertableStreams(id, transceiver)
        } */
        handleTransceiverForPlayoutDelayHint(this.id, transceiver, 'addTrack')
        handleTransceiverForJitterBufferTarget(this.id, transceiver, 'addTrack')
        this.checkSaveStream(transceiver)
      }
    }
    return sender
  }

  setConfiguration(configuration: RTCConfiguration) {
    this.debug(`setConfiguration`, configuration)
    return super.setConfiguration({
      ...configuration,
      encodedInsertableStreams: this.encodedInsertableStreams,
    } as RTCConfiguration)
  }
}

// Override codecs.
const NativeRTCRtpSenderGetCapabilities = window.RTCRtpSender.getCapabilities

window.RTCRtpSender.getCapabilities = (kind) => {
  const capabilities = NativeRTCRtpSenderGetCapabilities(kind)
  if (!capabilities) return null
  if (!config.GET_CAPABILITIES_DISABLED_VIDEO_CODECS?.length || kind !== 'video') {
    return capabilities
  }
  capabilities.codecs = capabilities.codecs.filter((codec) => {
    if (config.GET_CAPABILITIES_DISABLED_VIDEO_CODECS.includes(codec.mimeType.replace('video/', '').toLowerCase())) {
      return false
    }
    return true
  })
  log(`RTCRtpSender getCapabilities custom:`, capabilities)
  return capabilities
}

export function filterTransceiversTracks(direction: 'send' | 'recv', kind: 'audio' | 'video' | 'screen') {
  if (!['send', 'recv'].includes(direction)) {
    throw new Error(`Invalid direction: ${direction}`)
  }
  const trackKind = kind === 'screen' ? 'video' : kind
  if (!['audio', 'video'].includes(trackKind)) {
    throw new Error(`Invalid kind: ${trackKind}`)
  }
  const directionOption = direction === 'send' ? 'sender' : 'receiver'
  const tranceivers: { tranceiver: RTCRtpTransceiver; track: MediaStreamTrack }[] = []
  for (const pc of PeerConnections.values()) {
    pc.getTransceivers().forEach((tranceiver) => {
      if (!tranceiver.direction.includes(direction)) return
      const track = tranceiver[directionOption]?.track
      if (track?.kind === trackKind && track?.label !== 'probator') {
        if (
          kind === 'video' &&
          ((direction === 'send' && overrides.isSenderDisplayTrack(track)) ||
            (direction === 'recv' && overrides.isReceiverDisplayTrack(track)))
        )
          return
        tranceivers.push({ tranceiver, track })
      }
    })
  }
  return tranceivers
}

export async function saveTransceiversTracks(
  direction: 'send' | 'recv',
  kind: 'audio' | 'video' | 'screen',
  enableStart = 0,
  enableEnd = 0,
) {
  for (const { track } of filterTransceiversTracks(direction, kind)) {
    await saveMediaTrack(track, direction, enableStart, enableEnd)
  }
}

export async function stopSaveTransceiversTracks(direction: 'send' | 'recv', kind: 'audio' | 'video' | 'screen') {
  for (const { track } of filterTransceiversTracks(direction, kind)) {
    await stopSaveMediaTrack(track)
  }
}

export function setTransceiversTracks(
  direction: 'send' | 'recv',
  kind: 'audio' | 'video' | 'screen',
  enabled: boolean,
) {
  for (const { track } of filterTransceiversTracks(direction, kind)) {
    track.enabled = enabled
  }
}
