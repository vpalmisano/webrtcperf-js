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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TrackStats = new Map<string, { t: number; values: any }>()
const TrackStatsKeys: string[] = []

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
  if (a[prop] === undefined) {
    a[prop] = b[prop]
  } else if (b[prop] !== undefined) {
    a[prop] = Math.max(a[prop], b[prop])
  }
}

function calculateBitrate(cur: number, old: number, timeDiff: number, fallback = 0) {
  return cur > 0 && old > 0 && cur >= old ? Math.round((8000 * (cur - old)) / timeDiff) : fallback
}

function calculateRate(diff: number, timeDiff: number, fallback = 0) {
  return diff > 0 ? (1000 * diff) / timeDiff : fallback
}

function positiveDiff(cur: number, old: number) {
  return Math.max(0, (cur || 0) - (old || 0))
}

function calculateLossRate(lost: number, total: number) {
  return total > 0 ? (100 * lost) / total : undefined
}

function calculateJitterBuffer(jitterBufferDelay: number, count: number) {
  return count > 0 ? jitterBufferDelay / count : undefined
}

function updateTrackStats(trackId: string, track: MediaStreamTrack, t: number, values: Record<string, unknown>) {
  const isNew = !TrackStats.has(trackId)
  TrackStats.set(trackId, { t, values })
  // Update ordered array.
  const index = TrackStatsKeys.indexOf(trackId)
  if (index !== -1) {
    TrackStatsKeys.splice(index, 1)
  }
  TrackStatsKeys.push(trackId)
  if (isNew) {
    track.addEventListener(
      'ended',
      () => {
        TrackStats.delete(trackId)
        const index = TrackStatsKeys.indexOf(trackId)
        if (index !== -1) {
          TrackStatsKeys.splice(index, 1)
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
  const values = {
    enabled: track.enabled && (track.kind === 'audio' || encodings.length > 0),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    outboundRtp: {} as any,
    isDisplay: false,
    videoSentActiveEncodings: 0,
    sentMaxBitrate: undefined as number | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: undefined as any,
    codec: '',
    availableOutgoingBitrate: 0,
    remoteAddress: '',
  }
  if (track.kind === 'video') {
    values.isDisplay = overrides.isSenderDisplayTrack(track)
    values.videoSentActiveEncodings = encodings.length
  }
  values.sentMaxBitrate = encodings.length
    ? encodings.reduce((prev, encoding) => {
        prev += encoding.maxBitrate || 0
        return prev
      }, 0)
    : undefined
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
      const outboundRtp = {
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
        firCountReceived: s.firCountReceived,
        pliCountReceived: s.pliCountReceived,
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
      ].forEach((prop) => sumOptional(values.outboundRtp, outboundRtp, prop))
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
      ].forEach((prop) => maxOptional(values.outboundRtp, outboundRtp, prop))
    } else if (s.type === 'remote-candidate') {
      values.remoteAddress = s.address
    }
  }
  if (values.outboundRtp.kind && values.outboundRtp.bytesSent + values.outboundRtp.headerBytesSent > 0) {
    const prevStats = TrackStats.get(trackId)
    if (prevStats) {
      // bitrate
      values.outboundRtp.bitrate = calculateBitrate(
        values.outboundRtp.bytesSent + values.outboundRtp.headerBytesSent,
        prevStats.values.outboundRtp.bytesSent + prevStats.values.outboundRtp.headerBytesSent,
        now - prevStats.t,
        prevStats.values.outboundRtp.bitrate,
      )
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
      values.outboundRtp.roundTripTime =
        (values.outboundRtp.totalRoundTripTime - prevStats.values.outboundRtp.totalRoundTripTime) /
        (values.outboundRtp.roundTripTimeMeasurements - prevStats.values.outboundRtp.roundTripTimeMeasurements)
      // encode and sent latency
      if (values.outboundRtp.kind === 'video') {
        const packetsSentDiff = values.outboundRtp.packetsSent - prevStats.values.outboundRtp.packetsSent
        values.outboundRtp.encodeLatency =
          (values.outboundRtp.totalEncodeTime - prevStats.values.outboundRtp.totalEncodeTime) / packetsSentDiff
        values.outboundRtp.sentLatency =
          (values.outboundRtp.totalPacketSendDelay - prevStats.values.outboundRtp.totalPacketSendDelay) /
          packetsSentDiff
      }
    }
    values.outboundRtp = filterUndefined(values.outboundRtp)
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
  const values = {
    enabled: isRecvTrackEnabled(track),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inboundRtp: {} as any,
    isDisplay: track.kind === 'video' && overrides.isReceiverDisplayTrack(track),
    videoReceivedActiveEncodings: 0,
    receivedMaxBitrate: undefined as number | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    raw: undefined as any,
    codec: '',
    availableIncomingBitrate: 0,
    remoteAddress: '',
  }
  for (const s of stats.values()) {
    if (raw) {
      if (!values.raw) {
        values.raw = { contributingSources: receiver.getContributingSources(), stats: {} }
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
    const prevStats = TrackStats.get(trackId)
    if (prevStats) {
      // Update bitrate.
      values.inboundRtp.bitrate = calculateBitrate(
        values.inboundRtp.bytesReceived + values.inboundRtp.headerBytesReceived,
        prevStats.values.inboundRtp.bytesReceived + prevStats.values.inboundRtp.headerBytesReceived,
        now - prevStats.t,
      )
      // Update video framesPerSecond.
      if (values.inboundRtp.kind === 'video' && values.inboundRtp.keyFramesDecoded > 0) {
        const frames = positiveDiff(values.inboundRtp.framesReceived, prevStats.values.inboundRtp.framesReceived)
        values.inboundRtp.framesPerSecond = calculateRate(frames, now - prevStats.t)
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
      values.inboundRtp.transportRoundTripTime =
        (values.inboundRtp.transportTotalRoundTripTime - prevStats.values.inboundRtp.transportTotalRoundTripTime) /
        (values.inboundRtp.transportResponsesReceived - prevStats.values.inboundRtp.transportResponsesReceived)
      // Update latency.
      if (values.inboundRtp.kind === 'video') {
        values.inboundRtp.decodeLatency =
          (values.inboundRtp.totalDecodeTime - prevStats.values.inboundRtp.totalDecodeTime) /
          (values.inboundRtp.framesDecoded - prevStats.values.inboundRtp.framesDecoded)
      }
      // Update audio metrics.
      if (values.inboundRtp.kind === 'audio') {
        // Audio level.
        const energy = positiveDiff(values.inboundRtp.totalAudioEnergy, prevStats.values.inboundRtp.totalAudioEnergy)
        const samples = positiveDiff(
          values.inboundRtp.totalSamplesDuration,
          prevStats.values.inboundRtp.totalSamplesDuration,
        )
        values.inboundRtp.audioLevel = samples > 0 ? Math.sqrt(energy / samples) : undefined
      }
    }
    values.inboundRtp = filterUndefined(values.inboundRtp)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ret: Record<string, any> = {}
  const transceivers = pc.getTransceivers().filter((t) => t && t.mid !== 'probator')
  if (verbose) {
    log('getPeerConnectionStats', { id, pc, transceivers })
  }
  for (const t of transceivers) {
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
        const track = t.receiver.track
        if (verbose) {
          log(`recv track ${stats.trackId} (${track.kind}): ${JSON.stringify(stats.values.inboundRtp, null, 2)}`)
        }
        ret[stats.trackId] = stats.values
        updateTrackStats(stats.trackId, track, now, stats.values)
      }
    }
  }
  return ret
}

const TRACK_STATS_TIMEOUT = 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [index, trackId] of TrackStatsKeys.entries()) {
    const item = TrackStats.get(trackId)
    if (!item) {
      TrackStatsKeys.splice(index, 1)
      continue
    }
    const timeDiff = now - item.t
    if (timeDiff > TRACK_STATS_TIMEOUT) {
      // log(`remove ${trackId} (updated ${timeDiff / 1000}s ago)`)
      TrackStats.delete(trackId)
      TrackStatsKeys.splice(index, 1)
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
  const stats = []
  const now = Date.now()
  let activePeerConnections = 0
  for (const [id, pc] of PeerConnections.entries()) {
    if (pc.connectionState !== 'connected') {
      continue
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
  }

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
