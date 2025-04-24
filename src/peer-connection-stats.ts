import { overrides, log } from './common'
import {
  connectionTimer,
  PeerConnections,
  peerConnectionsClosed,
  peerConnectionsConnected,
  peerConnectionsCreated,
  peerConnectionsDelayStats,
  peerConnectionsDisconnected,
  peerConnectionsFailed,
} from './peer-connection'

export const signalingHost = ''

const trackStats = new Map<string, { t: number; values: OutboundTrackStats | InboundTrackStats }>()
const trackStatsKeys: string[] = []

function isRecvTrackEnabled(track: MediaStreamTrack) {
  return track.enabled
}

function filterUndefined(o: Record<string, number | string | undefined>) {
  return Object.fromEntries(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    Object.entries(o).filter(([_, v]) => v !== undefined && (typeof v === 'string' || isFinite(v))),
  )
}

function sumOptional(a: Record<string, number>, b: Record<string, number>, prop: string) {
  if (a[prop] === undefined) {
    a[prop] = b[prop]
  } else if (b[prop] !== undefined) {
    a[prop] = a[prop] + b[prop]
  }
}

function maxOptional(a: Record<string, number>, b: Record<string, number>, prop: string) {
  if (a[prop] === undefined || a[prop] === null) {
    a[prop] = b[prop]
  } else if (b[prop] !== undefined && b[prop] !== null) {
    a[prop] = Math.max(a[prop], b[prop])
  }
}

function positiveDiff(cur?: number, old?: number) {
  return Math.max(0, (cur ?? 0) - (old ?? 0))
}

function averageFromTotal(value?: number, prevValue?: number, total?: number, prevTotal?: number) {
  const diff = positiveDiff(total, prevTotal)
  if (diff) {
    return positiveDiff(value, prevValue) / diff
  }
}

function calculateLossRate(lost: number, total: number) {
  return total > 0 ? (100 * lost) / total : undefined
}

function calculateJitterBuffer(jitterBufferDelay: number, count: number) {
  return count > 0 ? jitterBufferDelay / count : undefined
}

export type OutboundRtpStats = {
  kind: 'audio' | 'video'
  bytesSent: number
  headerBytesSent: number
  packetsSent: number
  retransmittedPacketsSent: number
  packetsLost: number
  nackCount: number
  framesSent: number
  frameWidth: number
  frameHeight: number
  framesPerSecond: number
  firCountReceived: number
  pliCountReceived: number
  totalRoundTripTime: number
  roundTripTimeMeasurements: number
  jitter: number
  totalEncodeTime: number
  totalPacketSendDelay: number
  qualityLimitationResolutionChanges: number
  qualityLimitationDurationsCpu?: number
  qualityLimitationDurationsBandwidth?: number
  qualityLimitationDurationsTotal?: number
  bitrate?: number
  packetsLossRate?: number
  qualityLimitationCpu?: number
  qualityLimitationBandwidth?: number
  roundTripTime?: number
  encodeLatency?: number
  sentLatency?: number
  transportRoundTripTime?: number
}

export type InboundRtpStats = {
  kind: 'audio' | 'video'
  packetsLost: number
  packetsReceived: number
  retransmittedPacketsReceived: number
  jitter: number
  bytesReceived: number
  headerBytesReceived: number
  decoderImplementation: string
  framesDecoded: number
  totalDecodeTime: number
  framesReceived: number
  frameWidth: number
  frameHeight: number
  frameRate: number
  firCount: number
  pliCount: number
  nackCount: number
  freezeCount: number
  totalFreezesDuration: number
  jitterBufferEmittedCount: number
  jitterBufferDelay: number
  totalRoundTripTime: number
  roundTripTimeMeasurements: number
  totalAudioEnergy: number
  totalSamplesDuration: number
  totalSamplesReceived: number
  concealedSamples: number
  concealmentEvents: number
  insertedSamplesForDeceleration: number
  removedSamplesForAcceleration: number
  keyFramesDecoded: number
  bitrate?: number
  framesPerSecond?: number
  packetsLossRate?: number
  jitterBuffer?: number
  transportTotalRoundTripTime?: number
  transportResponsesReceived?: number
  transportRoundTripTime?: number
  decodeLatency?: number
  availableIncomingBitrate?: number
  audioLevel?: number
  captureTimestamp?: number
  estimatedPlayoutTimestamp?: number
  endToEndDelay?: number
}

