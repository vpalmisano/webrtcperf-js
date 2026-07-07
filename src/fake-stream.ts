import { log, sleep } from './common'
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'worker-timers'

export async function openMediaPicker() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*,audio/*'
  input.multiple = true
  const files = await new Promise<File[]>((resolve) => {
    input.onchange = () => {
      resolve(input.files ? Array.from(input.files) : [])
    }
    input.click()
  })
  return files
}

export const STORAGE_DIRECTORY = 'webrtcperf'

/**
 * Opens a writable stream to save a file in the browser's storage.
 * @param name - The name of the file to create or overwrite.
 * @returns A writable stream for the file.
 */
export async function createMediaStorageWritable(name: string) {
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY, { create: true })
  const handle = await storageDir.getFileHandle(name, { create: true })
  return handle.createWritable()
}

/**
 * It saves the files to the browser's storage and returns the storage:// URLs of the saved files.
 * @param files - The files to save to storage. If not provided, it will open a file picker to select files.
 * @returns The storage:// URLs of the saved files.
 */
export async function saveMediaToStorage(...files: (File | string)[]) {
  if (files.length === 0) {
    files = await openMediaPicker()
  }
  if (files.length === 0) return []
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY, { create: true })
  const urls: string[] = []
  for (const file of files) {
    let name: string
    let type: string
    if (file instanceof File) {
      name = file.name
      type = file.type
    } else {
      name = (file as string).split('/').pop()!
      type = ''
    }
    const handle = await storageDir.getFileHandle(name, { create: true })
    const fd = await handle.createWritable()
    if (file instanceof File) {
      const blob = new Blob([file], { type })
      await fd.write(blob)
    } else {
      const res = await fetch(new URL(file as string), {
        referrerPolicy: 'no-referrer',
        credentials: 'omit',
      })
      const blob = await res.blob()
      await fd.write(blob)
    }
    await fd.close()
    urls.push(`storage://${STORAGE_DIRECTORY}/${name}`)
  }
  return urls
}

/**
 * It loads the file from the browser's storage and returns the URL.
 * @param name - The name of the file to load from storage.
 * @returns The Object URL of the loaded file.
 */
export async function loadMediaFromStorage(name: string) {
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY)
  const handle = await storageDir.getFileHandle(name)
  const file = await handle.getFile()
  return URL.createObjectURL(file)
}

/**
 * It downloads the file from the browser's storage and saves it to the user's download directory.
 * @param name - The name of the file to download from storage.
 */
export async function downloadMediaFromStorage(name: string) {
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY)
  if (name.startsWith(`storage://${STORAGE_DIRECTORY}/`)) {
    name = name.replace(`storage://${STORAGE_DIRECTORY}/`, '')
  }
  const handle = await storageDir.getFileHandle(name)
  const file = await handle.getFile()
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * It deletes the file from the browser's storage.
 * @param name - The name of the file to delete from storage.
 * @returns A promise that resolves when the file is deleted.
 */
export async function deleteMediaFromStorage(name: string) {
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY)
  if (name.startsWith(`storage://${STORAGE_DIRECTORY}/`)) {
    name = name.replace(`storage://${STORAGE_DIRECTORY}/`, '')
  }
  await storageDir.removeEntry(name)
}

/**
 * It lists all the files in the browser's storage.
 * @returns The names of the files in the storage.
 */
export async function listMediaFiles() {
  const storageRoot = await navigator.storage.getDirectory()
  const storageDir = await storageRoot.getDirectoryHandle(STORAGE_DIRECTORY)
  const names: string[] = []
  for await (const [name, handle] of storageDir.entries()) {
    if (handle.kind === 'file') {
      names.push(`storage://${STORAGE_DIRECTORY}/${name}`)
    }
  }
  return names.sort()
}

function clampConstraint(value: ConstrainULong, maxValue: number) {
  if (typeof value === 'number') {
    return Math.min(value, maxValue)
  } else {
    if (typeof value.exact === 'number') {
      value.exact = Math.min(value.exact, maxValue)
    }
    if (typeof value.ideal === 'number') {
      value.ideal = Math.min(value.ideal, maxValue)
    }
    return value
  }
}

