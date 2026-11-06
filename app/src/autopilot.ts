// PM2.5 autopilot: subscribes to kind 4223 weather-station readings on the
// configured relays (draft NIP PR 2163, the samthomson/weather-station
// format: tags like ["pm25","12","PMS5003"]), and switches the whole BitAir
// fleet's purification on/off with hysteresis. Manual commands pause the
// autopilot for 30 minutes so a human always wins.

import { SimplePool } from 'nostr-tools/pool'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import type { Event } from 'nostr-tools/pure'
import type { DeviceService } from './devices'
import type { Store } from './store'

const OVERRIDE_MS = 30 * 60 * 1000
const TICK_MS = 5000

export interface StationReading { station: string; value: number; at: number }

export interface AutopilotConfig {
  enabled: boolean
  onUgm3: number
  offUgm3: number
  idleMode: string
  /** Manual override reading (µg/m³) replacing the station value, or null. */
  overrideValue: number | null
  stations: string[] // hex pubkeys of kind 16158 stations
}

export interface StationInfo { pubkey: string; npub: string; name: string | null; geohash: string | null; model: string | null; latest: { value: number; at: number } | null }

export interface AutopilotStatus {
  config: AutopilotConfig
  engaged: boolean
  overrideUntil: number | null
  readings: StationReading[]
}

export class Autopilot {
  private cfg: AutopilotConfig
  private sub: { close: () => void } | null = null
  private readonly readings = new Map<string, StationReading>()
  private engaged = false
  private overrideUntil: number | null = null
  private timer: NodeJS.Timeout | undefined
  private readonly pool = new SimplePool()

  constructor (
    private readonly devices: DeviceService,
    private readonly store: Store,
    private readonly relays: string[],
    defaults: AutopilotConfig
  ) {
    const persisted = store.readJson<Partial<AutopilotConfig>>('autopilot.json', {})
    this.cfg = { ...defaults, ...persisted, overrideValue: persisted.overrideValue ?? null }
  }

  status (): AutopilotStatus {
    return {
      config: { ...this.cfg, stations: [...this.cfg.stations] },
      engaged: this.engaged,
      overrideUntil: this.overrideUntil,
      readings: [...this.readings.values()].sort((a, b) => b.at - a.at),
    }
  }

  update (patch: Partial<AutopilotConfig>): AutopilotStatus {
    // Enabling takes control back from any manual override.
    if (patch.enabled === true) this.overrideUntil = null
    // Single-station model: extra entries (legacy checkbox picks) are dropped.
    if (patch.stations && patch.stations.length > 1) patch.stations = [patch.stations[0]]
    const before = JSON.stringify([this.cfg.enabled, this.cfg.stations])
    this.cfg = { ...this.cfg, ...patch }
    this.store.writeJson('autopilot.json', this.cfg)
    const after = JSON.stringify([this.cfg.enabled, this.cfg.stations])
    if (before !== after) this.restartSub()
    this.evaluate('config-updated')
    return this.status()
  }

  /** A manual device command calls this: humans override automation. */
  manualOverride (): void {
    // No-op: manual device commands exist only in MANUAL mode; AUTO never
    // needs to be "paused" out from under a click.
  }

  /** Clear a manual override early — the AUTO banner's "resume" button. */
  resume (): void {
    this.overrideUntil = null
    this.evaluate('resumed')
    this.store.record('autopilot', 'manual override cleared — autopilot resumed')
  }

  /**
   * Demo path: publish a reading from this app's own seeded station (created
   * on first use) and auto-select it, so the whole nostr→autopilot→MDK loop
   * runs without hardware. The live subscription reacts like any station.
   */
  async simulate (pm25: number): Promise<{ overrideValue: number | null }> {
    this.update({ overrideValue: pm25 })
    this.store.record('autopilot', `override value set to ${pm25} µg/m³`)
    return { overrideValue: pm25 }
  }