export type TrackStats = {
  enabled: boolean
  isDisplay: boolean
  remoteAddress: string
  codec: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw?: any
}

export type OutboundTrackStats = TrackStats & {
  outboundRtp: OutboundRtpStats
  videoSentActiveEncodings: number
  sentMaxBitrate?: number
  availableOutgoingBitrate: number
}

export type InboundTrackStats = TrackStats & {
  inboundRtp: InboundRtpStats
  videoReceivedActiveEncodings?: number
  receivedMaxBitrate?: number
  availableIncomingBitrate?: number
}

function updateTrackStats(
  trackId: string,
  track: MediaStreamTrack,
  t: number,
  values: OutboundTrackStats | InboundTrackStats,
) {
  const isNew = !trackStats.has(trackId)
  trackStats.set(trackId, { t, values })
  // Update ordered array.
  const index = trackStatsKeys.indexOf(trackId)
  if (index !== -1) {
    trackStatsKeys.splice(index, 1)
  }
  trackStatsKeys.push(trackId)
  if (isNew) {
    track.addEventListener(
      'ended',
      () => {
        trackStats.delete(trackId)
        const index = trackStatsKeys.indexOf(trackId)
        if (index !== -1) {
          trackStatsKeys.splice(index, 1)
        }
      },
      { once: true },
    )
  }
}

