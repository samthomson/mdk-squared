// Standalone check of the Rust (wn) Marmot bridge.
import { createRustMarmotBridge } from '../src/marmot-rust'

const bridge = await createRustMarmotBridge({
  dataDir: './data',
  relays: ['wss://relay.primal.net'],
  authz: { setMarmotMembers: (m: string[]) => console.log('[authz] members:', m.length) },
  store: { record: (kind: string, message: string) => console.log(`[${kind}] ${message}`) },
  onCommand: async (command) => { console.log('[command]', JSON.stringify(command)); return { ok: true } },
  fleetStatus: async () => ({ devices: [{ id: 'BA-001', telemetry: { power_mode: 'eco' } }] })
})

console.log('status:', JSON.stringify(bridge.status(), null, 1))
await new Promise((resolve) => setTimeout(resolve, 9000))
console.log('after poll:', JSON.stringify(bridge.status()))
await bridge.stop()
process.exit(0)
