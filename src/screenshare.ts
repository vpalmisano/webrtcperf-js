import { enabledForSession, overrides, log, params, config } from './common'

export type FakeScreenshareParams = {
  embed: string
  slides: number
  urls: string[]
  delay: number
  animationDuration: number
  width: number
  height: number
  pointerAnimation: number
}

export const startFakeScreenshare = async (opts = params.fakeScreenshare || {}) => {
  const { embed, slides, urls, animationDuration, delay, width, height, pointerAnimation } = Object.assign(
    {
      embed: '',
      slides: 4,
      urls: [] as string[],
      delay: 5000,
      animationDuration: 1000,
      width: 1920,
      height: 1080,
      pointerAnimation: 0,
    },
    opts,
  )
  if (document.querySelector('#webrtcperf-fake-screenshare')) {
    return
  }
  log(
    `FakeScreenshare start: embed=${embed} slides=${slides} animationDuration=${animationDuration} delay=${delay} width=${width} height=${height}`,
  )
  const wrapper = document.createElement('div')
  wrapper.setAttribute('id', 'webrtcperf-fake-screenshare')
  wrapper.setAttribute(
    'style',
    `all: unset; position: fixed; top: 0; left: 0; width: ${width}px; height: ${height}px; z-index: ${config.USE_FAKE_MEDIA ? '-1' : '1'}; background-color: black; isolation: isolate; transform-style: flat;`,
  )
  document.body.appendChild(wrapper)

  if (config.USE_FAKE_MEDIA) {
    config.GET_DISPLAY_MEDIA_CROP = '#webrtcperf-fake-screenshare'
  }

  // Pointer animation.
  if (pointerAnimation) {
    const el = document.createElement('div')
    el.setAttribute(
      'style',
      'all: unset; position: absolute; width: 10px; height: 10px; background-color: red; border-radius: 50%; opacity: 0;',
    )
    wrapper.appendChild(el)
    el.animate(
      [
        { transform: 'translate(50px, 0px)', opacity: 0, offset: 0.0 },
        { transform: 'translate(25px, 25px)', opacity: 1, offset: 100 / pointerAnimation },
        { transform: 'translate(0px, 50px)', opacity: 0, offset: 200 / pointerAnimation },
      ],
      {
        duration: pointerAnimation,
        iterations: Infinity,
        easing: 'ease-in-out',
      },
    )
  }

  // Draw overlay with timestamp.
  let drawTimestamp = null
  if (enabledForSession(params.timestampWatermarkVideo)) {
    const canvas = document.createElement('canvas')
    const fontSize = Math.round(height / 18)
    const textHeight = Math.round(height / 15)
    canvas.width = width
    canvas.height = textHeight
    canvas.setAttribute(
      'style',
      `all: unset; position: absolute; top: 0; left: 0; z-index: 1; width: 100%; height: ${textHeight}px;`,
    )
    wrapper.appendChild(canvas)
    const ctx = canvas.getContext('2d')!
    ctx.font = `${fontSize}px Noto Mono`
    ctx.textAlign = 'center'
    const participantNameIndex = parseInt(overrides.getParticipantName().split('-')[1]) || 0
    drawTimestamp = () => {
      ctx.fillStyle = 'black'
      ctx.fillRect(0, 0, width, textHeight)
      ctx.fillStyle = 'white'
      const text = `${participantNameIndex}-${Date.now()}`
      ctx.fillText(text, width / 2, fontSize)
    }
  }

  // Slides animation.
  let advanceSlide = null
  if (embed) {
    const el = document.createElement('iframe')
    el.setAttribute('src', embed)
    el.setAttribute('width', width.toString())
    el.setAttribute('height', height.toString())
    el.setAttribute('style', 'padding: 0; margin: 0; border: none;')
    el.setAttribute('frameborder', '0')
    wrapper.appendChild(el)

    let cur = 0
    advanceSlide = async () => {
      log(`advanceSlide embed: ${cur}/${slides}`)
      if (cur >= slides) {
        await window.webrtcperf_keyPress('Home')
        cur = 0
      } else {
        await window.webrtcperf_keypressText('iframe', ' ')
        cur++
      }
    }
  } else {
    const animateElement = async (el: HTMLElement, direction: 'in' | 'out') => {
      const slideIn = [
        { transform: 'translateX(100%)', opacity: 1 },
        { transform: 'translateX(0%)', opacity: 1 },
      ]
      const slideOut = [
        { transform: 'translateX(0%)', opacity: 1 },
        { transform: 'translateX(-100%)', opacity: 1 },
      ]
      return new Promise<void>((resolve) => {
        el.animate(direction === 'in' ? slideIn : slideOut, {
          duration: animationDuration,
          iterations: 1,
          fill: 'forwards',
        }).addEventListener('finish', () => resolve())
      })
    }

    const slidesElements: HTMLElement[] = []
    for (let i = 0; i < slides; i++) {
      const url = urls[i]
      let el = null
      if (!url) {
        el = document.createElement('img')
        el.setAttribute('src', `https://picsum.photos/seed/${i + 1}/${width}/${height}`)
      } else {
        const ext = url.split('.').pop() || ''
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) {
          el = document.createElement('img')
        } else {
          el = document.createElement('iframe')
          el.setAttribute('frameborder', '0')
          el.setAttribute('scrolling', 'no')
        }
        el.setAttribute('src', url)
      }
      el.setAttribute(
        'style',
        `all: unset; position: absolute; width: 100%; height: ${el instanceof HTMLIFrameElement ? `${height}px` : 'auto'}; transform: translateX(100%); opacity: 0; overflow: hidden;`,
      )
      wrapper.appendChild(el)
      await new Promise((resolve) => el.addEventListener('load', resolve, { once: true }))
      slidesElements.push(el)
    }

    let cur = 0
    advanceSlide = async () => {
      log(`advanceSlide: ${cur}/${slides}`)
      const next = cur === slidesElements.length - 1 ? 0 : cur + 1
      let timer = null
      if (animationDuration > 0 && drawTimestamp) {
        timer = setInterval(() => requestAnimationFrame(() => drawTimestamp()), 1000 / 30)
      }
      await Promise.all([animateElement(slidesElements[cur], 'out'), animateElement(slidesElements[next], 'in')])
      cur = next
      if (timer) clearInterval(timer)
    }
  }

  const loopIteration = async () => {
    if (!document.querySelector('#webrtcperf-fake-screenshare')) return
    try {
      if (drawTimestamp) drawTimestamp()
      if (advanceSlide) await advanceSlide()
    } catch (e) {
      log(`loopIteration error: ${e}`)
    }
    setTimeout(() => loopIteration(), delay)
  }
  loopIteration()
}

export const stopFakeScreenshare = () => {
  const wrapper = document.querySelector('#webrtcperf-fake-screenshare')
  if (!wrapper) return
  wrapper.remove()
}