async function getSenderStats(sender: RTCRtpSender, pc: RTCPeerConnection, now: number, raw = false) {
  const track = sender.track
  const encodings = sender.getParameters().encodings.filter((encoding) => encoding.active)
  if (!track) {
    return
  }
  const trackId = 's-' + track.id + '-' + track.kind[0]
  const stats = await pc.getStats(track)
  const values: OutboundTrackStats = {
    enabled: track.enabled && (track.kind === 'audio' || encodings.length > 0),
    outboundRtp: {} as OutboundRtpStats,
    isDisplay: false,
    codec: '',
    videoSentActiveEncodings: 0,
    availableOutgoingBitrate: 0,
    remoteAddress: '',
  }
  if (track.kind === 'video') {
    values.isDisplay = overrides.isSenderDisplayTrack(track)
    values.videoSentActiveEncodings = encodings.length
  }
  const sentMaxBitrate = encodings.length
    ? encodings.reduce((prev, encoding) => {
        prev += encoding.maxBitrate || 0
        return prev
      }, 0)
    : undefined
  if (sentMaxBitrate) {
    values.sentMaxBitrate = sentMaxBitrate
  }
  for (const s of stats.values()) {
    if (raw) {
      if (!values.raw) {
        values.raw = { encodings, stats: {} }
      }
      values.raw.stats[s.type] = s
    }
    if (s.type === 'codec') {
      values.codec = s.mimeType.split('/')[1].toLowerCase()
    } else if (s.type === 'candidate-pair' && s.nominated) {
      values.availableOutgoingBitrate = s.availableOutgoingBitrate
      Object.assign(values.outboundRtp, {
        transportRoundTripTime: s.currentRoundTripTime,
      })
    } else if (s.type === 'outbound-rtp' && s.active && s.kind === track.kind && s.bytesSent + s.headerBytesSent > 0) {
      if (s.remoteId) {
        // Get the RTCRemoteInboundRtpStreamStats.
        const remoteInboundRtpStreamStats = stats.get(s.remoteId)
        s.packetsLost = remoteInboundRtpStreamStats.packetsLost
        s.totalRoundTripTime = remoteInboundRtpStreamStats.totalRoundTripTime
        s.roundTripTimeMeasurements = remoteInboundRtpStreamStats.roundTripTimeMeasurements
        s.jitter = remoteInboundRtpStreamStats.jitter
      }
      const outboundRtp: OutboundRtpStats = {
        kind: s.kind,
        bytesSent: s.bytesSent,
        headerBytesSent: s.headerBytesSent,
        packetsSent: s.packetsSent,
        retransmittedPacketsSent: s.retransmittedPacketsSent,
        packetsLost: s.packetsLost,
        nackCount: s.nackCount,
        framesSent: s.framesSent,
        frameWidth: s.frameWidth,
        frameHeight: s.frameHeight,
        framesPerSecond: s.framesPerSecond,
        firCountReceived: s.firCount,
        pliCountReceived: s.pliCount,
        totalRoundTripTime: s.totalRoundTripTime,
        roundTripTimeMeasurements: s.roundTripTimeMeasurements,
        jitter: s.jitter,
        totalEncodeTime: s.totalEncodeTime,
        totalPacketSendDelay: s.totalPacketSendDelay,
        qualityLimitationResolutionChanges: s.qualityLimitationResolutionChanges,
        qualityLimitationDurationsCpu: s.qualityLimitationDurations ? s.qualityLimitationDurations.cpu : undefined,
        qualityLimitationDurationsBandwidth: s.qualityLimitationDurations
          ? s.qualityLimitationDurations.bandwidth
          : undefined,
        qualityLimitationDurationsTotal: s.qualityLimitationDurations
          ? s.qualityLimitationDurations.other +
            s.qualityLimitationDurations.cpu +
            s.qualityLimitationDurations.bandwidth +
            s.qualityLimitationDurations.none
          : undefined,
      }
      values.outboundRtp.kind = outboundRtp.kind
      ;[
        'bytesSent',
        'headerBytesSent',
        'packetsSent',
        'retransmittedPacketsSent',
        'packetsLost',
        'nackCount',
        'qualityLimitationResolutionChanges',
        'qualityLimitationDurationsCpu',
        'qualityLimitationDurationsBandwidth',
        'qualityLimitationDurationsTotal',
        'totalRoundTripTime',
        'roundTripTimeMeasurements',
      ].forEach((prop) =>
        sumOptional(
          values.outboundRtp as unknown as Record<string, number>,
          outboundRtp as unknown as Record<string, number>,
          prop,
        ),
      )
      ;[
        'framesSent',
        'frameWidth',
        'frameHeight',
        'framesPerSecond',
        'firCountReceived',
        'pliCountReceived',
        'jitter',
        'totalEncodeTime',
        'totalPacketSendDelay',
      ].forEach((prop) =>
        maxOptional(
          values.outboundRtp as unknown as Record<string, number>,
          outboundRtp as unknown as Record<string, number>,
          prop,
        ),
      )
    } else if (s.type === 'remote-candidate') {
      values.remoteAddress = s.address
    }
  }
  if (values.outboundRtp.kind && values.outboundRtp.bytesSent + values.outboundRtp.headerBytesSent > 0) {
    if (trackStats.has(trackId)) {
      const prevStats = trackStats.get(trackId) as { t: number; values: OutboundTrackStats }
      // bitrate
      values.outboundRtp.bitrate =
        averageFromTotal(
          8 * (values.outboundRtp.bytesSent + values.outboundRtp.headerBytesSent),
          8 * (prevStats.values.outboundRtp.bytesSent + prevStats.values.outboundRtp.headerBytesSent),
          now / 1000,
          prevStats.t / 1000,
        ) ?? 0
      // loss rate
      const lost = positiveDiff(values.outboundRtp.packetsLost, prevStats.values.outboundRtp.packetsLost)
      const sent = positiveDiff(values.outboundRtp.packetsSent, prevStats.values.outboundRtp.packetsSent)
      values.outboundRtp.packetsLossRate = calculateLossRate(lost, lost + sent)
      // quality limitations
      const totalQualityLimitationDurationsDiff = positiveDiff(
        values.outboundRtp.qualityLimitationDurationsTotal,
        prevStats.values.outboundRtp.qualityLimitationDurationsTotal,
      )
      if (totalQualityLimitationDurationsDiff) {
        const qualityLimitationDurationsCpuDiff = positiveDiff(
          values.outboundRtp.qualityLimitationDurationsCpu,
          prevStats.values.outboundRtp.qualityLimitationDurationsCpu,
        )
        const qualityLimitationDurationsBandwidthDiff = positiveDiff(
          values.outboundRtp.qualityLimitationDurationsBandwidth,
          prevStats.values.outboundRtp.qualityLimitationDurationsBandwidth,
        )
        values.outboundRtp.qualityLimitationCpu =
          (100 * qualityLimitationDurationsCpuDiff) / totalQualityLimitationDurationsDiff
        values.outboundRtp.qualityLimitationBandwidth =
          (100 * qualityLimitationDurationsBandwidthDiff) / totalQualityLimitationDurationsDiff
      }
      // round trip time
      values.outboundRtp.roundTripTime = averageFromTotal(
        values.outboundRtp.totalRoundTripTime,
        prevStats.values.outboundRtp.totalRoundTripTime,
        values.outboundRtp.roundTripTimeMeasurements,
        prevStats.values.outboundRtp.roundTripTimeMeasurements,
      )
      // encode and sent latency
      if (values.outboundRtp.kind === 'video') {
        values.outboundRtp.encodeLatency = averageFromTotal(
          values.outboundRtp.totalEncodeTime,
          prevStats.values.outboundRtp.totalEncodeTime,
          values.outboundRtp.packetsSent,
          prevStats.values.outboundRtp.packetsSent,
        )
        values.outboundRtp.sentLatency = averageFromTotal(
          values.outboundRtp.totalPacketSendDelay,
          prevStats.values.outboundRtp.totalPacketSendDelay,
          values.outboundRtp.packetsSent,
          prevStats.values.outboundRtp.packetsSent,
        )
      }
    }
    values.outboundRtp = filterUndefined(values.outboundRtp) as OutboundRtpStats
    return { trackId, values }
  }
}

