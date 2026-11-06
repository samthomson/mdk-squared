// Seeds a fake nostr weather station (kinds 16158 + 4223, draft NIP PR 2163)
// and drives its PM2.5 readings. Used to demo/verify the autopilot:
//   node tools/seed-weather.mjs station [initialPm25]
//   node tools/seed-weather.mjs pm25 40   # spike → autopilot engages
//   node tools/seed-weather.mjs pm25 12   # drop → autopilot disengages
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'

const RELAYS = (process.env.RELAYS || 'wss://relay.primal.net,wss://relay.damus.io').split(',')
const KEY_FILE = new URL('../.seed-station-sk', import.meta.url)

const pool = new SimplePool()
const sk = existsSync(KEY_FILE)
  ? new Uint8Array(Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'hex'))
  : generateSecretKey()
writeFileSync(KEY_FILE, Buffer.from(sk).toString('hex'))
const pubkey = getPublicKey(sk)
console.log('station pubkey:', pubkey)

const publish = async (event) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await pool.publish(RELAYS, event)
      console.log('published', event.kind)
      return
    } catch (err) {
      console.log(`publish attempt ${attempt} failed: ${err.message}`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
  }
  throw new Error('publish failed after 3 attempts')
}

const reading = (pm25) => finalizeEvent({
  kind: 4223,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['t', 'weather'], ['a', `16158:${pubkey}:`], ['pm25', String(pm25), 'PMS5003']],
  content: ''
}, sk)

const [cmd, arg] = process.argv.slice(2)

if (cmd === 'station') {
  await publish(finalizeEvent({
    kind: 16158,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['name', 'mdk² seed station'],
      ['g', 'u4pr'],
      ['power', 'mains'],
      ['connectivity', 'wifi'],
      ['sensor', 'pm25', 'PMS5003']
    ],
    content: ''
  }, sk))
  await publish(reading(arg ?? 18))
} else if (cmd === 'pm25') {
  await publish(reading(arg))
} else {
  console.log('usage: node tools/seed-weather.mjs station [initialPm25] | pm25 <value>')
  process.exit(1)
}

process.on('unhandledRejection', () => {})
try { pool.close(RELAYS) } catch {}
process.exit(0)
