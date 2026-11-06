// The Marmot plane on White Noise's own engine: a `wn`/`wnd` (Rust MDK)
// account driven over the wn CLI's JSON output. Because the key packages and
// group bytes come from the same implementation White Noise runs, invites
// from the production app work by construction — this replaces the marmot-ts
// bridge, whose v2-track key packages WN rejects as incompatible.
//
// Layout: WN_HOME=<dataDir>/wn-home (file secret store, dev profile), the
// daemon is a child process, and a poll loop every few seconds: accept
// invites, sync members into authz, read new messages, run !air commands,
// reply. Same MarmotBridge interface as marmot.ts.

import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import type { MarmotBridge, MarmotDeps, MarmotStatus } from './marmot'
import { parseAirCommand } from './marmot'
import { nip19 } from 'nostr-tools'

const POLL_MS = 4000

interface WnEnvelope { ok?: boolean, error?: string, data?: unknown }

export async function wnAvailable (): Promise<boolean> {
  try {
    await runWn(['--help'], {})
    return true
  } catch {
    return false
  }
}

async function runWn (args: string[], env: Record<string, string>, cwd?: string): Promise<unknown> {
  const child = spawn('wn', args, {
    env: { ...process.env, ...env },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += c })
  child.stderr.on('data', (c) => { err += c })
  // spawn failures (ENOENT) surface as an async 'error' event, not a throw.
  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', resolve)
  })
  if (code !== 0) throw new Error(`wn ${args[0]}… exit ${code}: ${(err || out).slice(0, 300)}`)
  const text = out.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return text
  // Stable JSON envelope: unwrap the payload the CLI actually returns.
  const parsed = JSON.parse(text) as WnEnvelope
  if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
    if (!parsed.ok) throw new Error(`wn error: ${parsed.error ?? 'unknown'}`)
    const payload = (parsed as { result?: unknown, data?: unknown }).result ?? (parsed as { data?: unknown }).data
    return payload ?? parsed
  }
  return parsed
}