async function getReceiverStats(receiver: RTCRtpReceiver, pc: RTCPeerConnection, now: number, raw = false) {
  const track = receiver.track
  if (!track) {
    return
  }
  const trackId = overrides.getReceiverParticipantName(track) + '-' + track.kind[0]
  const stats = await pc.getStats(track)
  const values: InboundTrackStats = {
    enabled: isRecvTrackEnabled(track),
    inboundRtp: {} as InboundRtpStats,
    isDisplay: track.kind === 'video' && overrides.isReceiverDisplayTrack(track),
    videoReceivedActiveEncodings: 0,
    codec: '',
    availableIncomingBitrate: 0,
    remoteAddress: '',
  }
  for (const s of stats.values()) {
    const contributingSources = receiver.getSynchronizationSources()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captureTimestamp: number | undefined = (contributingSources[0] as any)?.captureTimestamp
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const senderCaptureTimeOffset: number | undefined = (contributingSources[0] as any)?.senderCaptureTimeOffset
    let endToEndDelay: number | undefined
    if (contributingSources.length && captureTimestamp && senderCaptureTimeOffset !== undefined) {
      endToEndDelay =
        (contributingSources[0].timestamp - (captureTimestamp + senderCaptureTimeOffset - 2208988800000)) / 1000
    }
    if (raw) {
      if (!values.raw) {
        values.raw = { contributingSources, stats: {} }
      }
      values.raw.stats[s.type] = s
    }
    if (s.type === 'codec') {
      values.codec = s.mimeType.split('/')[1].toLowerCase()
    } else if (s.type === 'inbound-rtp' && s.kind === track.kind && s.bytesReceived + s.headerBytesReceived > 0) {
      Object.assign(values.inboundRtp, {
        kind: s.kind,
        packetsLost: s.packetsLost,
        packetsReceived: s.packetsReceived,
        retransmittedPacketsReceived: s.retransmittedPacketsReceived,
        jitter: s.jitter,
        bytesReceived: s.bytesReceived,
        headerBytesReceived: s.headerBytesReceived,
        decoderImplementation: s.decoderImplementation,
        framesDecoded: s.framesDecoded,
        totalDecodeTime: s.totalDecodeTime,
        framesReceived: s.framesReceived,
        frameWidth: s.frameWidth,
        frameHeight: s.frameHeight,
        frameRate: s.framesPerSecond,
        firCount: s.firCount,
        pliCount: s.pliCount,
        nackCount: s.nackCount,
        freezeCount: s.freezeCount,
        totalFreezesDuration: s.totalFreezesDuration,
        jitterBufferEmittedCount: s.jitterBufferEmittedCount,
        jitterBufferDelay: s.jitterBufferDelay,
        totalRoundTripTime: s.totalRoundTripTime,
        roundTripTimeMeasurements: s.roundTripTimeMeasurements,
        totalAudioEnergy: s.totalAudioEnergy,
        totalSamplesDuration: s.totalSamplesDuration,
        totalSamplesReceived: s.totalSamplesReceived,
        concealedSamples: s.concealedSamples,
        concealmentEvents: s.concealmentEvents,
        insertedSamplesForDeceleration: s.insertedSamplesForDeceleration,
        removedSamplesForAcceleration: s.removedSamplesForAcceleration,
        keyFramesDecoded: s.keyFramesDecoded,
        captureTimestamp,
        senderCaptureTimeOffset,
        estimatedPlayoutTimestamp: s.estimatedPlayoutTimestamp,
        endToEndDelay,
      })
    } else if (s.type === 'remote-candidate') {
      values.remoteAddress = s.address
    } else if (s.type === 'candidate-pair' && s.nominated) {
      Object.assign(values.inboundRtp, {
        transportTotalRoundTripTime: s.totalRoundTripTime,
        transportResponsesReceived: s.responsesReceived,
      })
    }
  }
  if (values.inboundRtp.kind && values.inboundRtp.bytesReceived + values.inboundRtp.headerBytesReceived > 0) {
    if (trackStats.has(trackId)) {
      const prevStats = trackStats.get(trackId) as { t: number; values: InboundTrackStats }
      // Update bitrate.
      values.inboundRtp.bitrate =
        averageFromTotal(
          8 * (values.inboundRtp.bytesReceived + values.inboundRtp.headerBytesReceived),
          8 * (prevStats.values.inboundRtp.bytesReceived + prevStats.values.inboundRtp.headerBytesReceived),
          now / 1000,
          prevStats.t / 1000,
        ) ?? 0
      // Update video framesPerSecond.
      if (values.inboundRtp.kind === 'video' && values.inboundRtp.keyFramesDecoded > 0) {
        values.inboundRtp.framesPerSecond =
          averageFromTotal(
            values.inboundRtp.framesReceived,
            prevStats.values.inboundRtp.framesReceived,
            now / 1000,
            prevStats.t / 1000,
          ) ?? 0
      }
      // Update packet loss rate.
      const lost = positiveDiff(values.inboundRtp.packetsLost, prevStats.values.inboundRtp.packetsLost)
      const received = positiveDiff(values.inboundRtp.packetsReceived, prevStats.values.inboundRtp.packetsReceived)
      values.inboundRtp.packetsLossRate = calculateLossRate(lost, lost + received)
      // Update jitter buffer.
      values.inboundRtp.jitterBuffer = calculateJitterBuffer(
        values.inboundRtp.jitterBufferDelay - prevStats.values.inboundRtp.jitterBufferDelay,
        values.inboundRtp.jitterBufferEmittedCount - prevStats.values.inboundRtp.jitterBufferEmittedCount,
      )
      // Update round trip time.
      values.inboundRtp.transportRoundTripTime = averageFromTotal(
        values.inboundRtp.transportTotalRoundTripTime,
        prevStats.values.inboundRtp.transportTotalRoundTripTime,
        values.inboundRtp.transportResponsesReceived,
        prevStats.values.inboundRtp.transportResponsesReceived,
      )
      // Update decode latency.
      if (values.inboundRtp.kind === 'video') {
        values.inboundRtp.decodeLatency = averageFromTotal(
          values.inboundRtp.totalDecodeTime,
          prevStats.values.inboundRtp.totalDecodeTime,
          values.inboundRtp.framesDecoded,
          prevStats.values.inboundRtp.framesDecoded,
        )
      }
      // Update audio level.
      if (values.inboundRtp.kind === 'audio') {
        const energy = positiveDiff(values.inboundRtp.totalAudioEnergy, prevStats.values.inboundRtp.totalAudioEnergy)
        const samples = positiveDiff(
          values.inboundRtp.totalSamplesDuration,
          prevStats.values.inboundRtp.totalSamplesDuration,
        )
        values.inboundRtp.audioLevel = samples > 0 ? Math.sqrt(energy / samples) : undefined
      }
    }
    values.inboundRtp = filterUndefined(values.inboundRtp) as InboundRtpStats
    return { trackId, values }
  }
}

