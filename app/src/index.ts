// mdk² entrypoint: boots the Tether-MDK plane (kernel + bitair worker +
// mocks), the device service, NIP-98 auth with Marmot/allowlist authz, the
// PM2.5 autopilot, schedules, and the HTTP server.

import { nip19 } from 'nostr-tools'
import { loadConfig, deviceSpecs } from './config'
import { Store } from './store'
import { bootMdk } from './mdk'
import { DeviceService } from './devices'
import { AuthService } from './auth'
import { Authz } from './authz'
import { Autopilot } from './autopilot'
import { ScheduleRunner } from './schedule'
import { buildServer } from './server'
import { createMarmotBridge } from './marmot'
import { createRustMarmotBridge, wnAvailable } from './marmot-rust'
import type { MarmotBridge } from './marmot'

async function main (): Promise<void> {
  const cfg = loadConfig()
  const store = new Store(cfg.dataDir)
  const specs = deviceSpecs(cfg)

  const mdk = await bootMdk(cfg, specs)
  store.record('system', `MDK plane up: worker=${cfg.workerId} kernel=${mdk.kernelKey.slice(0, 16)}… devices=${specs.length}`)

  const devices = new DeviceService(mdk.client, specs)
  const authz = new Authz(cfg.adminNpub, store)
  const auth = new AuthService(cfg.authWindowSec, (pubkey) => nip19.npubEncode(pubkey))
  const autopilot = new Autopilot(devices, store, cfg.weatherRelays, {
    enabled: false,
    onUgm3: cfg.autopilotOnUgm3,
    offUgm3: cfg.autopilotOffUgm3,
    idleMode: cfg.autopilotIdleMode,
    stations: []
  })
  const schedules = new ScheduleRunner(devices, store)

  const marmotDeps = {
    dataDir: cfg.dataDir,
    relays: cfg.relays,
    authz,
    store,
    onCommand: async (command: { deviceId?: string, name: string, params: Record<string, unknown> }) => {
      if (command.deviceId) {
        return devices.command(command.deviceId, command.name, command.params)
      }
      return devices.commandAll(command.name, command.params)
    },
    fleetStatus: async () => ({
      devices: await Promise.all(devices.specs.map(async (spec) => ({
        id: spec.deviceId,
        telemetry: await devices.telemetry(spec.deviceId).catch(() => ({})) as Record<string, unknown>
      })))
    })
  }

  let marmot: MarmotBridge | null = null
  if (cfg.marmotEnabled) {
    // Engine choice: the Rust wn CLI (White Noise's own engine — invites
    // from the production app work) when present, else marmot-ts (v2 track,
    // WN-incompatible). MARMOT_ENGINE forces one.
    const engine = process.env.MARMOT_ENGINE
    try {
      if (engine !== 'ts' && (engine === 'rust' || await wnAvailable())) {
        marmot = await createRustMarmotBridge(marmotDeps)
        store.record('marmot', 'engine: rust (wn)')
      } else {
        marmot = await createMarmotBridge(marmotDeps)
        store.record('marmot', 'engine: marmot-ts (v2)')
      }
    } catch (err) {
      store.record('marmot', `disabled: ${(err as Error).message}`)
    }
  }

  const manualOverride = (): void => { autopilot.manualOverride() }
  schedules.start(() => autopilot.status().engaged)
  autopilot.start()

  const app = buildServer({
    cfg,
    store,
    devices,
    auth,
    authz,
    autopilot,
    schedules,
    marmotStatus: () => marmot ? marmot.status() : { enabled: false, reason: 'MARMOT_ENABLED=false' },
    manualOverride
  })

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
  const mockPorts = mdk.mocks.map((m) => `${m.deviceId}:${m.port}`).join(' ')
  if (marmot) console.log(`  marmot:  invite this npub into your group → ${marmot.status().npub}`)

  const shutdown = async (): Promise<void> => {
    autopilot.stop()
    schedules.stop()
    await marmot?.stop()
    await app.close()
    await mdk.stop()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('boot failed:', err)
  process.exit(1)
})