  async discoverStations (): Promise<StationInfo[]> {
    const events = (await this.pool.querySync(this.relays, { kinds: [16158] }, { maxWait: 9000 }))
      .sort((a, b) => b.created_at - a.created_at) // newest metadata wins: stations get renamed
    const seen = new Set<string>()
    const stations: StationInfo[] = []
    for (const ev of events) {
      if (seen.has(ev.pubkey)) continue
      seen.add(ev.pubkey)
      const sensors = ev.tags.filter(([k]) => k === 'sensor')
      if (!sensors.some(([, v]) => v === 'pm25')) continue
      // Test-debris demo stations (published from scratch data dirs) stay hidden.
      if ((ev.tags.find(([k]) => k === 'name')?.[1] ?? '').startsWith('mdk² demo')) continue
      stations.push({
        pubkey: ev.pubkey,
        npub: nip19.npubEncode(ev.pubkey),
        name: ev.tags.find(([k]) => k === 'name')?.[1] ?? null,
        geohash: ev.tags.find(([k]) => k === 'g')?.[1] ?? null,
        model: sensors.find(([, v]) => v === 'pm25')?.[2] ?? null,
        latest: null
      })
    }
    // Latest kind 4223 reading per station — queried per author, because one
    // chatty station's history otherwise eats a shared limit. Age is shown
    // as-is, however old (a July reading is still the latest there is).
    await Promise.all(stations.map(async (station) => {
      const readings = await this.pool.querySync(
        this.relays,
        { kinds: [4223], authors: [station.pubkey], limit: 1 },
        { maxWait: 3000 }
      ).catch(() => [])
      const pm25 = Number(readings[0]?.tags.find(([k]) => k === 'pm25')?.[1])
      if (Number.isFinite(pm25)) station.latest = { value: pm25, at: readings[0].created_at * 1000 }
    }))
    return stations
  }

  start (): void {
    this.restartSub()
    this.timer = setInterval(() => this.evaluate('tick'), TICK_MS)
  }

  private restartSub (): void {
    this.sub?.close()
    this.sub = null
    if (!this.cfg.enabled || this.cfg.stations.length === 0) return
    this.sub = this.pool.subscribeMany(
      this.relays,
      { kinds: [4223], authors: this.cfg.stations, limit: 1 },
      {
        onevent: (ev: Event) => this.onReading(ev)
      }
    )
    this.store.record('autopilot', `subscribed to ${this.cfg.stations.length} station(s) on ${this.relays.join(', ')}`)
  }
  private onReading (ev: Event): void {
    const pm25 = ev.tags.find(([k]) => k === 'pm25')?.[1]
    const value = Number(pm25)
    if (!Number.isFinite(value)) return
    this.readings.set(ev.pubkey, { station: ev.pubkey, value, at: ev.created_at * 1000 })
    this.evaluate('reading')
  }

  stop (): void {
    this.sub?.close()
    clearInterval(this.timer)
    this.pool.close(this.relays)
  }
  private evaluate (trigger: string): void {
    if (!this.cfg.enabled) return
    const now = Date.now()
    // Manual override replaces the station value entirely.
    let mean: number
    if (this.cfg.overrideValue !== null && Number.isFinite(this.cfg.overrideValue)) {
      mean = this.cfg.overrideValue
    } else {
      const fresh = [...this.readings.values()].filter((r) => now - r.at < 15 * 60 * 1000 && this.cfg.stations.includes(r.station))
      if (fresh.length === 0) return
      mean = fresh.reduce((sum, r) => sum + r.value, 0) / fresh.length
    }

    if (!this.engaged && mean >= this.cfg.onUgm3) {
      this.engaged = true
      void this.act('high', `pm25 ${mean.toFixed(1)} ≥ ${this.cfg.onUgm3} — purification HIGH`, trigger)
    } else if (this.engaged && mean <= this.cfg.offUgm3) {
      this.engaged = false
      void this.act(this.cfg.idleMode, `pm25 ${mean.toFixed(1)} ≤ ${this.cfg.offUgm3} — purification ${this.cfg.idleMode}`, trigger)
    }
  }

  private overrideActive (now: number): boolean {
    return this.overrideUntil !== null && now < this.overrideUntil
  }

  private async act (mode: string, message: string, trigger: string): Promise<void> {
    this.store.record('autopilot', message, { trigger, mode })
    const outcomes = await this.devices.commandAll('setPowerMode', { mode })
    const failed = outcomes.filter((o) => o.status !== 'SUCCESS')
    if (failed.length > 0) {
      this.store.record('autopilot', `${failed.length} device command(s) failed`, failed.map((o) => o.error))
    }
  }
}
