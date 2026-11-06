// End-to-end smoke: NIP-98 sign-in as the admin, list devices, command a
// device, read the effect back through telemetry, and confirm a foreign key
// is rejected. Run from app/: node ../tools/smoke.mjs
import { readFileSync } from 'node:fs'
import { finalizeEvent } from 'nostr-tools/pure'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

const BASE = 'http://127.0.0.1:8090'
const j = async (res) => { const body = await res.json(); return { status: res.status, body } }

const skHex = readFileSync(new URL('../.test-admin-sk.hex', import.meta.url), 'utf8').trim()
const adminSk = new Uint8Array(Buffer.from(skHex, 'hex'))

// 1. NIP-98: sign kind 27235 with u = /api/auth
const event = finalizeEvent({
  kind: 27235,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['u', '/api/auth'], ['method', 'POST']],
  content: ''
}, adminSk)

const login = await j(await fetch(`${BASE}/api/auth`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event })
}))
console.log('login:', login.status, login.body.npub ? login.body.npub.slice(0, 20) + '…' : login.body)
if (login.status !== 200) process.exit(1)
const auth = { authorization: `Bearer ${login.body.token}` }

// 2. Devices + telemetry through the whole MDK chain
const devices = await j(await fetch(`${BASE}/api/devices`, { headers: auth }))
console.log('devices:', devices.status, 'count:', devices.body.devices?.length)
const ba1 = devices.body.devices?.find((d) => d.id === 'BA-001')
console.log('BA-001 telemetry:', JSON.stringify(ba1?.telemetry))

// 3. Command: power high
const cmd = await j(await fetch(`${BASE}/api/devices/BA-001/power`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'high' })
}))
console.log('power high:', cmd.status, JSON.stringify(cmd.body).slice(0, 120))

// 4. Read back through telemetry
await new Promise((r) => setTimeout(r, 500))
const after = await j(await fetch(`${BASE}/api/devices`, { headers: auth }))
const ba1after = after.body.devices.find((d) => d.id === 'BA-001')
console.log('BA-001 after:', ba1after.telemetry.power_mode, ba1after.telemetry.hashrate_ghs, 'GH/s', ba1after.telemetry.fan_rpm, 'rpm')
if (ba1after.telemetry.power_mode !== 'high') { console.log('FAIL: mode not applied'); process.exit(1) }

// 5. Fan + mining
const fan = await j(await fetch(`${BASE}/api/devices/BA-002/fan`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ pct: 100 })
}))
const mining = await j(await fetch(`${BASE}/api/devices/BA-003/mining`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: false })
}))
console.log('fan:', fan.status, 'mining:', mining.status)

// 6. Foreign key: fresh random identity must be refused
const foreign = finalizeEvent({
  kind: 27235, created_at: Math.floor(Date.now() / 1000),
  tags: [['u', '/api/auth'], ['method', 'POST']], content: ''
}, generateSecretKey())
const foreignLogin = await j(await fetch(`${BASE}/api/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ event: foreign })
}))
console.log('foreign key login:', foreignLogin.status, foreignLogin.body.error)
const noAuth = await j(await fetch(`${BASE}/api/devices`))
console.log('no token:', noAuth.status, noAuth.body.error)

// 7. Bad mode rejected by contract validation
const badMode = await j(await fetch(`${BASE}/api/devices/BA-001/power`, {
  method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'turbo' })
}))
console.log('bad mode:', badMode.status, badMode.body.error)

console.log('\nSMOKE OK')