export type ExtHTMLVideoElement = HTMLVideoElement & { captureStream: () => MediaStream }

export class FakeStreamManager {
  public drawTimestamp: boolean
  public audioTickDuration: number

  private readonly videoCanvas: HTMLCanvasElement
  private readonly width = 1920
  private readonly height = 1080
  private readonly frameRate = 30
  private readonly videoTrack: MediaStreamTrack

  private readonly audioCtx: AudioContext
  private audioSource?: MediaStreamAudioSourceNode
  private readonly audioDest: MediaStreamAudioDestinationNode
  private readonly audioTrack: MediaStreamTrack

  private readonly element: ExtHTMLVideoElement
  public url: string | null = null
  private stream: MediaStream | null = null
  private pauseTimeout: ReturnType<typeof setTimeout> | null = null
  private refcount = 0
  private audioOscillator?: OscillatorNode
  private audioGain?: GainNode
  private audioPlaceholderInterval: ReturnType<typeof setInterval> | null = null
  private videoPlaceholderInterval: ReturnType<typeof setInterval> | null = null

  constructor({
    drawTimestamp = false,
    audioTickDuration = 0,
  }: {
    drawTimestamp?: boolean
    audioTickDuration?: number
  } = {}) {
    this.drawTimestamp = drawTimestamp
    this.audioTickDuration = audioTickDuration

    this.videoCanvas = document.createElement('canvas')
    this.videoCanvas.width = this.width
    this.videoCanvas.height = this.height
    const ctx = this.videoCanvas.getContext('2d')!
    ctx.fillStyle = 'black'
    ctx.fillRect(0, 0, this.videoCanvas.width, this.videoCanvas.height)
    this.videoTrack = this.videoCanvas.captureStream(this.frameRate).getVideoTracks()[0]
    this.startVideoPlaceholder()

    this.audioCtx = new AudioContext({
      latencyHint: 'interactive',
      sampleRate: 48000,
    })
    this.audioDest = this.audioCtx.createMediaStreamDestination()
    this.audioTrack = this.audioDest.stream.getAudioTracks()[0]
    this.startAudioPlaceholder()

    this.element = document.createElement('video') as ExtHTMLVideoElement
    this.element.crossOrigin = 'anonymous'
    this.element.loop = true
    this.element.muted = true
  }

  startAudioCtx() {
    if (this.audioCtx.state !== 'running') {
      this.audioCtx.resume().catch((err) => log('[FakeStreamManager] startAudioCtx resume error:', err))
    }
  }

  startAudioPlaceholder() {
    if (!this.audioOscillator) {
      this.audioOscillator = this.audioCtx.createOscillator()
      this.audioOscillator.frequency.value = 440
      this.audioGain = this.audioCtx.createGain()
      this.audioGain.gain.value = 0
      this.audioOscillator.connect(this.audioGain)
      this.audioGain.connect(this.audioDest)
      this.audioOscillator.start()
    }

    if (!this.audioPlaceholderInterval) {
      this.audioPlaceholderInterval = setInterval(() => {
        if (this.audioTickDuration) {
          const now = this.audioCtx.currentTime
          this.audioGain?.gain.setValueAtTime(1, now)
          this.audioGain?.gain.setValueAtTime(0, now + this.audioTickDuration)
        }
      }, 1000)
    }
  }

  stopAudioPlaceholder() {
    if (this.audioOscillator && this.audioGain) {
      this.audioOscillator.stop()
      this.audioOscillator.disconnect(this.audioGain)
      this.audioOscillator = undefined
      this.audioGain.disconnect(this.audioDest)
      this.audioGain = undefined
    }
    if (this.audioPlaceholderInterval) {
      clearInterval(this.audioPlaceholderInterval)
      this.audioPlaceholderInterval = null
    }
  }

