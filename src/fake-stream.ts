import { log } from './common'

type MediaStreamTrackExt = MediaStreamTrack & {
  _width?: number
  _height?: number
}

function mediaTrackConstraintsToResolution(constraints?: MediaTrackConstraints) {
  if (!constraints) {
    return { width: 0, height: 0 }
  }
  let w = 0
  let h = 0
  if (typeof constraints === 'object') {
    const { width, height } = constraints
    if (width) {
      w = typeof width === 'number' ? width : width.exact || width.ideal || 0
    }
    if (height) {
      h = typeof height === 'number' ? height : height.exact || height.ideal || 0
    }
  }
  return { width: w, height: h }
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

  async getTrack(kind: 'audio' | 'video', constraints?: MediaTrackConstraints): Promise<MediaStreamTrack> {
    const stream = await this.streamPromise
    const track = stream.getTracks().find((track) => track.kind === kind)
    if (!track) {
      throw new Error(`[FakeStream] track ${kind} not found`)
    }
    let clonedTrack: MediaStreamTrackExt

    if (kind === 'video') {
      const { readable } = new window.MediaStreamTrackProcessor({ track })
      clonedTrack = new window.MediaStreamTrackGenerator({ kind: 'video' })
      const { width, height } = mediaTrackConstraintsToResolution(constraints)
      clonedTrack._width = width
      clonedTrack._height = height
      const transformStream = new window.TransformStream(
        {
          async transform(videoFrame: VideoFrame, controller) {
            let { codedWidth, codedHeight } = videoFrame
            let { x, y } = { x: 0, y: 0 }
            let { _width, _height } = clonedTrack
            if (_width === codedWidth && _height === codedHeight) {
              controller.enqueue(videoFrame)
              return
            }
            const aspectRatio = codedWidth / codedHeight
            if (!_height && _width) {
              _height = Math.round(_width / aspectRatio)
            } else if (!_width && _height) {
              _width = Math.round(_height * aspectRatio)
            } else if (!_width && !_height) {
              _width = codedWidth
              _height = codedHeight
            }
            if (!_width || !_height) {
              videoFrame.close()
              return
            }
            const requestedAspectRatio = _width / _height
            if (aspectRatio > requestedAspectRatio) {
              const w = Math.round(codedHeight * requestedAspectRatio)
              x = Math.round((codedWidth - w) / 2)
              codedWidth = w
            } else if (aspectRatio < requestedAspectRatio) {
              const h = Math.round(codedWidth / requestedAspectRatio)
              y = Math.round((codedHeight - h) / 2)
              codedHeight = h
            }
            const bitmap = await createImageBitmap(videoFrame, x, y, codedWidth, codedHeight, {
              resizeWidth: _width,
              resizeHeight: _height,
              resizeQuality: 'high',
            })
            videoFrame.close()
            const newFrame = new VideoFrame(bitmap, { timestamp: videoFrame.timestamp })
            bitmap.close()
            controller.enqueue(newFrame)
          },
          flush(controller) {
            controller.terminate()
          },
        },
        new CountQueuingStrategy({ highWaterMark: 1 }),
      )
      readable
        .pipeThrough(transformStream)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .pipeTo((clonedTrack as any).writable)
        .catch((err: unknown) => {
          log(`[FakeStream] error: ${(err as Error).message}`)
        })
    } else {
      clonedTrack = track.clone()
    }

    const clonedTrackStop = clonedTrack.stop.bind(clonedTrack)
    clonedTrack.stop = () => {
      clonedTrackStop()
      this.decRefcount()
    }
    clonedTrack.getSettings = () => {
      const settings = track.getSettings()
      return {
        ...settings,
        width: clonedTrack._width,
        height: clonedTrack._height,
      }
    }
    clonedTrack.applyConstraints = async (constraints) => {
      if (!constraints || kind !== 'video') return
      const { _width, _height } = clonedTrack
      const { width, height } = mediaTrackConstraintsToResolution(constraints)
      if (_width === undefined || _height === undefined || (_width === width && _height === height)) return
      log(`[FakeStream] id: ${clonedTrack.id} applyConstraints: ${width}x${height}`)
      clonedTrack._width = width
      clonedTrack._height = height
    }
    this.incRefcount()
    const trackSettings = clonedTrack.getSettings()
    log(
      `[FakeStream] getTrack ${kind}: ${clonedTrack.id} count: ${this.refcount} trackSettings: ${JSON.stringify(trackSettings)}`,
    )
    return clonedTrack
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