export async function createRustMarmotBridge (deps: MarmotDeps): Promise<MarmotBridge> {
  if (!(await wnAvailable())) throw new Error('ERR_WN_NOT_INSTALLED: falling back to marmot-ts')
  const home = path.join(deps.dataDir, 'wn-home')
  const env: Record<string, string> = {
    WN_HOME: home,
    WN_SECRET_STORE: 'file',
    WN_ACCOUNT: '' // set once the npub is known
  }

  // 1. Daemon: keeps the account synced and receives Welcomes live.
  // The daemon's discovery relay becomes the GROUP's message relays — use a
  // full relay from RELAYS, never a directory relay like purplepag.es
  // (it rejects kind 445 group messages). purplepag.es still joins discovery
  // so the directory can resolve accounts whose lists live only there.
  const discovery = [deps.relays[0] ?? 'wss://relay.primal.net', 'wss://purplepag.es'].join(',')
  const daemon = spawn('wn', [
    'daemon', 'start',
    '--discovery-relays', discovery,
    '--default-account-relays', deps.relays[0] ?? 'wss://relay.primal.net',
    ...deps.relays.slice(1).flatMap((r) => ['--default-account-relays', r])
  ], { env: { ...process.env, ...env }, stdio: 'ignore' })
  daemon.on('error', (err) => deps.store.record('marmot', `wn daemon failed: ${err.message}`))
  // 2. Identity: create once; the account lives in WN_HOME across restarts.
  const accountsRaw = await runWn(['accounts', 'list', '--json'], env) as unknown
  const accounts = (Array.isArray(accountsRaw) ? accountsRaw : (accountsRaw as { accounts?: unknown[] })?.accounts ?? []) as Array<{ npub?: string, account_id?: string }>
  const existing = accounts[0]
  let npub: string
  if (existing?.npub) {
    npub = existing.npub
  } else {
    const created = await runWn(['create-identity', '--json'], env) as { npub?: string, account_id?: string }
    npub = created.npub ?? (created.account_id ? nip19.npubEncode(created.account_id) : '')
  }
  if (!npub.startsWith('npub1')) throw new Error(`ERR_WN_IDENTITY: unexpected ${npub}`)
  env.WN_ACCOUNT = npub
  // Every account-scoped call names the account explicitly.
  const scoped = (args: string[]): string[] => ['--account', npub, ...args]
  deps.store.record('marmot', `rust engine account ${npub.slice(0, 20)}…`)
  let members: string[] = []
  let groupHex: string | null = null
  let lastError: string | null = null
  let stopped = false
  const seenMessages = new Set<string>()
  let announced = false
  let lastForwardAt = 0

  const send = async (text: string): Promise<void> => {
    try {
      // --json up front: trailing flags get parsed as message text.
      await runWn(['--json', ...scoped(['messages', 'send', groupHex ?? '', text])], env)
    } catch (err) {
      deps.store.record('marmot', `reply failed: ${(err as Error).message}`)
    }
  }

  const deviceLine = (d: { id: string, telemetry: Record<string, unknown> }) =>
    `${d.id}: ${String(d.telemetry.power_mode ?? '?')} · ${Number(d.telemetry.pm25_ugm3 ?? 0).toFixed(1)} µg/m³ · ${(Number(d.telemetry.hashrate_ghs ?? 0) / 1000).toFixed(2)} TH/s · ${Number(d.telemetry.temp_c ?? 0).toFixed(0)}°C`

  const handleCommand = async (senderNpub: string, text: string): Promise<void> => {
    const parsed = parseAirCommand(text)
    if (!parsed) return
    if ('error' in parsed) {
      await send(`⚠️ ${parsed.error}`)
      return
    }

    if (parsed.name === 'status') {
      const fleet = await deps.fleetStatus()
      const auto = deps.autopilotStatus() as { engaged?: boolean, config?: { enabled?: boolean }, overrideUntil?: number | null }
      const mean = fleet.devices.length > 0 ? fleet.devices.reduce((s, d) => s + Number(d.telemetry.pm25_ugm3 ?? 0), 0) / fleet.devices.length : 0
      const hash = fleet.devices.reduce((s, d) => s + Number(d.telemetry.hashrate_ghs ?? 0), 0) / 1000
      const autoState = !auto?.config?.enabled ? 'off' : auto.engaged ? 'PURIFYING (high)' : (auto.overrideUntil && auto.overrideUntil > Date.now()) ? 'paused (manual)' : 'monitoring'
      await send(
        `📊 mdk² status\n` +
        `• air: ${mean.toFixed(1)} µg/m³ (fleet mean)\n` +
        `• auto: ${autoState}\n` +
        `• ${fleet.devices.length} devices · ${hash.toFixed(2)} TH/s total`
      )
      return
    }
    if (parsed.name === 'devices') {
      const fleet = await deps.fleetStatus()
      await send(`⛏ devices\n${fleet.devices.map((d) => '• ' + deviceLine(d)).join('\n')}`)
      return
    }
    if (parsed.name === 'auto') {
      const auto = deps.autopilotStatus() as { engaged?: boolean, overrideUntil?: number | null, config?: { enabled?: boolean, onUgm3?: number, offUgm3?: number, idleMode?: string, stations?: string[] }, readings?: Array<{ station: string, value: number, at: number }> }
      if (!auto?.config) { await send('⚠️ autopilot state unavailable'); return }
      const lines = [
        `• state: ${!auto.config.enabled ? 'off' : auto.engaged ? 'PURIFYING (high)' : (auto.overrideUntil && auto.overrideUntil > Date.now()) ? 'paused (manual override)' : 'monitoring'}`,
        `• stations: ${auto.config.stations?.length ?? 0} watched`,
        ...(auto.readings ?? []).map((r) => `• latest: ${r.value.toFixed(1)} µg/m³ @ ${r.station.slice(0, 8)}…`),
        `• purify above ${auto.config.onUgm3} · idle below ${auto.config.offUgm3} at ${auto.config.idleMode}`
      ]
      await send(`🤖 autopilot\n${lines.join('\n')}`)
      return
    }
    if (parsed.name === 'toggleAuto') {
      await deps.setAutopilot({ enabled: true })
      await send('🤖 auto ON')
      return
    }
    if (parsed.name === 'toggleManual') {
      await deps.setAutopilot({ enabled: false })
      await send('✋ manual mode — you control the devices')
      return
    }
    if (parsed.name === 'help') {
      await send(
        'mdk² commands\n' +
        '• /status — one-glance summary\n' +
        '• /devices — every miner, state and telemetry\n' +
        '• /auto — autopilot: state, stations, pm2.5, thresholds\n' +
        '• /toggle auto | /toggle manual\n' +
        '• /mode <off|eco|low|high> [BA-001] — override\n' +
        '• /fan <0-100> [id] · /mining on|off [id] · /reboot BA-001\n' +
        '• /invite npub1… — add a controller'
      )
      return
    }
    if (parsed.name === 'invite') {
      const npub = String(parsed.params.npub ?? '')
      if (!npub.startsWith('npub1')) { await send('⚠️ usage: /invite npub1…'); return }
      if (!groupHex) { await send('⚠️ no group yet'); return }
      await runWn(scoped(['groups', 'add-members', groupHex, npub, '--json']), env)
      await send(`✅ invited ${npub.slice(0, 20)}… — they now control the fleet too`)
      return
    }
    deps.store.record('marmot', `chat command from ${senderNpub.slice(0, 12)}…: ${text}`)
    const outcome = await deps.onCommand(parsed)
    const results = Array.isArray(outcome) ? outcome as Array<{ status?: string }> : [outcome as { status?: string }]
    const ok = results.every((r) => r?.status === 'SUCCESS')
    await send(ok ? `✅ done: ${text.trim()}` : `⚠️ ${text.trim()} → ${JSON.stringify(outcome).slice(0, 200)}`)
  }

  const poll = async (): Promise<void> => {
    if (stopped) return
    try {
      // Pending invites: auto-accept.
      const invitesRaw = await runWn(scoped(['groups', 'invites', '--json']), env) as unknown
      const invites = (Array.isArray(invitesRaw) ? invitesRaw : (invitesRaw as { invites?: unknown[] })?.invites ?? []) as Array<{ group_id?: string }>
      for (const invite of invites) {
        if (!invite.group_id) continue
        await runWn(scoped(['groups', 'accept', invite.group_id, '--json']), env)
        groupHex = invite.group_id
        deps.store.record('marmot', `accepted invite → group ${groupHex.slice(0, 16)}…`)
      }

      if (!groupHex) {
        const groupsRaw = await runWn(scoped(['groups', 'list', '--json']), env) as unknown
        const groups = (Array.isArray(groupsRaw) ? groupsRaw : (groupsRaw as { groups?: unknown[] })?.groups ?? []) as Array<{ group_id?: string, disbanded?: boolean }>
        const live = groups.filter((g) => g.group_id && g.disbanded !== true)
        groupHex = live[live.length - 1]?.group_id ?? null
      }


      if (groupHex) {
        // Announce on every boot: identifies the live group after restarts
        // and carries a fleet summary + the command list.
        if (!announced) {
          announced = true
          const fleet = await deps.fleetStatus().catch(() => ({ devices: [] as Array<{ id: string, telemetry: Record<string, unknown> }> }))
          const lines = fleet.devices.map((d) => `${d.id}: ${String(d.telemetry.power_mode ?? '?')} · ${Number(d.telemetry.pm25_ugm3 ?? 0).toFixed(1)} µg/m³ · ${Number(d.telemetry.hashrate_ghs ?? 0).toFixed(0)} GH/s`)
          await send(
            `🔄 mdk² restarted — this is the live group.\n${lines.join('\n')}\n` +
            'say /help for commands'
          )
        }
        const membersResult = await runWn(scoped(['groups', 'members', groupHex, '--json']), env) as unknown
        const rows = (Array.isArray(membersResult) ? membersResult : (membersResult as { members?: unknown[] })?.members) as Array<{ account_id?: string, npub?: string }> ?? []
        const next = rows.map((m) => m.account_id ?? m.npub ?? '').filter(Boolean)
        if (next.join() !== members.join()) {
          members = next
          deps.authz.setMarmotMembers(members)
          deps.store.record('marmot', `group members: ${members.length}`)
        }

        const messagesRaw = await runWn(scoped(['messages', 'list', groupHex, '--limit', '10', '--json']), env) as unknown
        const messages = (Array.isArray(messagesRaw) ? messagesRaw : (messagesRaw as { messages?: unknown[] })?.messages ?? []) as Array<{ message_id?: string, message_id_hex?: string, id?: string, from?: string, sender?: string, sender_account?: string, plaintext?: string, content?: string }>
        for (const m of messages) {
          const id = m.message_id ?? m.message_id_hex ?? m.id
          const sender = m.from ?? m.sender ?? m.sender_account
          const text = m.plaintext ?? m.content
          if (!id || !sender || !text) continue
          if (seenMessages.has(id)) continue
          seenMessages.add(id)
          if (sender === npub) continue
          await handleCommand(sender, text)
        }
      }
      lastError = null
    } catch (err) {
      lastError = (err as Error).message
    }
  }

  // Status posts: autopilot transitions (pm25 engage/disengage) go to the
  // group chat, rate-limited.
  const onEvent = (entry: { kind: string, message: string }): void => {
    if (stopped || !groupHex || entry.kind !== 'autopilot') return
    if (!entry.message.startsWith('pm25')) return
    const now = Date.now()
    if (now - lastForwardAt < 30000) return
    lastForwardAt = now
    void send(`🌬️ ${entry.message}`)
  }
  deps.store.events.on('event', onEvent)

  const timer = setInterval(() => { void poll() }, POLL_MS)
  void poll()

  return {
    status: (): MarmotStatus => ({
      enabled: true,
      npub,
      groupJoined: groupHex !== null,
      groupId: groupHex,
      members,
      relays: deps.relays,
      lastError
    }),
    stop: async () => {
      stopped = true
      deps.store.events.off('event', onEvent)
      clearInterval(timer)
      daemon.kill('SIGTERM')
      if (existsSync(path.join(home, 'dev'))) {
        try { await runWn(['daemon', 'stop', '--json'], env) } catch { /* already down */ }
      }
    }
  }
}
