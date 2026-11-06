// Environment + .env loading. Plain parser: no dependency, no override of
// variables already present in the process environment.

import fs from 'node:fs'
import path from 'node:path'

export interface RealDevice { id: string; host: string; port: number }

export interface DeviceSpec { deviceId: string; config: { host: string; port: number } }

export interface Config {
  port: number
  adminNpub: string
  relays: string[]
  weatherRelays: string[]
  dhtHost: string
  dhtPort: number
  workerId: string
  mockCount: number
  mockPortBase: number
  realDevices: RealDevice[] | null
  autopilotOnUgm3: number
  autopilotOffUgm3: number
  autopilotIdleMode: string
  marmotEnabled: boolean
  dataDir: string
  authWindowSec: number
}

function loadDotEnv (file = '.env'): void {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const value = m[2].replace(/^['"]|['"]$/g, '')
    if (process.env[m[1]] === undefined) process.env[m[1]] = value
  }
}

export function loadConfig (root = process.cwd()): Config {
  loadDotEnv(path.join(root, '.env'))

  const realDevicesRaw = process.env.REAL_DEVICES
  let realDevices: RealDevice[] | null = null
  if (realDevicesRaw) {
    try {
      const parsed = JSON.parse(realDevicesRaw)
      if (Array.isArray(parsed) && parsed.length > 0) realDevices = parsed
    } catch {
      throw new Error('REAL_DEVICES must be a JSON array like [{"id":"BA-001","host":"…","port":80}]')
    }
  }

  const adminNpub = process.env.ADMIN_NPUB || ''
  if (!adminNpub.startsWith('npub1')) {
    throw new Error('ADMIN_NPUB must be set (bech32 npub) — copy .env.example to .env and fill it in')
  }

  return {
    port: Number(process.env.PORT || 8080),
    adminNpub,
    relays: (process.env.RELAYS || 'wss://relay.relaying.earth').split(',').map((s) => s.trim()).filter(Boolean),
    weatherRelays: (process.env.WEATHER_RELAYS || 'wss://relay.relaying.earth,wss://relay.primal.net').split(',').map((s) => s.trim()).filter(Boolean),
    dhtHost: process.env.DHT_HOST || '127.0.0.1',
    dhtPort: Number(process.env.DHT_PORT || 49737),
    workerId: process.env.WORKER_ID || 'bitair',
    mockCount: Number(process.env.MOCK_COUNT || 3),
    mockPortBase: Number(process.env.MOCK_PORT_BASE || 18100),
    realDevices,
    autopilotOnUgm3: Number(process.env.AUTOPILOT_ON_UGM3 || 35),
    autopilotOffUgm3: Number(process.env.AUTOPILOT_OFF_UGM3 || 25),
    autopilotIdleMode: process.env.AUTOPILOT_DEFAULT_IDLE_MODE || 'eco',
    marmotEnabled: (process.env.MARMOT_ENABLED || 'true') !== 'false',
    dataDir: process.env.DATA_DIR || './data',
    authWindowSec: Number(process.env.AUTH_WINDOW_SEC || 600)
  }
}

export function deviceSpecs (cfg: Config): DeviceSpec[] {
  if (cfg.realDevices) {
    return cfg.realDevices.map((d) => ({ deviceId: d.id, config: { host: d.host, port: d.port } }))
  }
  return Array.from({ length: cfg.mockCount }, (_, i) => ({
    deviceId: `BA-${String(i + 1).padStart(3, '0')}`,
    config: { host: '127.0.0.1', port: cfg.mockPortBase + i }
  }))
}
