import { SimplePool } from 'nostr-tools/pool'
import { nip19 } from 'nostr-tools'
const relays = ['wss://relay.relaying.earth', 'wss://relay.primal.net', 'wss://relay.samt.st']
const pool = new SimplePool()
const events = await pool.querySync(relays, { kinds: [16158] }, { maxWait: 4000 })
const seen = new Set()
const stations = []
for (const ev of events) {
  if (seen.has(ev.pubkey)) continue
  if (!ev.tags.some(([k, v]) => k === 'sensor' && v === 'pm25')) continue
  seen.add(ev.pubkey)
  stations.push({ pubkey: ev.pubkey, name: ev.tags.find(([k]) => k === 'name')?.[1] ?? null, latest: null })
}
if (stations.length > 0) {
  const readings = await pool.querySync(relays, { kinds: [4223], authors: stations.map(s => s.pubkey), limit: 300 }, { maxWait: 4000 })
  for (const ev of readings) {
    const v = Number(ev.tags.find(([k]) => k === 'pm25')?.[1])
    if (!Number.isFinite(v)) continue
    const s = stations.find(x => x.pubkey === ev.pubkey)
    if (s && (!s.latest || ev.created_at * 1000 > s.latest.at)) s.latest = { value: v, at: ev.created_at * 1000 }
  }
}
console.log(`stations found on WEATHER_RELAYS: ${stations.length}`)
for (const s of stations.slice(0, 5)) {
  console.log(`  ${s.name ?? nip19.npubEncode(s.pubkey).slice(0, 12)}… → ${s.latest ? s.latest.value.toFixed(1) + ' µg/m³ @ ' + new Date(s.latest.at).toISOString() : 'no recent reading'}`)
}
process.exit(0)
