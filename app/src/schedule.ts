// Per-device schedules: weekly windows that set a power mode while active
// and turn the device off outside every window. The autopilot outranks the
// schedule (air quality is a safety concern); manual commands pause both.
// Commands fire only on mode change, not on every tick.

import type { DeviceService } from './devices'
import type { Store } from './store'

const TICK_MS = 30 * 1000

export interface ScheduleWindow {
  days: number[] // 0 (Sun) .. 6 (Sat)
  from: string // 'HH:MM'
  to: string // 'HH:MM'; may wrap past midnight
  mode: string
}

export type Schedules = Record<string, ScheduleWindow[]> // deviceId → windows

export class ScheduleRunner {
  private schedules: Schedules
  private readonly lastApplied: Record<string, string> = {}
  private timer: NodeJS.Timeout | undefined

  constructor (
    private readonly devices: DeviceService,
    private readonly store: Store
  ) {
    this.schedules = store.readJson<Schedules>('schedules.json', {})
  }

  get (deviceId: string): ScheduleWindow[] {
    return this.schedules[deviceId] ?? []
  }

  set (deviceId: string, windows: ScheduleWindow[]): ScheduleWindow[] {
    this.schedules = { ...this.schedules, [deviceId]: windows }
    this.store.writeJson('schedules.json', this.schedules)
    delete this.lastApplied[deviceId]
    return windows
  }

  start (isSubordinated: () => boolean): void {
    const tick = () => {
      if (isSubordinated()) return
      for (const spec of this.devices.specs) {
        const windows = this.schedules[spec.deviceId]
        if (!windows || windows.length === 0) continue
        const mode = activeMode(windows, new Date()) ?? 'off'
        if (this.lastApplied[spec.deviceId] === mode) continue
        this.lastApplied[spec.deviceId] = mode
        void this.devices.command(spec.deviceId, 'setPowerMode', { mode })
          .then((o) => this.store.record('schedule', `${spec.deviceId} → ${mode} (${o.status})`, { window: true }))
      }
    }
    this.timer = setInterval(tick, TICK_MS)
  }

  stop (): void {
    clearInterval(this.timer)
  }
}

/** The mode of the window active at `now`, or null when none is. */
export function activeMode (windows: ScheduleWindow[], now: Date): string | null {
  const day = now.getDay()
  const minutes = now.getHours() * 60 + now.getMinutes()
  for (const w of windows) {
    if (!w.days.includes(day)) continue
    const from = parseHm(w.from)
    const to = parseHm(w.to)
    const inside = from <= to
      ? minutes >= from && minutes < to
      : minutes >= from || minutes < to // window wraps midnight
    if (inside) return w.mode
  }
  return null
}

function parseHm (hm: string): number {
  const [h, m] = hm.split(':').map(Number)
  return h * 60 + m
}
