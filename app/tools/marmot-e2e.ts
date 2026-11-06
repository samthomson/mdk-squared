// Marmot self-test: two mdk² identities in this process go through the full
// protocol our app relies on — key packages, relay lists, group create,
// invite, join-from-welcome, and an E2EE application message round trip.
// This is the P5a spike minus the White Noise side (which needs a human with
// the app; see README "Inviting the bot").
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { v2 as nip44v2 } from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { serialize as v8Serialize, deserialize as v8Deserialize } from 'node:v8'
import { MarmotClient, createApplicationMessageIntent, createChatRumor, createInboxRelayListEvent, createNip65RelayListEvent, deserializeApplicationData, getNip65Relays } from '@internet-privacy/marmot-ts'
import type { GenericKeyValueStore, SerializedClientState, StoredKeyPackage } from '@internet-privacy/marmot-ts'
import type { NostrNetworkInterface, PublishResponse, Subscribable } from '@internet-privacy/marmot-ts/client'
import type { NostrEvent } from 'applesauce-core'
import type { Event } from 'nostr-tools/pure'

const RELAYS = (process.env.RELAYS || 'wss://relay.primal.net').split(',')
const SCRATCH = path.resolve('data-marmot-e2e')
fs.rmSync(SCRATCH, { recursive: true, force: true })

class FileKeyValueStore<T> implements GenericKeyValueStore<T> {
  constructor (private readonly dir: string) { fs.mkdirSync(dir, { recursive: true }) }
  private file (key: string): string { return path.join(this.dir, `${encodeURIComponent(key)}.bin`) }
  async getItem (key: string): Promise<T | null> {
    return fs.existsSync(this.file(key)) ? v8Deserialize(fs.readFileSync(this.file(key))) as T : null
  }
  async setItem (key: string, value: T): Promise<T> { fs.writeFileSync(this.file(key), v8Serialize(value)); return value }
  async removeItem (key: string): Promise<void> { const f = this.file(key); if (fs.existsSync(f)) fs.unlinkSync(f) }
  async clear (): Promise<void> { for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f)) }
  async keys (): Promise<string[]> { return fs.readdirSync(this.dir).map((f) => decodeURIComponent(f.replace(/\.bin$/, ''))) }
}

class SkSigner {
  private readonly sk: Uint8Array
  constructor (secretHex: string) { this.sk = new Uint8Array(Buffer.from(secretHex, 'hex')) }
  getPublicKey (): string { return getPublicKey(this.sk) }
  signEvent (draft: Parameters<typeof finalizeEvent>[0]): Event { return finalizeEvent(draft, this.sk) }
  nip44 = {
    encrypt: (pubkey: string, plaintext: string) => nip44v2.encrypt(plaintext, nip44v2.utils.getConversationKey(this.sk, pubkey)),
    decrypt: (pubkey: string, payload: string) => nip44v2.decrypt(payload, nip44v2.utils.getConversationKey(this.sk, pubkey))
  }
}
class PoolNetwork implements NostrNetworkInterface {
  private readonly pool = new SimplePool()
  async publish (relays: string[], event: unknown): Promise<Record<string, PublishResponse>> {
    const record: Record<string, PublishResponse> = {}
    await Promise.all(relays.map(async (relay) => {
      try {
        const handle = await this.pool.ensureRelay(relay)
        await handle.publish(event as Event)
        record[relay] = { from: relay, ok: true }
      } catch (err) {
        record[relay] = { from: relay, ok: false, message: (err as Error).message }
      }
    }))
    return record
  }

  async request (relays: string[], filters: object): Promise<NostrEvent[]> {
    // nostr-tools querySync takes one filter; marmot passes arrays.
    const list = Array.isArray(filters) ? filters as object[] : [filters]
    const batches = await Promise.all(list.map((f) => this.pool.querySync(relays, f as Parameters<SimplePool['querySync']>[1])))
    const seen = new Set<string>()
    const merged: NostrEvent[] = []
    for (const event of batches.flat()) {
      if (seen.has(event.id)) continue
      seen.add(event.id)
      merged.push(event as unknown as NostrEvent)
    }
    return merged
  }

  subscription (relays: string[], filters: object): Subscribable<NostrEvent> {
    return {
      subscribe: (observer) => {
        const sub = this.pool.subscribeMany(relays, filters as Parameters<SimplePool['subscribeMany']>[1], {
          onevent: (event: Event) => observer.next?.(event as unknown as NostrEvent),
          onclose: () => observer.complete?.()
        })
        return { unsubscribe: () => sub.close() }
      }
    }
  }
  async getUserInboxRelays (pubkey: string): Promise<string[]> {
    const lists = await this.pool.querySync(RELAYS, { kinds: [10050], authors: [pubkey] })
    const newest = lists.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return []
    return newest.tags.filter(([k]) => k === 'relay').map(([, url]) => url).filter(Boolean)
  }
  close (): void { this.pool.close(RELAYS) }
}

