// Autopilot end-to-end: login → enable autopilot on the seed station →
// spike PM2.5 → wait for the fleet to go HIGH → drop PM2.5 → wait for eco.
// Publishes readings itself (Promise.allSettled per relay — pool.publish
// returns per-relay promises, not one). Run from app/ with the server up.
import { readFileSync, writeFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

const BASE = 'http://127.0.0.1:8090'
const RELAYS = (process.env.RELAYS || 'wss://relay.primal.net').split(',')

const adminSk = new Uint8Array(Buffer.from(readFileSync('.test-admin-sk.hex', 'utf8').trim(), 'hex'))
const stationSk = new Uint8Array(Buffer.from(readFileSync('.seed-station-sk', 'utf8').trim(), 'hex'))
const stationPubkey = getPublicKey(stationSk)

const pool = new SimplePool()
const publishReading = async (pm25) => {
  const event = finalizeEvent({
    kind: 4223,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['t', 'weather'], ['a', `16158:${stationPubkey}:`], ['pm25', String(pm25), 'PMS5003']],
    content: ''
  }, stationSk)
  const settled = await Promise.allSettled(pool.publish(RELAYS, event, { maxWait: 8000 }))
  const ok = settled.filter((r) => r.status === 'fulfilled').length
  console.log(`seeded pm25 ${pm25} → accepted by ${ok}/${settled.length} relay(s)`)
  if (ok === 0) throw new Error('no relay accepted the reading')
}

const login = async () => {
  const event = finalizeEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000),
    tags: [['u', '/api/auth'], ['method', 'POST']], content: ''
  }, adminSk)
  const res = await fetch(`${BASE}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event }) })
  const body = await res.json()
  if (!body.token) throw new Error(`login failed: ${JSON.stringify(body)}`)
  writeFileSync('.test-token', body.token)
  return body.token
}

const api = async (path, init, token) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...(init?.headers || {}), authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json() }
}

const modes = async (token) => {
  const { body } = await api('/api/devices', undefined, token)
  return body.devices.map((d) => d.telemetry.power_mode)
}

const waitFor = async (token, predicate, label, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await modes(token)
    if (predicate(current)) { console.log(`${label}: ${JSON.stringify(current)} ✓`); return current }
    if (Date.now() > deadline) throw new Error(`${label} timeout; last: ${JSON.stringify(current)}`)
    await new Promise((r) => setTimeout(r, 3000))
  }
}

const token = await login()
console.log('logged in; station:', stationPubkey.slice(0, 16), '…')

const enable = await api('/api/autopilot', {
  method: 'PUT', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ enabled: true, stations: [stationPubkey] })
}, token)
console.log('autopilot enabled:', enable.body.config.enabled, 'stations:', enable.body.config.stations.length)

await new Promise((r) => setTimeout(r, 3000)) // let the subscription settle
await publishReading(45)
await waitFor(token, (m) => m.every((x) => x === 'high'), 'fleet HIGH after spike')

await publishReading(12)
await waitFor(token, (m) => m.every((x) => x === 'eco'), 'fleet eco after drop')

console.log('\nAUTOPILOT E2E OK')
process.exit(0)
