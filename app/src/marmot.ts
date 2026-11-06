// The Marmot plane: the app itself is a member of one MLS group. The admin
// invites the app's npub from their Marmot client (White Noise / darkmatter);
// from then on group membership is the access list (authz reads it live) and
// the encrypted group chat is a control channel: "!air on high", "!air
// status", "!air fan 80", "!air mining off", "!air reboot BA-001".
//
// All MLS cryptography stays inside @internet-privacy/marmot-ts; this module
// owns identity persistence, the nostr-tools network adapter, and the
// command grammar. Nostr identity keys never leave this process.

import fs from 'node:fs'
import path from 'node:path'
import { serialize as v8Serialize, deserialize as v8Deserialize } from 'node:v8'
import crypto from 'node:crypto'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import { v2 as nip44v2 } from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { MarmotClient, createApplicationMessageIntent, createChatRumor, createInboxRelayListEvent, createNip65RelayListEvent, deserializeApplicationData } from '@internet-privacy/marmot-ts'
import type { GenericKeyValueStore, SerializedClientState, StoredKeyPackage } from '@internet-privacy/marmot-ts'
import type { NostrNetworkInterface, PublishResponse, Subscribable, MarmotGroup } from '@internet-privacy/marmot-ts/client'
import type { NostrEvent } from 'applesauce-core/helpers/event'
import type { Event } from 'nostr-tools/pure'
import type { Authz } from './authz'
import type { Store } from './store'

export interface ChatCommand {
  name: string
  params: Record<string, unknown>
  deviceId?: string
}

export interface FleetStatus {
  devices: Array<{ id: string, telemetry: Record<string, unknown> }>
}

export interface MarmotStatus {
  enabled: boolean
  npub: string
  groupJoined: boolean
  groupId: string | null
  members: string[]
  relays: string[]
  lastError: string | null
}

export interface MarmotBridge {
  status: () => MarmotStatus
  stop: () => Promise<void>
}

export interface MarmotDeps {
  dataDir: string
  relays: string[]
  authz: Authz
  store: Store
  onCommand: (command: ChatCommand) => Promise<unknown>
  fleetStatus: () => Promise<FleetStatus>
  autopilotStatus: () => unknown
  setAutopilot: (patch: Record<string, unknown>) => Promise<unknown>
}
// Durable store: one v8-structured-clone blob per key. Plain JSON silently
// corrupts the Uint8Array/BigInt values Marmot stores; structured clone is
// the binary-safe encoding the storage docs prescribe.
class FileKeyValueStore<T> implements GenericKeyValueStore<T> {
  constructor (private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true })
  }

  private file (key: string): string {
    return path.join(this.dir, `${encodeURIComponent(key)}.bin`)
  }

  async getItem (key: string): Promise<T | null> {
    const file = this.file(key)
    if (!fs.existsSync(file)) return null
    return v8Deserialize(fs.readFileSync(file)) as T
  }

  async setItem (key: string, value: T): Promise<T> {
    fs.writeFileSync(this.file(key), v8Serialize(value))
    return value
  }

  async removeItem (key: string): Promise<void> {
    const file = this.file(key)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  }

  async clear (): Promise<void> {
    for (const f of fs.readdirSync(this.dir)) fs.unlinkSync(path.join(this.dir, f))
  }

  async keys (): Promise<string[]> {
    return fs.readdirSync(this.dir).map((f) => decodeURIComponent(f.replace(/\.bin$/, '')))
  }
}

interface MarmotIdentity { secretHex: string; clientId: string }

function loadIdentity (dir: string): MarmotIdentity {
  const file = path.join(dir, 'identity.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as MarmotIdentity
  const identity: MarmotIdentity = {
    secretHex: Buffer.from(generateSecretKey()).toString('hex'),
    clientId: crypto.randomBytes(32).toString('hex')
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 })
  return identity
}

// The signer applesauce's EventSigner wants, with the nip44 Marmot needs to
// seal/open Welcome gift wraps — all backed by nostr-tools.
class SkSigner {
  private readonly sk: Uint8Array

  constructor (secretHex: string) {
    this.sk = new Uint8Array(Buffer.from(secretHex, 'hex'))
  }

  getPublicKey (): string {
    return getPublicKey(this.sk)
  }

  signEvent (draft: Parameters<typeof finalizeEvent>[0]): Event {
    return finalizeEvent(draft, this.sk)
  }

