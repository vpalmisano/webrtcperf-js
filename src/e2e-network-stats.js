/* global webrtcperf */

/**
 * Video end-to-end network delay stats.
 * @type MeasuredStats
 */
const videoEndToEndNetworkDelayStats = new webrtcperf.MeasuredStats({ ttl: 30 })

webrtcperf.collectVideoEndToEndNetworkDelayStats = () => {
  return videoEndToEndNetworkDelayStats.mean()
}

function dumpFrame(encodedFrame, direction, offset = 0, end = 32) {
  const data = new Uint8Array(encodedFrame.data)
  let bytes = ''
  for (let j = offset; j < data.length && j < end; j++) {
    const value = data[j]
    if (value !== undefined) {
      bytes += (value < 16 ? '0' : '') + value.toString(16) + ' '
    }
  }
  console.webrtcperf.log(
    direction,
    'bytes=' + bytes.trim(),
    'len=' + encodedFrame.data.byteLength,
    'type=' + (encodedFrame.type || 'audio'),
    'ts=' + encodedFrame.timestamp,
    'ssrc=' + encodedFrame.getMetadata().synchronizationSource,
    'pt=' + (encodedFrame.getMetadata().payloadType || '(unknown)'),
  )
}

async function handleInsertableStreams(data, debug = false) {
  const { operation, track, readable, writable } = data
  // console.webrtcperf.log(`onmessage ${operation} ${track.kind}`)
  if (track.kind !== 'video') {
    readable.pipeTo(writable)
    return
  }
  let transformStream = null
  const insertableStreamsHeader = webrtcperf.stringToBinary('WP00')
  const headerSize = 20
  let writer = null

  if (operation === 'encode') {
    const prevPts = {}
    const { width: trackWidth, height: trackHeight } = track.getSettings()

    transformStream = new window.TransformStream({
      transform: (encodedFrame, controller) => {
        const timestamp = Date.now()
        const { width, height, synchronizationSource } = encodedFrame.getMetadata()
        if (prevPts[synchronizationSource] === undefined) {
          prevPts[synchronizationSource] = -1
        }
        let pts = prevPts[synchronizationSource] + 1
        prevPts[synchronizationSource] = pts

        if (writer && width === trackWidth && height === trackHeight) {
          /* webrtcperf.log(
            'send',
            encodedFrame.type,
            temporalIndex,
            pts,
            pts / frameRate,
            encodedFrame.timestamp / 90000,
            encodedFrame.getMetadata(),
          ) */
          try {
            writer.write(encodedFrame, pts)
          } catch (err) {
            webrtcperf.log('writer error', err)
          }
        }

        const newData = new ArrayBuffer(encodedFrame.data.byteLength + headerSize)
        const newView = new DataView(newData)
        new Uint8Array(newData).set(new Uint8Array(encodedFrame.data))
        const pos = encodedFrame.data.byteLength
        newView.setUint32(pos, insertableStreamsHeader, true)
        newView.setBigUint64(pos + 4, BigInt(timestamp), true)
        newView.setBigUint64(pos + 12, BigInt(pts), true)
        encodedFrame.data = newData
        if (debug) {
          dumpFrame(encodedFrame, 'e', encodedFrame.data.byteLength - headerSize, encodedFrame.data.byteLength)
        }
        controller.enqueue(encodedFrame)
      },
    })
  } else if (operation === 'decode') {
    transformStream = new window.TransformStream({
      transform: (encodedFrame, controller) => {
        if (debug) {
          dumpFrame(encodedFrame, 'd', encodedFrame.data.byteLength - headerSize, encodedFrame.data.byteLength)
        }
        const view = new DataView(encodedFrame.data)
        const pos = encodedFrame.data.byteLength - headerSize
        const header = view.getUint32(pos, true)
        if (header === insertableStreamsHeader) {
          const timestamp = Date.now()
          const ts = Number(view.getBigUint64(pos + 4, true))
          const pts = Number(view.getBigUint64(pos + 12, true))
          if (!transformStream._lastTimestamp || timestamp - transformStream._lastTimestamp > 1000) {
            const delay = timestamp - ts
            videoEndToEndNetworkDelayStats.push(timestamp, delay / 1000)
            transformStream._lastTimestamp = timestamp
            if (debug) {
              webrtcperf.log(`t: ${timestamp} delay: ${delay}ms`)
            }
          }
          const newData = encodedFrame.data.slice(0, encodedFrame.data.byteLength - headerSize)
          encodedFrame.data = newData

          if (writer) {
            /* webrtcperf.log(
              'recv',
              encodedFrame.type,
              pts,
              encodedFrame.timestamp / 90000,
              pts / webrtcperf.VIDEO_FRAMERATE,
              encodedFrame.getMetadata(),
            ) */
            try {
              writer.write(encodedFrame, pts)
            } catch (err) {
              webrtcperf.log('writer error', err)
            }
          }
        }
        controller.enqueue(encodedFrame)
      },
    })
  }
  readable.pipeThrough(transformStream).pipeTo(writable)
}

/**
 * handleTransceiverForInsertableStreams
 * @param {string} id
 * @param {RTCRtpTransceiver} transceiver
 */
webrtcperf.handleTransceiverForInsertableStreams = (id, transceiver) => {
  webrtcperf.log(`RTCPeerConnection-${id} handleTransceiverForInsertableStreams ${transceiver.direction}`)
  if (
    ['sendonly', 'sendrecv'].includes(transceiver.direction) &&
    transceiver.sender &&
    !transceiver.sender._encodedStreams &&
    transceiver.sender.track
  ) {
    webrtcperf.log(`RTCPeerConnection-${id} handleTransceiver sender transformStream ${transceiver.sender.track.kind}`)
    transceiver.sender._encodedStreams = transceiver.sender.createEncodedStreams()
    const { readable, writable } = transceiver.sender._encodedStreams
    const data = {
      operation: 'encode',
      track: transceiver.sender.track,
      readable,
      writable,
    }
    /* if (timestampInsertableStreamsWorker) {
      timestampInsertableStreamsWorker.postMessage(data, [readable, writable])
    } else { */
    handleInsertableStreams(data)
    /* } */
  }
  if (
    ['recvonly', 'sendrecv'].includes(transceiver.direction) &&
    transceiver.receiver &&
    !transceiver.receiver._encodedStreams &&
    transceiver.receiver.track
  ) {
    webrtcperf.log(
      `RTCPeerConnection-${id} handleTransceiver receiver transformStream ${transceiver.receiver.track.kind}`,
    )
    transceiver.receiver._encodedStreams = transceiver.receiver.createEncodedStreams()
    const { readable, writable } = transceiver.receiver._encodedStreams
    const data = {
      operation: 'decode',
      track: transceiver.receiver.track,
      readable,
      writable,
    }
    /* if (timestampInsertableStreamsWorker) {
      timestampInsertableStreamsWorker.postMessage(data, [readable, writable])
    } else { */
    handleInsertableStreams(data)
    /* } */
  }
}