/**
 * It gets the PeerConnection stats.
 * @param {number} id
 * @param {RTCPeerConnection} pc
 * @param {number} now
 * @param {raw} verbose
 * @param {boolean} verbose
 */
async function getPeerConnectionStats(id: number, pc: RTCPeerConnection, now: number, raw = false, verbose = false) {
  const ret: Record<string, OutboundTrackStats | InboundTrackStats> = {}
  const transceivers = pc.getTransceivers().filter((t) => t && t.mid !== 'probator')
  if (verbose) {
    log('getPeerConnectionStats', { id, pc, transceivers })
  }
  await Promise.all(
    transceivers.map(async (t) => {
      if (t.sender && t.sender.track) {
        const stats = await getSenderStats(t.sender, pc, now, raw)
        if (stats) {
          const { trackId, values } = stats
          const track = t.sender.track
          if (verbose) {
            log(`send track ${trackId} (${track.kind}): ${JSON.stringify(values.outboundRtp, null, 2)}`)
          }
          ret[trackId] = values
          updateTrackStats(trackId, track, now, values)
        }
      }
      if (t.receiver && t.receiver.track) {
        const stats = await getReceiverStats(t.receiver, pc, now, raw)
        if (stats) {
          const { trackId, values } = stats
          const track = t.receiver.track
          if (verbose) {
            log(`recv track ${trackId} (${track.kind}): ${JSON.stringify(values.inboundRtp, null, 2)}`)
          }
          ret[trackId] = values
          updateTrackStats(trackId, track, now, values)
        }
      }
    }),
  )
  return ret
}