  startVideoPlaceholder() {
    if (this.videoPlaceholderInterval) {
      return
    }
    const ctx = this.videoCanvas.getContext('2d')!
    const { width, height } = this
    const radius = Math.round(Math.min(this.width, this.height) / 20)
    let x = width / 2
    let y = height / 2
    let dx = Math.round(6 + Math.random() * 4)
    let dy = Math.round(5 + Math.random() * 4)
    if (Math.random() < 0.5) dx = -dx
    if (Math.random() < 0.5) dy = -dy

    this.videoPlaceholderInterval = setInterval(() => {
      x += dx
      y += dy

      if (x - radius <= 0) {
        x = radius
        dx = Math.abs(dx) * (0.8 + Math.random() * 0.4)
        dy += (Math.random() - 0.5) * 4
      } else if (x + radius >= width) {
        x = width - radius
        dx = -Math.abs(dx) * (0.8 + Math.random() * 0.4)
        dy += (Math.random() - 0.5) * 4
      }
      if (y - radius <= 0) {
        y = radius
        dy = Math.abs(dy) * (0.8 + Math.random() * 0.4)
        dx += (Math.random() - 0.5) * 4
      } else if (y + radius >= height) {
        y = height - radius
        dy = -Math.abs(dy) * (0.8 + Math.random() * 0.4)
        dx += (Math.random() - 0.5) * 4
      }

      const speed = Math.hypot(dx, dy)
      const minSpeed = 5
      const maxSpeed = 20
      if (speed < minSpeed) {
        dx = (dx / speed) * minSpeed
        dy = (dy / speed) * minSpeed
      } else if (speed > maxSpeed) {
        dx = (dx / speed) * maxSpeed
        dy = (dy / speed) * maxSpeed
      }

      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, width, height)

      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fillStyle = 'red'
      ctx.fill()

      if (this.drawTimestamp) {
        this.drawVideoTimestamp()
      }
    }, 1000 / this.frameRate)
  }

  stopVideoPlaceholder() {
    if (this.videoPlaceholderInterval) {
      clearInterval(this.videoPlaceholderInterval)
      this.videoPlaceholderInterval = null
    }
  }

  drawVideoTimestamp() {
    const now = new Date()
    const timestamp = now.toISOString().replace('T', ' ').replace('Z', '')
    const ctx = this.videoCanvas.getContext('2d')!
    const size = Math.round(Math.min(this.videoCanvas.width, this.videoCanvas.height) / 15)
    const x = this.videoCanvas.width / 2
    const y = this.videoCanvas.height / 2
    ctx.font = `${size}px "Noto Mono", monospace`
    ctx.fillStyle = 'white'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(timestamp, x, y)
  }

  /**
   * It sets the media to the element and plays it.
   * @param url - The URL of the media to set. If it starts with "storage://", it will load the media from the browser's storage.
   * @param loop - Whether to loop the media.
   * @returns A promise that resolves when the media is set.
   */
  async setMedia(url: string, loop = true) {
    if (!url) {
      return
    }
    if (this.url === url) {
      this.play(loop)
      return
    }
    this.stopMedia()
    log(`[FakeStreamManager] setMedia "${url}" ${loop ? '(loop)' : ''}`)
    this.element.src = url.startsWith('storage://')
      ? await loadMediaFromStorage(url.replace(`storage://${STORAGE_DIRECTORY}/`, ''))
      : url
    this.stream = await new Promise<MediaStream>((resolve, reject) => {
      const onLoad = () => {
        this.element.removeEventListener('error', onError)
        resolve(this.element.captureStream())
      }
      const onError = (err: unknown) => {
        log(`[FakeStreamManager] setMedia create stream error:`, err)
        this.element.removeEventListener('loadeddata', onLoad)
        this.stopMedia(err)
        reject(err)
      }
      this.element.addEventListener('loadeddata', onLoad, { once: true })
      this.element.addEventListener('error', onError, { once: true })
      this.element.play().catch((err) => log('[FakeStreamManager] setMedia play error:', err))
    })

    if (!loop) {
      this.stopAtEnd()
    }

    const videoTrack = this.stream.getVideoTracks()[0]
    if (videoTrack) {
      this.stopVideoPlaceholder()
      const { readable } = new window.MediaStreamTrackProcessor({ track: videoTrack })
      const { width, height } = this
      const ctx = this.videoCanvas.getContext('2d')!

      const stop = (err?: unknown) => {
        log(`[FakeStreamManager] setMedia writableStream stop:`, err)
        ctx.fillStyle = 'black'
        ctx.fillRect(0, 0, width, height)
        this.stopMedia(err)
        this.startVideoPlaceholder()
      }
      const drawTimestamp = () => {
        if (this.drawTimestamp) {
          this.drawVideoTimestamp()
        }
      }
      const writableStream = new window.WritableStream(
        {
          async write(videoFrame: VideoFrame) {
            let { codedWidth, codedHeight } = videoFrame
            let { x, y } = { x: 0, y: 0 }

            if (width === codedWidth && height === codedHeight) {
              ctx.drawImage(videoFrame, 0, 0, width, height)
            } else {
              const aspectRatio = codedWidth / codedHeight
              const requestedAspectRatio = width / height
              if (aspectRatio > requestedAspectRatio) {
                const w = Math.round(codedHeight * requestedAspectRatio)
                x = Math.round((codedWidth - w) / 2)
                codedWidth = w
              } else if (aspectRatio < requestedAspectRatio) {
                const h = Math.round(codedWidth / requestedAspectRatio)
                y = Math.round((codedHeight - h) / 2)
                codedHeight = h
              }
              ctx.drawImage(videoFrame, x, y, codedWidth, codedHeight, 0, 0, width, height)
            }
            drawTimestamp()
            videoFrame.close()
          },
          close() {
            stop('close')
          },
          abort(err) {
            stop(err)
          },
        },
        new CountQueuingStrategy({ highWaterMark: 1 }),
      )
      readable
        .pipeTo(writableStream)
        .catch((err: unknown) => log(`[FakeStreamManager] setMedia error: ${(err as Error).message}`))
    } else {
      this.startVideoPlaceholder()
    }

    const audioTrack = this.stream.getAudioTracks()[0]
    if (audioTrack) {
      this.stopAudioPlaceholder()
      this.audioSource = this.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]))
      this.audioSource.connect(this.audioDest)
      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume()
      }
    } else {
      this.startAudioPlaceholder()
    }

    this.url = url
  }

  stopMedia(event?: unknown) {
    if (!this.url) {
      return
    }
    log('[FakeStreamManager] stopMedia', { url: this.url, event })
    this.url = null
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout)
      this.pauseTimeout = null
    }
    const src = this.element.src
    this.element.pause()
    this.element.src = ''
    URL.revokeObjectURL(src)
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    if (this.audioSource) {
      this.audioSource.disconnect(this.audioDest)
      this.audioSource = undefined
      this.startAudioPlaceholder()
    }
  }

  private stopAtEnd() {
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout)
      this.pauseTimeout = null
    }
    this.pauseTimeout = setTimeout(() => this.stopMedia(), this.element.duration * 1000)
  }

  play(loop = false) {
    if (!this.url) {
      return
    }
    log(`[FakeStreamManager] play ${loop ? '(loop)' : ''}`)
    this.element.currentTime = 0
    this.element.play().catch((err) => log('[FakeStreamManager] play error:', err))
    if (!loop) {
      this.stopAtEnd()
    }
  }

  pause() {
    if (!this.url) {
      return
    }
    if (this.pauseTimeout) {
      clearTimeout(this.pauseTimeout)
      this.pauseTimeout = null
    }
    this.element.pause()
  }

  sync(currentTime?: number) {
    if (!this.url) {
      return
    }
    if (currentTime !== undefined) {
      this.element.currentTime = currentTime
    }
    this.element.play()
  }

  get currentTime() {
    return this.element.currentTime
  }

  get duration() {
    return this.element.duration
  }

  get paused() {
    return this.element.paused
  }

  get muted() {
    return this.element.muted
  }

  set muted(muted: boolean) {
    this.element.muted = muted
  }

  get volume() {
    return this.element.volume
  }

  set volume(volume: number) {
    this.element.volume = volume
  }

  private incRefcount() {
    this.refcount++
    if (this.element.src && this.element.paused) {
      this.element.play().catch((err) => log('[FakeStreamManager] incRefcount play error:', err))
    }
  }

  private decRefcount() {
    this.refcount = Math.max(this.refcount - 1, 0)
    if (this.element.src && this.refcount === 0) {
      this.element.pause()
    }
  }

  private clonedTracks = new Set<MediaStreamTrack>()

  /**
   * Returns a cloned track.
   * @param kind - The kind of track to get.
   * @param constraints - The constraints to apply to the track.
   * @returns A promise that resolves when the track is cloned.
   */
  async getTrack(kind: 'video' | 'audio', constraints?: MediaTrackConstraints) {
    log(
      `[FakeStreamManager] getTrack ${kind} refcount: ${this.refcount}, constraints: ${JSON.stringify(constraints ?? {})}`,
    )
    const track = kind === 'video' ? this.videoTrack.clone() : this.audioTrack.clone()
    this.clonedTracks.add(track)
    const trackStop = track.stop.bind(track)
    let stopped = false
    track.stop = () => {
      if (stopped) {
        return
      }
      stopped = true
      log('[FakeStreamManager] getTrack stop')
      trackStop()
      this.decRefcount()
      this.clonedTracks.delete(track)
    }
    this.incRefcount()
    if (constraints) {
      delete constraints.deviceId
      if (constraints.width) {
        constraints.width = clampConstraint(constraints.width, this.width)
      }
      if (constraints.height) {
        constraints.height = clampConstraint(constraints.height, this.height)
      }
      if (constraints.frameRate) {
        constraints.frameRate = clampConstraint(constraints.frameRate, this.frameRate)
      }
      try {
        await track.applyConstraints(constraints)
      } catch (err) {
        log(`[FakeStreamManager] getTrack applyConstraints error:`, err)
      }
    }
    return track
  }

  /**
   * Ends all the cloned tracks.
   * @param kind - The kind of track to end. If not provided, all the cloned tracks will be ended.
   */
  endTracks(kind?: 'video' | 'audio') {
    for (const track of this.clonedTracks) {
      if (kind === undefined || track.kind === kind) {
        track.dispatchEvent(new Event('ended'))
      }
    }
  }
}

