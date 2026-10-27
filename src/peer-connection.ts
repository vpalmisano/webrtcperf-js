import * as sdpTransform from 'sdp-transform'

import { config, elapsedTime, enabledForSession, log, overrides, params, sleep } from './common'
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

export { sdpTransform }

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
 * Get the connected peer connections.
 * @return {RTCPeerConnection[]}
 */
export function getPeerConnections() {
  return Array.from(PeerConnections.values()).filter((pc) => pc.connectionState === 'connected')
}

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

function addAbsCaptureTime(offer: RTCSessionDescriptionInit) {
  if (!enabledForSession(params.absCaptureTime)) return
  if (offer.sdp) {
    const sdp = sdpTransform.parse(offer.sdp)
    sdp.media.forEach((media) => {
      if (!media.ext) return
      if (!media.ext.find((ext) => ext.uri === 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time')) {
        media.ext.push({ uri: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time', value: 99 })
      }
    })
    offer.sdp = sdpTransform.write(sdp)
    log('addAbsCaptureTime', offer)
  }
}

function filterCodecs(description: RTCSessionDescriptionInit) {
  const codecs = params.disabledCodecs
    .toLowerCase()
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0)
  if (!codecs.length || !description.sdp) return description
  const desc = sdpTransform.parse(description.sdp)
  const removed = new Set<string>()
  desc.media.forEach((media) => {
    media.rtp
      .filter((r) => codecs.includes(r.codec.toLowerCase()))
      .forEach((r) => {
        const payload = r.payload
        removed.add(r.codec)
        media.fmtp = media.fmtp.filter((r) => r.payload !== payload && r.payload !== payload + 1)
        if (media.rtcpFb) {
          media.rtcpFb = media.rtcpFb.filter((r) => r.payload !== payload && r.payload !== payload + 1)
        }
        media.rtp = media.rtp.filter((r) => r.payload !== payload && r.payload !== payload + 1)
        if (media.payloads) {
          media.payloads = media.payloads
            .split(' ')
            .filter((r) => r !== payload.toString())
            .join(' ')
        }
      })
  })
  description.sdp = sdpTransform.write(desc)
  log(`filterCodecs removed codecs: ${Array.from(removed).join(', ')}`)
  return description
}

window.RTCPeerConnection = class extends RTCPeerConnection {
  private id: number
  private encodedInsertableStreams: boolean
  private debug: (...args: unknown[]) => void

  constructor(conf?: RTCConfiguration & { encodedInsertableStreams?: boolean; sdpSemantics?: string }) {
    const encodedInsertableStreams = conf?.encodedInsertableStreams || enabledForSession(params.debugInsertableStreams)

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
        handleTransceiverForInsertableStreams(id, transceiver)

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
            saveMediaTrack(receiver.track, 'recv').catch((err) => log(`saveMediaTrack error: ${err.message}`))
          }
        } else if (receiver.track.kind === 'audio') {
          if (enabledForSession(params.timestampWatermarkAudio)) {
            await recognizeAudioTimestampWatermark(receiver.track)
          }
          if (enabledForSession(params.saveRecvAudioTrack)) {
            saveMediaTrack(receiver.track, 'recv').catch((err) => log(`saveMediaTrack error: ${err.message}`))
          }
        }
      }
      handleTransceiverForPlayoutDelayHint(id, transceiver, 'track')
      handleTransceiverForJitterBufferTarget(id, transceiver, 'track')
    })

    this.addEventListener('datachannel', (event) => {
      const { channel } = event
      handleDataChannel(id, channel)
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
    addAbsCaptureTime(offer)
    filterCodecs(offer)
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
        handleTransceiverForInsertableStreams(this.id, transceiver)
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

    handleTransceiverForInsertableStreams(this.id, transceiver)

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
        handleTransceiverForInsertableStreams(this.id, transceiver)
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
        handleTransceiverForInsertableStreams(this.id, transceiver)
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

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.debug(`createDataChannel`, label, options)
    const dataChannel = super.createDataChannel(label, options)
    handleDataChannel(this.id, dataChannel)
    return dataChannel
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

/**
 * Get the transceiver track by index, waiting for the track to be available.
 * @param direction - The direction of the transceiver.
 * @param kind - The kind of the track.
 * @param filterFunction - The filter function to use to filter the returned track.
 * @param retryTime - The time to retry in seconds.
 * @param timeout - The timeout in seconds. Set to 0 to wait indefinitely.
 * @returns The track.
 */
export async function getTransceiversTrack(
  direction: 'send' | 'recv',
  kind: 'audio' | 'video' | 'screen',
  filterFunction: (tranceiver: RTCRtpTransceiver, track: MediaStreamTrack, index: number) => Promise<boolean> = () =>
    Promise.resolve(true),
  retryTime = 1,
  timeout = 0,
) {
  const startTime = Date.now()
  while (true) {
    const ret = filterTransceiversTracks(direction, kind)
    for (const [index, { tranceiver, track }] of ret.entries()) {
      try {
        if (await filterFunction(tranceiver, track, index)) {
          return track
        }
      } catch (error) {
        log(`Error filtering track ${direction} ${kind} ${index}: ${error}`)
      }
    }
    if (timeout > 0 && Date.now() - startTime > timeout * 1000) {
      throw new Error(`Timeout getting track ${direction} ${kind}`)
    }
    await sleep(retryTime * 1000)
  }
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
    stopSaveMediaTrack(track)
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

type RTCEncodedStreams = { readable: ReadableStream; writable: WritableStream }

type RTCRtpSenderWithEncodedStreams = RTCRtpSender & {
  _encodedStreams?: RTCEncodedStreams
  createEncodedStreams(): RTCEncodedStreams
}

type RTCRtpReceiverWithEncodedStreams = RTCRtpReceiver & {
  _encodedStreams?: RTCEncodedStreams
  createEncodedStreams(): RTCEncodedStreams
}

function handleTransceiverForInsertableStreams(id: number, transceiver: RTCRtpTransceiver) {
  if (!enabledForSession(params.debugInsertableStreams)) return
  log(`RTCPeerConnection-${id} handleTransceiverForInsertableStreams ${transceiver.direction}`)
  const { sender, receiver } = transceiver as unknown as {
    sender: RTCRtpSenderWithEncodedStreams
    receiver: RTCRtpReceiverWithEncodedStreams
  }

  const handleEncodedStreams = ({ readable, writable }: RTCEncodedStreams, direction: string) => {
    const transform = new TransformStream({
      async transform(encodedFrame: RTCEncodedVideoFrame, controller: TransformStreamDefaultController) {
        const { type, timestamp, data } = encodedFrame
        const { mimeType, width, height, spatialIndex, temporalIndex } = encodedFrame.getMetadata()
        if (mimeType?.startsWith('video/')) {
          log(
            `${direction} ${mimeType} (${type}) t: ${timestamp} size: ${data.byteLength} ${width}x${height} S${spatialIndex}T${temporalIndex}`,
          )
        } else {
          log(`${direction} ${mimeType} t: ${timestamp} size: ${data.byteLength}`)
        }
        controller.enqueue(encodedFrame)
      },
    })
    readable.pipeThrough(transform).pipeTo(writable)
  }

  if (sender && !sender._encodedStreams) {
    sender._encodedStreams = sender.createEncodedStreams()
    handleEncodedStreams(sender._encodedStreams, 'send')
  }
  if (receiver && receiver.track?.label !== 'probator' && !receiver._encodedStreams) {
    receiver._encodedStreams = receiver.createEncodedStreams()
    handleEncodedStreams(receiver._encodedStreams, 'recv')
  }
}

function getSize(data: string | Blob | ArrayBuffer | ArrayBufferView) {
  return data instanceof Blob
    ? data.size
    : data instanceof ArrayBuffer
      ? data.byteLength
      : typeof data === 'string'
        ? data.length
        : (data.byteLength ?? 0)
}

function handleDataChannel(id: number, dataChannel: RTCDataChannel) {
  if (!enabledForSession(params.dataChannelsDebug)) return
  log(
    `RTCPeerConnection-${id} handleDataChannel id: ${dataChannel.id}, label: ${dataChannel.label}, negotiated: ${dataChannel.negotiated}, readyState: ${dataChannel.readyState}`,
  )
  const send = dataChannel.send.bind(dataChannel) as (data: string | Blob | ArrayBuffer | ArrayBufferView) => void
  dataChannel.send = ((data: string | Blob | ArrayBuffer | ArrayBufferView) => {
    const size = getSize(data)
    log(`RTCPeerConnection-${id} dataChannel send`, size)
    return send(data)
  }) as typeof dataChannel.send
  dataChannel.addEventListener('open', () => {
    log(`RTCPeerConnection-${id} dataChannel open ${dataChannel.label} readyState=${dataChannel.readyState}`)
  })
  dataChannel.addEventListener('message', (event) => {
    const { data } = event
    const size = getSize(data)
    log(`RTCPeerConnection-${id} dataChannel message`, size)
  })
  dataChannel.addEventListener('error', (event) => {
    log(`RTCPeerConnection-${id} dataChannel error`, event)
  })
  dataChannel.addEventListener('close', (event) => {
    log(`RTCPeerConnection-${id} dataChannel close`, event.target)
  })
}
