import { Chart, ChartDataset, Plugin } from 'chart.js/auto'
import {
  collectPeerConnectionStats,
  InboundRtpStats,
  InboundTrackStats,
  OutboundRtpStats,
  OutboundTrackStats,
} from './peer-connection-stats'
import { log } from './common'
import { collectWebSocketStats } from './websocket'

const MAX_AGE_MS = 5 * 60 * 1000
const PLOT_WIDTH = 280
const PLOT_HEIGHT = 160
const HOST_ID = 'webrtcperf-plots'
const CLOSE_BUTTON_SIZE = 14

type Point = { x: number; y: number }
type Direction = 'outbound' | 'inbound'
type Kind = 'audio' | 'video' | 'websocket'

const GROUP_ORDER: Record<string, number> = {
  outbound_audio: 0,
  outbound_video: 1,
  outbound_websocket: 2,
  inbound_audio: 2,
  inbound_video: 3,
  inbound_websocket: 4,
}

const STAT_OPTIONS = {
  outbound: {
    audio: [
      'bitrate',
      'bytesSent',
      'headerBytesSent',
      'jitter',
      'nackCount',
      'packetsLost',
      'packetsLossRate',
      'packetsSent',
      'retransmittedPacketsSent',
      'roundTripTime',
      'roundTripTimeMeasurements',
      'totalRoundTripTime',
      'transportRoundTripTime',
    ] as (keyof OutboundRtpStats)[],
    video: [
      'bitrate',
      'bytesSent',
      'encodeLatency',
      'firCountReceived',
      'frameHeight',
      'framesPerSecond',
      'framesSent',
      'frameWidth',
      'headerBytesSent',
      'jitter',
      'nackCount',
      'packetsLost',
      'packetsLossRate',
      'packetsSent',
      'pliCountReceived',
      'qualityLimitationBandwidth',
      'qualityLimitationCpu',
      'qualityLimitationDurationsBandwidth',
      'qualityLimitationDurationsCpu',
      'qualityLimitationDurationsTotal',
      'qualityLimitationResolutionChanges',
      'retransmittedPacketsSent',
      'roundTripTime',
      'roundTripTimeMeasurements',
      'sentLatency',
      'totalEncodeTime',
      'totalPacketSendDelay',
      'totalRoundTripTime',
      'transportRoundTripTime',
    ] as (keyof OutboundRtpStats)[],
    websocket: ['bitrate'],
  },
  inbound: {
    audio: [
      'audioLevel',
      'availableIncomingBitrate',
      'bitrate',
      'bytesReceived',
      'captureTimestamp',
      'concealedSamples',
      'concealmentEvents',
      'endToEndDelay',
      'estimatedPlayoutTimestamp',
      'headerBytesReceived',
      'insertedSamplesForDeceleration',
      'jitter',
      'jitterBuffer',
      'jitterBufferDelay',
      'jitterBufferEmittedCount',
      'nackCount',
      'packetsLost',
      'packetsLossRate',
      'packetsReceived',
      'removedSamplesForAcceleration',
      'retransmittedPacketsReceived',
      'roundTripTimeMeasurements',
      'totalAudioEnergy',
      'totalRoundTripTime',
      'totalSamplesDuration',
      'totalSamplesReceived',
      'transportResponsesReceived',
      'transportRoundTripTime',
      'transportTotalRoundTripTime',
    ] as (keyof InboundRtpStats)[],
    video: [
      'availableIncomingBitrate',
      'bitrate',
      'bytesReceived',
      'captureTimestamp',
      'decodeLatency',
      'endToEndDelay',
      'estimatedPlayoutTimestamp',
      'firCount',
      'frameHeight',
      'frameRate',
      'framesDecoded',
      'framesDropped',
      'framesPerSecond',
      'framesReceived',
      'frameWidth',
      'freezeCount',
      'headerBytesReceived',
      'jitter',
      'jitterBuffer',
      'jitterBufferDelay',
      'jitterBufferEmittedCount',
      'keyFramesDecoded',
      'nackCount',
      'packetsLost',
      'packetsLossRate',
      'packetsReceived',
      'pliCount',
      'qp',
      'qpSum',
      'retransmittedPacketsReceived',
      'roundTripTimeMeasurements',
      'totalDecodeTime',
      'totalFreezesDuration',
      'totalRoundTripTime',
      'transportResponsesReceived',
      'transportRoundTripTime',
      'transportTotalRoundTripTime',
    ] as (keyof InboundRtpStats)[],
    websocket: ['bitrate'],
  },
} as const

