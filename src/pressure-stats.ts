import { log } from './common'
import { MeasuredStats } from './stats'

const cpuPressure = new MeasuredStats({ ttl: 15 })

export function collectCpuPressure() {
  return cpuPressure.mean()
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    PressureObserver: any
  }
}

if ('PressureObserver' in window) {
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const STATES = {
        nominal: 0,
        fair: 1,
        serious: 2,
        critical: 3,
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const observer = new window.PressureObserver((records: any[]) => {
        const lastRecord = records[records.length - 1]
        // log(`Current CPU pressure: ${lastRecord.state}`)
        cpuPressure.push(Date.now(), STATES[lastRecord.state as keyof typeof STATES])
      })
      observer.observe('cpu', { sampleInterval: 1000 }).catch((error: unknown) => {
        log(`Pressure observer error: ${(error as Error).message}`)
      })
    },
    { once: true },
  )
}
