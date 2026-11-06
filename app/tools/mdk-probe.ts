// Standalone MDK-plane probe: boots the plane on scratch ports and exercises
// the client directly, printing the real underlying error.
import { loadConfig, deviceSpecs } from '../src/config'
import { bootMdk } from '../src/mdk'

process.env.DHT_PORT = '49838'
process.env.MOCK_PORT_BASE = '18200'
process.env.DATA_DIR = './data-probe'

const cfg = loadConfig(new URL('..', import.meta.url).pathname)
const specs = deviceSpecs(cfg)
console.log('booting…')
const mdk = await bootMdk(cfg, specs)
console.log('kernel key:', mdk.kernelKey.slice(0, 20), '…')

try {
  const status = await mdk.client.getStatus()
  console.log('getStatus OK:', status.workers.map((w) => `${w.workerId}:${w.state}:${w.deviceCount}`).join(', '))
  const tel = await mdk.client.pullTelemetry('BA-001', { type: 'metrics' })
  console.log('telemetry BA-001:', JSON.stringify(tel))
  const cmd = await mdk.client.sendCommand('BA-001', 'setPowerMode', { mode: 'high' })
  console.log('command accepted:', JSON.stringify(cmd))
  for (let i = 0; i < 20; i++) {
    const entry = await mdk.client.getCommandStatus(cmd.commandId)
    console.log(`poll ${i}: ${entry.status}`)
    if (['SUCCESS', 'FAILED', 'TIMEOUT'].includes(entry.status)) { console.log('result:', JSON.stringify(entry.result), entry.error ?? ''); break }
    await new Promise((r) => setTimeout(r, 300))
  }
} catch (err) {
  console.error('CLIENT ERROR:', err.code ?? '', err.message, err.cause ?? '')
}

await mdk.stop()
process.exit(0)