  nip44 = {
    encrypt: (pubkey: string, plaintext: string) =>
      nip44v2.encrypt(plaintext, nip44v2.utils.getConversationKey(this.sk, pubkey)),
    decrypt: (pubkey: string, payload: string) =>
      nip44v2.decrypt(payload, nip44v2.utils.getConversationKey(this.sk, pubkey))
  }
}

// nostr-tools SimplePool → marmot's NostrNetworkInterface. nostr-tools events
// are structurally identical to applesauce NostrEvents; the one coercion sits
// at the request() boundary.
class PoolNetwork implements NostrNetworkInterface {
  private readonly pool = new SimplePool()
  private readonly lookupRelays = ['wss://purplepag.es']

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
    const lists = await this.pool.querySync(this.lookupRelays, { kinds: [10050], authors: [pubkey] })
    const newest = lists.sort((a, b) => b.created_at - a.created_at)[0]
    if (!newest) return []
    return newest.tags.filter(([k]) => k === 'relay').map(([, url]) => url).filter(Boolean)
  }

  close (): void {
    this.pool.close(this.lookupRelays)
  }
}

const POWER_MODES = ['off', 'eco', 'low', 'high']

// Chat grammar: slash commands, with the legacy "!air …" spelling still
// accepted. "/mode high BA-002" → { name: 'setPowerMode', params: {…}, deviceId: 'BA-002' }
export function parseAirCommand (text: string): ChatCommand | { error: string } | null {
  const tokens = text.trim().split(/\s+/)
  const head = tokens[0]
  let rest = tokens.slice(1)
  if (head === '!air') {
    // legacy: !air on high [id]
  } else if (head?.startsWith('/') && head.length > 1) {
    rest = [head.slice(1), ...rest]
  } else {
    return null
  }
  const deviceId = rest.length > 0 && /^BA-[0-9]{3}$/.test(rest[rest.length - 1]) ? rest.pop() : undefined
  const [verb, arg, arg2] = rest

  switch (verb) {
    case undefined:
    case 'status':
      return { name: 'status', params: {}, deviceId }
    case 'help':
      return { name: 'help', params: {} }
    case 'devices':
      return { name: 'devices', params: {} }
    case 'auto':
      return { name: 'auto', params: {} }
    case 'toggle':
      if (arg === 'auto') return { name: 'toggleAuto', params: {} }
      if (arg === 'manual') return { name: 'toggleManual', params: {} }
      return { error: 'usage: /toggle auto | /toggle manual' }
    case 'mode': {
      const mode = POWER_MODES.includes(arg ?? '') ? arg : 'high'
      return { name: 'setPowerMode', params: { mode }, deviceId }
    }
    case 'on': {
      const mode = arg && POWER_MODES.includes(arg) && arg !== 'off' ? arg : 'high'
      return { name: 'setPowerMode', params: { mode }, deviceId }
    }
    case 'off':
      return { name: 'setPowerMode', params: { mode: 'off' }, deviceId }
    case 'eco':
    case 'low':
    case 'high':
      return { name: 'setPowerMode', params: { mode: verb }, deviceId }
    case 'fan': {
      const pct = Number(arg)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return { error: 'usage: /fan <0-100> [id]' }
      return { name: 'setFanSpeed', params: { pct }, deviceId }
    }
    case 'mining':
      if (arg !== 'on' && arg !== 'off') return { error: 'usage: /mining on|off [id]' }
      return { name: 'setMining', params: { enabled: arg === 'on' }, deviceId }
    case 'reboot':
      if (!deviceId && !/^BA-/.test(arg ?? '')) return { error: 'usage: /reboot BA-001' }
      return { name: 'reboot', params: {}, deviceId: deviceId ?? arg }
    case 'invite': {
      if (!arg || !arg.startsWith('npub1')) return { error: 'usage: /invite npub1…' }
      return { name: 'invite', params: { npub: arg } }
    }
    default:
      return { error: `unknown command "${verb}" — /help lists everything` }
  }
}