const TRACK_STATS_TIMEOUT = 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [index, trackId] of trackStatsKeys.entries()) {
    const item = trackStats.get(trackId)
    if (!item) {
      trackStatsKeys.splice(index, 1)
      continue
    }
    const timeDiff = now - item.t
    if (timeDiff > TRACK_STATS_TIMEOUT) {
      trackStats.delete(trackId)
      trackStatsKeys.splice(index, 1)
    } else {
      break
    }
  }
}, TRACK_STATS_TIMEOUT)

/**
 * collectPeerConnectionStats
 * @param {boolean} verbose
 * @return {Object}
 */
export async function collectPeerConnectionStats(raw = false, verbose = false) {
  const stats: Record<string, OutboundTrackStats | InboundTrackStats>[] = []
  const now = Date.now()
  let activePeerConnections = 0
  await Promise.all(
    Array.from(PeerConnections.entries()).map(async ([id, pc]) => {
      if (pc.connectionState !== 'connected') {
        return
      }
      activePeerConnections += 1
      try {
        const ret = await getPeerConnectionStats(id, pc, now, raw, verbose)
        if (Object.keys(ret).length) {
          stats.push(ret)
        }
      } catch (err) {
        log(`getPeerConnectionStats error: ${err instanceof Error ? err.message : String(err)}`, err)
      }
    }),
  )

  return {
    stats,
    signalingHost,
    participantName: overrides.getParticipantName(),
    activePeerConnections,
    peerConnectionConnectionTime: connectionTimer.onDuration,
    peerConnectionDisconnectionTime: connectionTimer.offDuration,
    peerConnectionsCreated,
    peerConnectionsConnected,
    peerConnectionsDisconnected,
    peerConnectionsFailed,
    peerConnectionsClosed,
    peerConnectionsDelay: peerConnectionsDelayStats.mean(),
  }
}
