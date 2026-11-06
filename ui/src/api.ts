// API client: NIP-98 sign-in through the NIP-07 extension, then bearer-token
// requests. The login component mirrors MKStack's LoginArea pattern (NIP-07
// → session token) — MKStack's own component is a drop-in swap if you build
// on its scaffold.
import { finalizeEvent } from 'nostr-tools/pure'

export interface DeviceStatus {
  id: string
  mock: boolean
  telemetry: {
    hashrate_ghs?: number
    power_w?: number
    fan_rpm?: number
    temp_c?: number
    filter_life_pct?: number
    pm25_ugm3?: string
    power_mode?: string
    mining?: string
  }
  health: { reachable: boolean | null } | null
  schedule: Array<{ days: number[], from: string, to: string, mode: string }>
}

export interface AutopilotStatus {
  config: { enabled: boolean, onUgm3: number, offUgm3: number, idleMode: string, stations: string[] }
  engaged: boolean
  overrideUntil: number | null
  readings: Array<{ station: string, value: number, at: number }>
}

export interface StationInfo { pubkey: string, npub: string, name: string | null, geohash: string | null, model: string | null, latest: { value: number, at: number } | null }

export interface Me { npub: string, isAdmin: boolean, source: string }

const BASE = ''

export async function nip98Login (): Promise<{ token: string, me: Me }> {
  const nostr = (window as unknown as { nostr?: { getPublicKey: () => Promise<string>, signEvent: (e: object) => Promise<object> } }).nostr
  if (!nostr) throw new Error('No NIP-07 signer found — install Alby, nos2x, or another Nostr extension')

  const template = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['u', '/api/auth'], ['method', 'POST']],
    content: ''
  }
  const event = await nostr.signEvent(template) as unknown as Record<string, unknown> & { pubkey: string }
  if (event.pubkey !== await nostr.getPublicKey()) throw new Error('signer pubkey mismatch')

  const res = await fetch(`${BASE}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event })
  })
  const body = await res.json()
  if (!res.ok) throw new Error(body.error ?? `login failed (${res.status})`)
  return { token: body.token, me: { npub: body.npub, isAdmin: body.isAdmin, source: body.source } }
}

export class Api {
  constructor (private readonly token: string) {}

  private async call (path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers || {}), authorization: `Bearer ${this.token}` }
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((body as { error?: string }).error ?? `request failed (${res.status})`)
    return body
  }


  me (): Promise<Me> { return this.call('/api/me') as Promise<Me> }
  simulate (value: number) { return this.call('/api/autopilot/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }) }
  resumeAutopilot () { return this.call('/api/autopilot/resume', { method: 'POST' }) }
  devices (): Promise<{ workerCount: number, devices: DeviceStatus[] }> {
    return this.call('/api/devices') as Promise<{ workerCount: number, devices: DeviceStatus[] }>
  }

  power (id: string, mode: string) { return this.call(`/api/devices/${id}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) }) }
  fan (id: string, pct: number) { return this.call(`/api/devices/${id}/fan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pct }) }) }
  mining (id: string, enabled: boolean) { return this.call(`/api/devices/${id}/mining`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }) }

  autopilot (): Promise<AutopilotStatus> { return this.call('/api/autopilot') as Promise<AutopilotStatus> }
  updateAutopilot (patch: Record<string, unknown>) { return this.call('/api/autopilot', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }) }
  stations (): Promise<{ stations: StationInfo[] }> { return this.call('/api/stations') as Promise<{ stations: StationInfo[] }> }
  marmot (): Promise<Record<string, unknown>> { return this.call('/api/marmot') as Promise<Record<string, unknown>> }
  members (): Promise<{ admin: string, members: Array<{ npub: string }> }> { return this.call('/api/members') as Promise<{ admin: string, members: Array<{ npub: string }> }> }
  addMember (npub: string) { return this.call('/api/members', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ npub }) }) }
  events (limit = 30): Promise<{ events: Array<{ ts: number, kind: string, message: string }> }> { return this.call(`/api/events?limit=${limit}`) as Promise<{ events: Array<{ ts: number, kind: string, message: string }> }> }
}