export async function createMarmotBridge (deps: MarmotDeps): Promise<MarmotBridge> {
  const dir = path.join(deps.dataDir, 'marmot')
  const identity = loadIdentity(dir)
  const signer = new SkSigner(identity.secretHex)
  const network = new PoolNetwork()
  const client = new MarmotClient({
    signer,
    network,
    groupStateStore: new FileKeyValueStore<SerializedClientState>(path.join(dir, 'group-state')),
    keyPackageStore: new FileKeyValueStore<StoredKeyPackage>(path.join(dir, 'key-packages')),
    clientId: identity.clientId
  })

  const myPubkey = await client.signer.getPublicKey()
  const npub = nip19.npubEncode(myPubkey)
  let group: MarmotGroup | null = null
  let lastError: string | null = null

  const syncMembers = (): void => {
    if (!group) return
    const members = [...group.snapshot.members]
    deps.authz.setMarmotMembers(members)
    deps.store.record('marmot', `group members: ${members.length}`)
  }

  const reply = async (content: string): Promise<void> => {
    if (!group) return
    try {
      const rumor = createChatRumor({ pubkey: myPubkey, content })
      await client.groups.send(group.id, createApplicationMessageIntent(rumor))
    } catch (err) {
      deps.store.record('marmot', `reply failed: ${(err as Error).message}`)
    }
  }

  const handleChat = async (sender: string, content: string): Promise<void> => {
    const parsed = parseAirCommand(content)
    if (!parsed) return
    if ('error' in parsed) {
      deps.store.record('marmot', `command error from ${nip19.npubEncode(sender).slice(0, 12)}…: ${parsed.error}`)
      await reply(`⚠️ ${parsed.error}`)
      return
    }
    if (parsed.name === 'status') {
      const fleet = await deps.fleetStatus()
      const lines = fleet.devices.map((d) => {
        const t = d.telemetry
        return `${d.id}: ${String(t.power_mode ?? '?')} · ${Number(t.pm25_ugm3 ?? 0).toFixed(1)} µg/m³ · ${Number(t.hashrate_ghs ?? 0).toFixed(0)} GH/s · ${Number(t.temp_c ?? 0).toFixed(0)}°C`
      })
      await reply(`🌬️ mdk² fleet:\n${lines.join('\n')}`)
      return
    }
    deps.store.record('marmot', `chat command from ${nip19.npubEncode(sender).slice(0, 12)}…: ${content}`)
    const outcome = await deps.onCommand(parsed)
    await reply(`✅ ${content.trim()} → ${JSON.stringify(outcome)}`)
  }

  const trackGroup = (joined: MarmotGroup): void => {
    group = joined
    joined.on('stateChanged', syncMembers)
    joined.on('applicationMessage', (data: Uint8Array) => {
      const rumor = deserializeApplicationData(data)
      if (rumor && rumor.pubkey !== myPubkey) void handleChat(rumor.pubkey, String(rumor.content))
    })
    syncMembers()
  }

  // Advertise where our key packages (NIP-65) and Welcomes (kind 10050) live,
  // then make sure a usable key package exists for invitations.
  try {
    const nip65 = await client.signer.signEvent(createNip65RelayListEvent({ pubkey: myPubkey, relays: deps.relays }))
    const inbox = await client.signer.signEvent(createInboxRelayListEvent({ pubkey: myPubkey, relays: deps.relays }))
    await client.network.publish([...deps.relays, 'wss://purplepag.es'], nip65)
    await client.network.publish([...deps.relays, 'wss://purplepag.es'], inbox)
    await client.keyPackages.ensurePublished({ relays: deps.relays, client: 'mdk-squared' })
  } catch (err) {
    lastError = (err as Error).message
    deps.store.record('marmot', `relay-list/key-package publish failed: ${lastError}`)
  }

  const joinPendingInvites = async (): Promise<void> => {
    try {
      const unread = await client.invites.getUnread()
      for (const invite of unread) {
        // UnreadInvite extends Rumor: the entry IS the welcome rumor itself.
        const { group: joined } = await client.joinGroupFromWelcome({ welcomeRumor: invite as never })
        await client.invites.markAsRead(invite.id)
        trackGroup(joined)
        deps.store.record('marmot', `joined group ${joined.idStr}`)
      }
      if (group) await client.groups.connectAll({ fallbackRelays: deps.relays })
    } catch (err) {
      lastError = (err as Error).message
      deps.store.record('marmot', `invite join failed: ${lastError}`)
    }
  }

  // Inbound invites: listen on our advertised inbox relays, join the group
  // from each decrypted Welcome.
  const inviteSub = await client.invites.listen(deps.relays)
  client.invites.on('decrypted', () => { void joinPendingInvites() })
  await joinPendingInvites()

  return {
    status: () => ({
      enabled: true,
      npub,
      groupJoined: group !== null,
      groupId: group ? group.idStr : null,
      members: group ? [...group.snapshot.members] : [],
      relays: deps.relays,
      lastError
    }),
    stop: async () => {
      inviteSub.unsubscribe()
      network.close()
    }
  }
}