const getStyles = (container?: HTMLElement) => `
:host {
  all: initial;
  ${container ? '' : 'position: fixed; bottom: 0; left: 0; z-index: 99999;'}
  display: flex;
  flex-direction: column;
  background: #222;
  font-family: sans-serif;
  color: #ddd;
  box-sizing: border-box;
}

*, *::before, *::after {
  box-sizing: border-box;
}

.handle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  ${container ? '' : 'cursor: move;'}
  user-select: none;
  padding: 4px;
  background: #333;
  color: #ddd;
  font: 11px sans-serif;
  flex-shrink: 0;
}

.title {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-grow: 1;
}

.close {
  cursor: pointer;
  border: none;
  background: transparent;
  color: #ddd;
  font: 16px/1 sans-serif;
  padding: 0 4px;
}

.options,
.pause,
.pip {
  cursor: pointer;
  border: 1px solid #555;
  background: #222;
  color: #ddd;
  font: 11px sans-serif;
  padding: 2px 6px;
  margin-right: 4px;
  text-decoration: none;
}

.link {
  cursor: pointer;
  color: #ddd;
  font: 11px sans-serif;
  text-decoration: none;
  flex-shrink: 0;
  padding: 2px 6px;
  margin-right: 4px;
}

dialog {
  border: 1px solid #555;
  background: #333;
  color: #ddd;
  font: 11px sans-serif;
  padding: 12px;
  border-radius: 4px;
}

dialog h2 {
  margin: 0 0 8px;
  font: 13px sans-serif;
}

dialog::backdrop {
  background: rgba(0, 0, 0, 0.4);
}

dialog form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 420px;
}

dialog form menu {
  display: flex;
  justify-content: flex-end;
  margin: 0;
  padding: 0;
}

dialog button {
  cursor: pointer;
  border: 1px solid #555;
  background: #222;
  color: #ddd;
  font: 11px sans-serif;
  padding: 2px 8px;
}

.stat-select {
  display: flex;
  flex-wrap: nowrap;
  align-items: end;
  gap: 8px;
}

dialog label,
.stat-select label {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font: 10px sans-serif;
  color: #aaa;
  min-width: 0;
}

.stat-select label:nth-child(1),
.stat-select label:nth-child(2) {
  flex: 0 0 110px;
}

.stat-select label:nth-child(3) {
  flex: 1 1 auto;
}

select,
input[type='number'] {
  width: 100%;
  max-width: none;
  background: #222;
  color: #ddd;
  border: 1px solid #555;
  font: 12px sans-serif;
  padding: 4px 6px;
}

select:has(option[value='']:checked) {
  font-style: italic;
  color: #999;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(${PLOT_WIDTH}px, 1fr));
  justify-items: center;
  max-width: 100vw;
  max-height: ${PLOT_HEIGHT * 2}px;
  overflow: auto;
}

:host(.pip) {
  position: static;
  inset: auto;
  width: 100%;
  height: 100%;
}

:host(.pip) .grid {
  max-height: none;
}

.plot {
  width: ${PLOT_WIDTH}px;
  height: ${PLOT_HEIGHT}px;
  background: #ddd;
}

.plot.new-row {
  grid-column-start: 1;
}
`

const closeButtonBounds = new WeakMap<Chart, { x: number; y: number; size: number }>()