async function makeClient (name: string): Promise<{ client: MarmotClient, network: PoolNetwork, npub: string }> {
  const secretHex = Buffer.from(generateSecretKey()).toString('hex')
  const signer = new SkSigner(secretHex)
  const network = new PoolNetwork()
  const client = new MarmotClient({
    signer,
    network,
    groupStateStore: new FileKeyValueStore<SerializedClientState>(path.join(SCRATCH, name, 'groups')),
    keyPackageStore: new FileKeyValueStore<StoredKeyPackage>(path.join(SCRATCH, name, 'key-packages')),
    clientId: crypto.randomBytes(32).toString('hex')
  })
  const pubkey = await client.signer.getPublicKey()
  // Relay lists + key package so the other side can invite us.
  const nip65 = await client.signer.signEvent(createNip65RelayListEvent({ pubkey, relays: RELAYS }))
  const inbox = await client.signer.signEvent(createInboxRelayListEvent({ pubkey, relays: RELAYS }))
  await client.network.publish(RELAYS, nip65)
  await client.network.publish(RELAYS, inbox)
  await client.keyPackages.ensurePublished({ relays: RELAYS, client: 'mdk2-e2e' })
  return { client, network, npub: pubkey }
}

const A = await makeClient('alice')
const B = await makeClient('bob')
console.log('alice:', A.npub.slice(0, 16), '…  bob:', B.npub.slice(0, 16), '…')

// Alice creates a group and invites Bob by his published key package.
const group = await A.client.groups.create('mdk² test group', { relays: RELAYS })
// Relay propagation: bob published his lists milliseconds ago; poll until
// the relay serves them back.
const withRetry = async <T>(fn: () => Promise<T>, isEmpty: (v: T) => boolean, label: string, attempts = 10): Promise<T> => {
  for (let i = 1; i <= attempts; i++) {
    const value = await fn()
    if (!isEmpty(value)) return value
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw new Error(`${label}: empty after ${attempts} attempts`)
}

const relayLists = await withRetry(
  () => A.client.network.request(RELAYS, [{ kinds: [10002], authors: [B.npub] }]),
  (list) => list.length === 0,
  'bob NIP-65 relay list'
)
const keyPackageRelays = getNip65Relays(relayLists.sort((a, b) => b.created_at - a.created_at)[0], 'write')
const candidates = await withRetry(
  () => A.client.network.request(keyPackageRelays.length ? keyPackageRelays : RELAYS, [{ kinds: [30443], authors: [B.npub] }]),
  (list) => list.length === 0,
  'bob key packages'
)
const keyPackageEvent = candidates
  .sort((a, b) => b.created_at - a.created_at)
  .find((ev) => group.evaluateKeyPackage(ev).eligible)
if (!keyPackageEvent) throw new Error('no eligible key package for bob')
await A.client.groups.invite(group.id, keyPackageEvent)
console.log('invite committed')

// Bob listens for the gift-wrapped welcome and joins from it.
const inviteSub = await B.client.invites.listen(RELAYS)
await withRetry(
  async () => { await B.client.invites.decryptGiftWraps(); return await B.client.invites.getUnread() },
  (list) => list.length === 0,
  'bob welcome'
)
const unread = await B.client.invites.getUnread()
const welcome = unread[0]
if (!welcome) throw new Error('unread invite carries no welcome')
const { group: joined } = await B.client.joinGroupFromWelcome({ welcomeRumor: welcome as never })
await B.client.invites.markAsRead(unread[0].id)
console.log('bob joined group:', joined.idStr.slice(0, 20), '… members:', joined.snapshot.members.length)

// Connect both sides; Alice sends, Bob receives.
await Promise.all([
  A.client.groups.connectAll({ fallbackRelays: RELAYS }),
  B.client.groups.connectAll({ fallbackRelays: RELAYS })
])

const { promise: received, resolve: resolveReceived } = Promise.withResolvers<string>()
joined.on('applicationMessage', (data: Uint8Array) => {
  const rumor = deserializeApplicationData(data)
  if (rumor && rumor.pubkey === A.npub) resolveReceived(String(rumor.content))
})

const sent = createChatRumor({ pubkey: A.npub, content: '!air on high' })
await A.client.groups.send(group.id, createApplicationMessageIntent(sent))
console.log('alice sent: !air on high')

const message = await Promise.race([
  received,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('message round-trip timed out')), 45000))
])
console.log('bob received:', message)
if (message !== '!air on high') throw new Error('content mismatch')

inviteSub.unsubscribe()
A.network.close()
B.network.close()
console.log('\nMARMOT E2E OK — group create → invite → join → E2EE message round trip')
process.exit(0)
