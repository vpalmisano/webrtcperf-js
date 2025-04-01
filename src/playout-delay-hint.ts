import { log, params } from './common'
import { PeerConnections } from './peer-connection'

type ReceiverWithPlayoutDelayHint = RTCRtpReceiver & { playoutDelayHint: number }

export function handleTransceiverForPlayoutDelayHint(id: number, transceiver: RTCRtpTransceiver, event: string) {
  const playoutDelayHint = params.playoutDelayHint
  if (playoutDelayHint === null) {
    return
  }
  const receiver = transceiver.receiver as ReceiverWithPlayoutDelayHint
  if (
    transceiver.receiver &&
    transceiver.receiver.track?.label !== 'probator' &&
    playoutDelayHint !== undefined &&
    receiver.playoutDelayHint !== playoutDelayHint
  ) {
    log(
      `RTCPeerConnection-${id} ${event}: set playoutDelayHint ${transceiver.receiver.track?.kind} ${receiver.playoutDelayHint} -> ${playoutDelayHint}`,
    )
    receiver.playoutDelayHint = playoutDelayHint
  }
}

export function setPlayoutDelayHint(value: number) {
  params.playoutDelayHint = value
  ;[...PeerConnections.entries()].forEach(([id, pc]) => {
    pc.getTransceivers().forEach((t) => handleTransceiverForPlayoutDelayHint(id, t, 'set'))
  })
}

export function getPlayoutDelayHint() {
  ;[...PeerConnections.entries()].forEach(([id, pc]) => {
    pc.getTransceivers().forEach(
      (t) =>
        t.receiver &&
        log(
          `${id} ${t.receiver.track?.kind} track: ${t.receiver.track?.label} playoutDelayHint: ${(t.receiver as ReceiverWithPlayoutDelayHint).playoutDelayHint}`,
        ),
    )
  })
}

export function handleTransceiverForJitterBufferTarget(id: number, transceiver: RTCRtpTransceiver, event: string) {
  let jitterBufferTarget = params.jitterBufferTarget
  if (jitterBufferTarget && typeof jitterBufferTarget === 'object') {
    jitterBufferTarget = jitterBufferTarget[transceiver.receiver.track?.kind as keyof typeof jitterBufferTarget]
  }
  if (
    transceiver.receiver &&
    transceiver.receiver.track?.label !== 'probator' &&
    jitterBufferTarget !== undefined &&
    transceiver.receiver.jitterBufferTarget !== jitterBufferTarget
  ) {
    log(
      `RTCPeerConnection-${id} ${event}: set jitterBufferTarget ${transceiver.receiver.track?.kind} ${transceiver.receiver.jitterBufferTarget} -> ${jitterBufferTarget}`,
    )
    transceiver.receiver.jitterBufferTarget = jitterBufferTarget
  }
}

export function setJitterBufferTarget(value: number) {
  params.jitterBufferTarget = value
  ;[...PeerConnections.entries()].forEach(([id, pc]) => {
    pc.getTransceivers().forEach((t) => handleTransceiverForJitterBufferTarget(id, t, 'set'))
  })
}

export function getJitterBufferTarget() {
  ;[...PeerConnections.entries()].forEach(([id, pc]) => {
    pc.getTransceivers().forEach(
      (t) =>
        t.receiver &&
        log(
          `${id} ${t.receiver.track?.kind} track: ${t.receiver.track?.label} jitterBufferTarget: ${t.receiver.jitterBufferTarget}`,
        ),
    )
  })
}