function createCloseButtonPlugin(onClose: () => void): Plugin {
  return {
    id: 'closeButton',
    afterDraw(chart) {
      const { ctx, width } = chart
      const x = width - CLOSE_BUTTON_SIZE - 2
      const y = 2
      closeButtonBounds.set(chart, { x, y, size: CLOSE_BUTTON_SIZE })
      ctx.save()
      ctx.strokeStyle = '#666'
      ctx.lineWidth = 1.5
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(x + 3, y + 3)
      ctx.lineTo(x + CLOSE_BUTTON_SIZE - 3, y + CLOSE_BUTTON_SIZE - 3)
      ctx.moveTo(x + CLOSE_BUTTON_SIZE - 3, y + 3)
      ctx.lineTo(x + 3, y + CLOSE_BUTTON_SIZE - 3)
      ctx.stroke()
      ctx.restore()
    },
    afterEvent(chart, args) {
      if (args.event.type !== 'click') return
      const bounds = closeButtonBounds.get(chart)
      const { x, y } = args.event
      if (!bounds || x == null || y == null) return
      if (x >= bounds.x && x <= bounds.x + bounds.size && y >= bounds.y && y <= bounds.y + bounds.size) {
        onClose()
      }
    },
  }
}

function plotSortKey(id: string): string {
  const [direction, kind, ...rest] = id.split('_')
  const group = GROUP_ORDER[`${direction}_${kind}`] ?? 99
  return `${group}_${rest.join('_')}`
}