export const fakeStreamManager = new FakeStreamManager()

/**
 * It sets the media to the fake stream manager and plays it.
 * @param url - The URL of the media to set. If it starts with "storage://", it will load the media from the browser's storage.
 * @param loop - Whether to loop the media.
 * @returns A promise that resolves when the media is set.
 */
export function setMedia(url: string, loop = false) {
  return fakeStreamManager.setMedia(url, loop)
}

/**
 * It stops the media from the fake stream manager.
 * @returns A promise that resolves when the media is stopped.
 */
export function stopMedia() {
  return fakeStreamManager.stopMedia('stopMedia')
}

/**
 * It sets the media to the fake stream manager and plays it from the browser's storage.
 * @param indexOrName - The index or name (or part of the name) of the media to set.
 * @param loop - Whether to loop the media.
 * @returns A promise that resolves when the media is set.
 */
export async function setMediaFromStorage(indexOrName: number | string, loop = false) {
  const names = await listMediaFiles()
  let name: string | undefined
  if (typeof indexOrName === 'number') {
    name = names[indexOrName]
  } else {
    name = names.find((name) => name.toLowerCase().includes(indexOrName.toLowerCase()))
  }
  if (!name) {
    return
  }
  return fakeStreamManager.setMedia(name, loop)
}

/**
 * It sets the media playlist to the fake stream manager and plays it from the browser's storage.
 * @param indexOrNames - The indexes or names (or parts of the names) of the media to set.
 * @param waitTime - The time to wait before playing the next media (seconds).
 * @returns A promise that resolves when the media playlist is set.
 */
export async function setMediaPlaylistFromStorage(indexOrNames: (number | string)[], waitTime = 0) {
  log(`[FakeStreamManager] setMediaPlaylistFromStorage:`, indexOrNames, waitTime)
  for (const indexOrName of indexOrNames) {
    await setMediaFromStorage(indexOrName)
    const waitTimeMs = (waitTime + fakeStreamManager.duration) * 1000
    await sleep(waitTimeMs)
    fakeStreamManager.stopMedia()
  }
}

/**
 * Synchronizes all the created fake tracks.
 * @param {number | undefined} [currentTime] - If specified, the current time to set.
 */
export function syncFakeTracks(currentTime?: number) {
  fakeStreamManager.sync(currentTime)
}