function formatBitrate(bps: number): string {
  if (!isFinite(bps) || bps <= 0) return '0 bps'
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'] as const
  let value = bps
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

function formatBytes(bytes: number): string {
  if (!isFinite(bytes) || bytes <= 0) return '0 bytes'
  const units = ['bytes', 'KB', 'MB', 'GB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${units[unit]}`
}

function formatValue(statName: string, value: number | string | null): string {
  if (value == null || typeof value !== 'number') return value?.toString() ?? ''
  if (statName === 'bitrate') return formatBitrate(value)
  if (statName === 'bytes') return formatBytes(value)
  return value.toString()
}

function formatStatLabel(name: string): string {
  return name
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim()
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

type DocumentPictureInPictureApi = {
  window: Window | null
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
}

function getDocumentPictureInPicture(): DocumentPictureInPictureApi | undefined {
  return (window as Window & { documentPictureInPicture?: DocumentPictureInPictureApi }).documentPictureInPicture
}

class Plot {
  private readonly chart: Chart
  private readonly wrapper: HTMLElement
  private readonly datasets = new Map<string, ChartDataset>()

  constructor(
    private readonly panel: PeerConnectionPlots,
    public readonly id: string,
    public readonly title: string,
    public maxAgeMs: number,
  ) {
    this.wrapper = document.createElement('div')
    this.wrapper.id = id
    this.wrapper.className = 'plot'

    const canvas = document.createElement('canvas')
    canvas.width = PLOT_WIDTH
    canvas.height = PLOT_HEIGHT
    this.wrapper.appendChild(canvas)
    this.panel.insertPlot(this.wrapper)

    const statName = id.split('_').slice(2).join('_')

    this.chart = new Chart(canvas, {
      type: 'line',
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: false,
        parsing: false,
        layout: { padding: { top: 2, right: CLOSE_BUTTON_SIZE + 4 } },
        plugins: {
          legend: { display: false },
          title: { display: true, text: title },
          tooltip: {
            callbacks: {
              title: (items) => {
                const x = items[0]?.parsed?.x
                return typeof x === 'number' ? new Date(x).toLocaleTimeString() : ''
              },
              label: (item) => {
                let name = item.dataset.label ?? ''
                if (name.length > 64) {
                  name = name.slice(0, 64) + '…'
                }
                const value = item.parsed.y
                const formatted = formatValue(statName, value)
                return `${name}: ${formatted}`
              },
            },
          },
        },
        scales: {
          x: {
            type: 'linear',
            min: Date.now() - this.maxAgeMs,
            max: Date.now(),
            ticks: {
              color: 'grey',
              font: { size: 9 },
              maxTicksLimit: 4,
              callback: (value) => new Date(value as number).toLocaleTimeString(),
            },
            grid: { color: 'grey' },
          },
          y: {
            beginAtZero: true,
            ticks: {
              color: 'grey',
              font: { size: 9 },
              callback: (value) => formatValue(statName, value),
            },
            grid: { color: 'grey' },
          },
        },
      },
      plugins: [createCloseButtonPlugin(() => this.remove())],
    })
  }

  add(key: string, timestamp: number, value: number) {
    let dataset = this.datasets.get(key)
    if (!dataset) {
      dataset = {
        label: key,
        data: [] as Point[],
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHitRadius: 8,
        tension: 0.2,
        fill: false,
      }
      this.chart.data.datasets.push(dataset)
      this.datasets.set(key, dataset)
    }
    ;(dataset.data as Point[]).push({ x: timestamp, y: value })
  }

  setXRange(min: number, max: number) {
    const x = this.chart.options.scales?.x
    if (x) {
      x.min = min
      x.max = max
    }
    this.chart.update('none')
  }

  cleanup(timestamp: number) {
    if (!this.panel.isStatEnabled(this.id)) {
      this.clear()
      return
    }

    const minTimestamp = timestamp - this.maxAgeMs
    for (const [key, dataset] of [...this.datasets]) {
      const data = dataset.data as Point[]
      const start = data.findIndex((point) => point.x >= minTimestamp)
      dataset.data = start < 0 ? [] : data.slice(start)
      if ((dataset.data as Point[]).length === 0) {
        this.datasets.delete(key)
      }
    }
    this.chart.data.datasets = this.chart.data.datasets.filter((dataset) =>
      [...this.datasets.values()].includes(dataset),
    )
    if (this.datasets.size === 0) {
      this.clear()
    }
  }

  remove() {
    this.panel.disableStat(this.id)
    this.clear()
  }

  clear() {
    this.chart.destroy()
    this.wrapper.remove()
    this.datasets.clear()
    this.panel.deletePlot(this.id)
  }
}

/**
 * The default stats to enable
 */
const DEFAULT_ENABLED_STATS = [
  'outbound_audio_bitrate',
  'outbound_audio_packetsLossRate',
  'outbound_audio_roundTripTime',
  'outbound_video_bitrate',
  'outbound_video_packetsLossRate',
  'outbound_video_roundTripTime',
  'inbound_audio_bitrate',
  'inbound_audio_packetsLossRate',
  'inbound_audio_jitterBuffer',
  'inbound_video_bitrate',
  'inbound_video_packetsLossRate',
  'inbound_video_jitterBuffer',
  'outbound_websocket_bitrate',
  'outbound_websocket_messageRate',
  'outbound_websocket_bytes',
  'outbound_websocket_messages',
  'inbound_websocket_bitrate',
  'inbound_websocket_messageRate',
  'inbound_websocket_bytes',
  'inbound_websocket_messages',
]

/**
 * Singleton panel that periodically plots peer connection stats.
 * Prefer {@link plotPeerConnectionStats} / {@link stopPlottingPeerConnectionStats},
 * or call {@link PeerConnectionPlots.start} / {@link PeerConnectionPlots.stop}.
 */
export class PeerConnectionPlots {
  private static instance: PeerConnectionPlots | null = null

  private intervalMs: number
  private readonly container?: HTMLElement
  private readonly enabledStats: Set<string>

  private readonly host: HTMLElement
  private readonly grid: HTMLElement
  private readonly plots = new Map<string, Plot>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private paused = false
  private updateInProgress = false
  private maxAgeMs = MAX_AGE_MS
  private pipWindow: Window | null = null
  private pipButton: HTMLButtonElement | null = null
  private pauseButton: HTMLButtonElement | null = null
  private hostParent: Node | null = null
  private selectDirection: HTMLSelectElement | null = null
  private selectKind: HTMLSelectElement | null = null
  private selectStat: HTMLSelectElement | null = null

  private constructor({
    intervalMs = 1000,
    container,
    enabledStats = DEFAULT_ENABLED_STATS,
  }: {
    intervalMs?: number
    container?: HTMLElement
    enabledStats?: string[]
  }) {
    this.intervalMs = intervalMs
    this.container = container
    this.enabledStats = new Set(enabledStats)
    this.host = document.createElement('div')
    this.host.id = HOST_ID
    const shadow = this.host.attachShadow({ mode: 'open' })

    const style = document.createElement('style')
    style.textContent = getStyles(this.container)

    const handle = document.createElement('div')
    handle.className = 'handle'

    // Title
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = `${container ? '' : '⋮⋮ '}Plots`
    handle.append(title)

    // Link
    const link = document.createElement('a')
    link.href = 'https://github.com/vpalmisano/webrtcperf-js'
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.className = 'link'
    link.textContent = '➥'
    link.title = 'webrtcperf-js github page'
    link.addEventListener('mousedown', (e) => e.stopPropagation())
    handle.append(link)

    // Dialog for options
    const statSelect = this.createStatSelect()
    const intervalInput = this.createIntervalInput()

    const dialog = document.createElement('dialog')
    const dialogTitle = document.createElement('h2')
    dialogTitle.textContent = 'Options'
    const form = document.createElement('form')
    form.method = 'dialog'
    form.append(statSelect, intervalInput)
    const menu = document.createElement('menu')
    const done = document.createElement('button')
    done.type = 'submit'
    done.textContent = 'Close'
    menu.appendChild(done)
    form.appendChild(menu)
    dialog.append(dialogTitle, form)

    this.pauseButton = document.createElement('button')
    this.pauseButton.type = 'button'
    this.pauseButton.className = 'pause'
    this.pauseButton.textContent = '⏸'
    this.pauseButton.title = 'Pause'
    this.pauseButton.addEventListener('mousedown', (e) => e.stopPropagation())
    this.pauseButton.addEventListener('click', (e) => {
      e.stopPropagation()
      this.togglePause()
    })
    handle.append(this.pauseButton)

    const options = document.createElement('button')
    options.type = 'button'
    options.className = 'options'
    options.textContent = 'Options'
    options.title = 'Options'
    options.addEventListener('mousedown', (e) => e.stopPropagation())
    options.addEventListener('click', (e) => {
      e.stopPropagation()
      dialog.showModal()
    })
    handle.append(options)

    if (getDocumentPictureInPicture()) {
      this.pipButton = document.createElement('button')
      this.pipButton.type = 'button'
      this.pipButton.className = 'pip'
      this.pipButton.textContent = '⧉'
      this.pipButton.title = 'Picture-in-Picture'
      this.pipButton.addEventListener('mousedown', (e) => e.stopPropagation())
      this.pipButton.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.togglePictureInPicture()
      })
      handle.append(this.pipButton)
    }

    // Close button is only needed if not in a container
    if (!this.container) {
      const close = document.createElement('button')
      close.type = 'button'
      close.className = 'close'
      close.textContent = '×'
      close.title = 'Close'
      close.addEventListener('mousedown', (e) => e.stopPropagation())
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.stop()
      })
      handle.append(close)
    }

    // Grid for plots
    this.grid = document.createElement('div')
    this.grid.className = 'grid'
    shadow.append(style, handle, this.grid, dialog)

    if (this.container) {
      this.container.appendChild(this.host)
    } else {
      document.body.appendChild(this.host)
      this.makeMovable(handle)
    }
    this.hostParent = this.host.parentNode
  }

  /**
   * Creates the singleton (if needed) and starts periodic updates.
   * @param options.intervalMs - Update interval in milliseconds (default: 1000)
   * @param options.container - Optional host element; if omitted, plots are shown in a movable overlay on `document.body`
   * @param options.enabledStats - The stats to enable (default: {@link DEFAULT_ENABLED_STATS})
   */
  static start({
    intervalMs,
    container,
    enabledStats,
  }: {
    intervalMs?: number
    container?: HTMLElement
    enabledStats?: string[]
  }) {
    if (!PeerConnectionPlots.instance) {
      PeerConnectionPlots.instance = new PeerConnectionPlots({ intervalMs, container, enabledStats })
    }
    PeerConnectionPlots.instance.start()
  }

  /** Stops updates and removes the panel. */
  static stop() {
    PeerConnectionPlots.instance?.stop()
  }

  private start() {
    if (this.timer || this.running) return
    this.running = true
    this.paused = false
    this.updatePauseButton()
    void this.runUpdateLoop()
  }

  private stop() {
    this.running = false
    this.paused = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.exitPictureInPicture()
    for (const plot of [...this.plots.values()]) {
      plot.clear()
    }
    this.plots.clear()
    this.host.remove()
    PeerConnectionPlots.instance = null
  }

  private togglePause() {
    this.paused = !this.paused
    this.updatePauseButton()
    if (this.paused) {
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
    } else if (this.running && !this.timer) {
      void this.runUpdateLoop()
    }
  }

  private updatePauseButton() {
    if (!this.pauseButton) return
    this.pauseButton.textContent = this.paused ? '▶' : '⏸'
    this.pauseButton.title = this.paused ? 'Resume' : 'Pause'
  }

  private async runUpdateLoop() {
    if (!this.running) return
    await this.update()
    if (this.running && !this.paused) {
      this.timer = setTimeout(() => void this.runUpdateLoop(), this.intervalMs)
    }
  }

  private async togglePictureInPicture() {
    const dpi = getDocumentPictureInPicture()
    if (!dpi) return

    if (this.pipWindow || dpi.window) {
      this.exitPictureInPicture()
      return
    }

    try {
      const pipWindow = await dpi.requestWindow({
        width: Math.max(this.host.clientWidth, PLOT_WIDTH + 24),
        height: Math.max(this.host.clientHeight, PLOT_HEIGHT + 48),
      })
      this.pipWindow = pipWindow
      this.hostParent = this.host.parentNode
      pipWindow.document.body.style.margin = '0'
      pipWindow.document.body.style.background = '#222'
      this.host.classList.add('pip')
      pipWindow.document.body.append(this.host)
      if (this.pipButton) {
        this.pipButton.textContent = '⧉'
        this.pipButton.title = 'Exit Picture-in-Picture'
      }
      pipWindow.addEventListener('pagehide', this.onPictureInPictureClosed.bind(this), { once: true })
    } catch (error) {
      log(`Picture-in-Picture error: ${(error as Error).message}`)
      this.pipWindow = null
    }
  }

  private exitPictureInPicture() {
    const win = this.pipWindow ?? getDocumentPictureInPicture()?.window ?? null
    win?.close()
    this.onPictureInPictureClosed()
  }

  private onPictureInPictureClosed() {
    if (!this.running) return
    if (this.hostParent && this.host.parentNode !== this.hostParent) {
      this.hostParent.appendChild(this.host)
    }
    this.host.classList.remove('pip')
    this.pipWindow = null
    if (this.pipButton) {
      this.pipButton.textContent = '⧉'
      this.pipButton.title = 'Picture-in-Picture'
    }
  }

  insertPlot(wrapper: HTMLElement) {
    const key = plotSortKey(wrapper.id)
    for (const child of this.grid.children) {
      if (plotSortKey(child.id) > key) {
        this.grid.insertBefore(wrapper, child)
        this.updatePlotRows()
        return
      }
    }
    this.grid.appendChild(wrapper)
    this.updatePlotRows()
  }

  deletePlot(id: string) {
    this.plots.delete(id)
    this.updatePlotRows()
  }

  isStatEnabled(id: string) {
    return this.enabledStats.has(id)
  }

  disableStat(id: string) {
    this.enabledStats.delete(id)
    this.updateStatSelect()
  }

  private getOrCreatePlot(direction: Direction, kind: Kind, name: string) {
    const id = `${direction}_${kind}_${name}`
    let plot = this.plots.get(id)
    if (!plot) {
      const label = `${capitalize(direction)} ${capitalize(kind)} ${formatStatLabel(name)}`
      plot = new Plot(this, id, label, this.maxAgeMs)
      this.plots.set(id, plot)
    }
    return plot
  }

  private updateRtpPlot(
    timestamp: number,
    key: string,
    rtpDirection: Direction,
    rtp: OutboundRtpStats | InboundRtpStats,
  ) {
    for (const name of this.enabledStats) {
      const [direction, kind, ...statParts] = name.split('_')
      const stat = statParts.join('_')
      if (direction !== rtpDirection || kind !== rtp.kind) continue
      const value = rtp[stat as keyof typeof rtp]
      if (typeof value === 'number' && isFinite(value)) {
        this.getOrCreatePlot(rtpDirection, rtp.kind, stat).add(key, timestamp, value)
      }
    }
  }

  private async update() {
    if (this.updateInProgress || !this.running) return
    this.updateInProgress = true
    const timestamp = Date.now()

    try {
      const { stats } = await collectPeerConnectionStats()
      for (const stat of stats) {
        for (const key of Object.keys(stat)) {
          const keyStats = stat[key]

          if ((keyStats as OutboundTrackStats).outboundRtp) {
            const rtp = (keyStats as OutboundTrackStats).outboundRtp
            this.updateRtpPlot(timestamp, key, 'outbound', rtp)
          }

          if ((keyStats as InboundTrackStats).inboundRtp) {
            const rtp = (keyStats as InboundTrackStats).inboundRtp
            this.updateRtpPlot(timestamp, key, 'inbound', rtp)
          }
        }
      }

      const websocketStats = collectWebSocketStats()
      for (const stat of websocketStats) {
        const key = `${stat.id}:${stat.url}`
        this.getOrCreatePlot('outbound', 'websocket', 'bytes').add(key, timestamp, stat.sentBytes)
        this.getOrCreatePlot('inbound', 'websocket', 'bytes').add(key, timestamp, stat.recvBytes)
        this.getOrCreatePlot('outbound', 'websocket', 'messages').add(key, timestamp, stat.sentMessages)
        this.getOrCreatePlot('inbound', 'websocket', 'messages').add(key, timestamp, stat.recvMessages)
        if (stat.sentBitrate && this.enabledStats.has('outbound_websocket_bitrate')) {
          this.getOrCreatePlot('outbound', 'websocket', 'bitrate').add(key, timestamp, stat.sentBitrate)
        }
        if (stat.sentMessageRate && this.enabledStats.has('outbound_websocket_messageRate')) {
          this.getOrCreatePlot('outbound', 'websocket', 'messageRate').add(key, timestamp, stat.sentMessageRate)
        }
        if (stat.recvBitrate && this.enabledStats.has('inbound_websocket_bitrate')) {
          this.getOrCreatePlot('inbound', 'websocket', 'bitrate').add(key, timestamp, stat.recvBitrate)
        }
        if (stat.recvMessageRate && this.enabledStats.has('inbound_websocket_messageRate')) {
          this.getOrCreatePlot('inbound', 'websocket', 'messageRate').add(key, timestamp, stat.recvMessageRate)
        }
      }

      const xMin = timestamp - this.maxAgeMs
      for (const plot of [...this.plots.values()]) {
        plot.cleanup(timestamp)
        if (this.plots.has(plot.id)) {
          plot.setXRange(xMin, timestamp)
        }
      }
    } catch (error) {
      log(`Error updating plots: ${(error as Error).message}`)
    } finally {
      this.updateInProgress = false
    }
  }

  private updatePlotRows() {
    let prevGroup: string | null = null
    for (const child of this.grid.children) {
      const [direction, kind] = child.id.split('_')
      const group = `${direction}_${kind}`
      child.classList.toggle('new-row', prevGroup !== null && group !== prevGroup)
      prevGroup = group
    }
  }

  private createIntervalInput() {
    const label = document.createElement('label')
    label.append(document.createTextNode('Update interval (ms)'))
    const input = document.createElement('input')
    input.type = 'number'
    input.min = '100'
    input.max = '60000'
    input.step = '100'
    input.value = String(this.intervalMs)
    input.addEventListener('mousedown', (e) => e.stopPropagation())
    input.addEventListener('change', () => {
      const value = Number(input.value)
      if (!Number.isFinite(value) || value < 100) {
        input.value = String(this.intervalMs)
        return
      }
      this.intervalMs = value
    })
    label.appendChild(input)
    return label
  }

  private createStatSelect() {
    const createLabeledSelect = (labelText: string, values: string[]) => {
      const label = document.createElement('label')
      label.append(document.createTextNode(labelText))
      const select = document.createElement('select')
      for (const value of values) {
        const option = document.createElement('option')
        option.value = value
        option.textContent = capitalize(value)
        select.appendChild(option)
      }
      select.addEventListener('mousedown', (e) => e.stopPropagation())
      label.appendChild(select)
      return { label, select }
    }

    const { label: directionLabel, select: selectDirection } = createLabeledSelect('Direction', ['outbound', 'inbound'])
    const { label: kindLabel, select: selectKind } = createLabeledSelect('Kind', ['audio', 'video', 'websocket'])

    const statLabel = document.createElement('label')
    statLabel.append(document.createTextNode('Stat'))
    const selectStat = document.createElement('select')
    selectStat.addEventListener('mousedown', (e) => e.stopPropagation())
    selectStat.addEventListener('change', () => {
      const value = selectStat.value
      if (!value) return
      this.enabledStats.add(value)
      this.updateStatSelect()
      void this.update()
    })
    statLabel.appendChild(selectStat)

    this.selectDirection = selectDirection
    this.selectKind = selectKind
    this.selectStat = selectStat

    selectDirection.addEventListener('change', () => this.updateStatSelect())
    selectKind.addEventListener('change', () => this.updateStatSelect())

    const div = document.createElement('div')
    div.className = 'stat-select'
    div.append(directionLabel, kindLabel, statLabel)

    this.updateStatSelect()
    return div
  }

  private updateStatSelect() {
    const { selectDirection, selectKind, selectStat } = this
    if (!selectDirection || !selectKind || !selectStat) return

    const direction = selectDirection.value
    const kind = selectKind.value
    if (!direction || !kind) return

    selectStat.replaceChildren()
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = `Add ${direction} ${kind} stat…`
    placeholder.disabled = true
    placeholder.selected = true
    placeholder.style.fontStyle = 'italic'
    selectStat.appendChild(placeholder)

    const options = STAT_OPTIONS[direction as Direction][kind as Kind]
    for (const name of options) {
      const value = `${direction}_${kind}_${name}`
      if (this.enabledStats.has(value)) continue
      const option = document.createElement('option')
      option.value = value
      option.textContent = formatStatLabel(name)
      selectStat.appendChild(option)
    }
  }

  private makeMovable(handle: HTMLElement) {
    let startX = 0
    let startY = 0
    let startLeft = 0
    let startTop = 0

    const onMouseMove = (e: MouseEvent) => {
      this.host.style.left = `${Math.max(0, Math.min(window.innerWidth - this.host.clientWidth, startLeft + e.clientX - startX))}px`
      this.host.style.top = `${Math.max(0, Math.min(window.innerHeight - this.host.clientHeight, startTop + e.clientY - startY))}px`
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    handle.addEventListener('mousedown', (e) => {
      startX = e.clientX
      startY = e.clientY
      const rect = this.host.getBoundingClientRect()
      startLeft = rect.left
      startTop = rect.top
      this.host.style.bottom = 'auto'
      e.preventDefault()
      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    })
  }
}

/**
 * Starts plotting peer connection stats.
 * Creates a singleton panel (or reuses one) and periodically updates the charts.
 * @param options.intervalMs - Update interval in milliseconds (default: 1000)
 * @param options.container - Optional host element; if omitted, plots are shown in a movable overlay on `document.body`
 * @param options.enabledStats - The stats to enable (default: {@link DEFAULT_ENABLED_STATS})
 */
export function startPlots({
  intervalMs,
  container,
  enabledStats,
}: {
  intervalMs?: number
  container?: HTMLElement
  enabledStats?: string[]
} = {}) {
  PeerConnectionPlots.start({ intervalMs, container, enabledStats })
}

/**
 * Stop plotting peer connection stats
 */
export function stopPlots() {
  PeerConnectionPlots.stop()
}
