// The HTTP surface: NIP-98-authenticated /api routes over the MDK device
// service, the autopilot, schedules and members; the built SPA from ui/dist
// for everything else.

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { Session } from './auth'
import type { AuthService } from './auth'
import type { Authz } from './authz'
import type { Config } from './config'
import type { DeviceService, CommandOutcome } from './devices'
import type { Autopilot } from './autopilot'
import type { ScheduleRunner, ScheduleWindow } from './schedule'
import type { Store } from './store'
import type { MemberSource } from './authz'

declare module 'fastify' {
  interface FastifyRequest {
    session: Session
    authSource: MemberSource
  }
}

export interface ServerDeps {
  cfg: Config
  store: Store
  devices: DeviceService
  auth: AuthService
  authz: Authz
  autopilot: Autopilot
  schedules: ScheduleRunner
  marmotStatus: () => unknown
  manualOverride: () => void
}

const POWER_MODES = ['off', 'eco', 'low', 'high']

export function buildServer (deps: ServerDeps): FastifyInstance {
  const { cfg, store, devices, auth, authz, autopilot, schedules } = deps
  const app = Fastify({ logger: false, bodyLimit: 1 << 20 })

  const uiDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist')
  if (fs.existsSync(uiDist)) {
    void app.register(fastifyStatic, { root: uiDist })
    app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'ERR_NOT_FOUND' })
      return reply.sendFile('index.html')
    })
  }

  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.url.startsWith('/api/')) return
    if (req.url.startsWith('/api/health')) return
    if (req.url.startsWith('/api/auth')) return
    const session = auth.lookup(auth.tokenFromHeader(req.headers.authorization))
    if (!session) return reply.code(401).send({ error: 'ERR_UNAUTHENTICATED' })
    const decision = authz.decide(session.pubkey)
    if (!decision.allowed) return reply.code(403).send({ error: 'ERR_FORBIDDEN', npub: session.npub })
    req.session = session
    req.authSource = decision.source!
  })

  app.get('/api/health', async () => ({ ok: true, workerId: cfg.workerId }))

  // NIP-98: the client signs a kind 27235 event with u = '/api/auth' and
  // sends it as the request body.
  app.post('/api/auth', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { event?: unknown } | null
    const event = auth.parseEvent(req.headers.authorization, body?.event)
    if (!event) return reply.code(400).send({ error: 'ERR_NO_AUTH_EVENT' })
    const verified = auth.verify(event, '/api/auth')
    if (!verified) return reply.code(401).send({ error: 'ERR_NIP98_INVALID' })
    const decision = authz.decide(verified.pubkey)
    if (!decision.allowed) return reply.code(403).send({ error: 'ERR_FORBIDDEN' })
    const { token, session } = auth.issue(verified.pubkey)
    store.record('auth', `sign-in ${session.npub.slice(0, 16)}… via ${decision.source}`)
    return { token, npub: session.npub, isAdmin: authz.isAdmin(verified.pubkey), source: decision.source }
  })

  app.get('/api/me', async (req: FastifyRequest) => ({
    npub: req.session.npub,
    isAdmin: authz.isAdmin(req.session.pubkey),
    source: req.authSource
  }))

  app.get('/api/devices', async () => {
    const [workers, perDevice] = await Promise.all([
      devices.workers(),
      Promise.all(devices.specs.map(async (spec) => {
        const [telemetry, health] = await Promise.all([
          devices.telemetry(spec.deviceId).catch(() => ({})),
          devices.health(spec.deviceId).catch(() => null)
        ])
        return {
          id: spec.deviceId,
          mock: !cfg.realDevices,
          telemetry,
          health,
          schedule: schedules.get(spec.deviceId)
        }
      }))
    ])
    return { workerCount: workers.length, workers, devices: perDevice }
  })

  const runCommand = async (deviceId: string, command: string, params: Record<string, unknown>, reply: FastifyReply): Promise<CommandOutcome | FastifyReply> => {
    if (!devices.specs.some((s) => s.deviceId === deviceId)) {
      return reply.code(404).send({ error: 'ERR_UNKNOWN_DEVICE', deviceId })
    }
    const outcome = await devices.command(deviceId, command, params)
    store.record('command', `${deviceId} ${command} ${JSON.stringify(params)} → ${outcome.status}`, outcome)
    if (outcome.status !== 'SUCCESS' && outcome.status !== 'TIMEOUT') {
      return reply.code(422).send({ error: outcome.error || 'ERR_COMMAND_FAILED', outcome })
    }
    deps.manualOverride()
    return outcome
  }

  app.post('/api/devices/:id/power', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const { mode } = req.body as { mode?: string }
    if (!mode || !POWER_MODES.includes(mode)) {
      return reply.code(400).send({ error: 'ERR_BAD_MODE', modes: POWER_MODES })
    }
    return runCommand(id, 'setPowerMode', { mode }, reply)
  })

  app.post('/api/devices/:id/fan', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const { pct } = req.body as { pct?: number }
    if (typeof pct !== 'number' || pct < 0 || pct > 100) {
      return reply.code(400).send({ error: 'ERR_BAD_FAN_PCT' })
    }
    return runCommand(id, 'setFanSpeed', { pct }, reply)
  })

  app.post('/api/devices/:id/mining', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    const { enabled } = req.body as { enabled?: boolean }
    if (typeof enabled !== 'boolean') return reply.code(400).send({ error: 'ERR_BAD_ENABLED' })
    return runCommand(id, 'setMining', { enabled }, reply)
  })

  app.get('/api/devices/:id/schedule', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string }
    return { deviceId: id, windows: schedules.get(id) }
  })

  app.put('/api/devices/:id/schedule', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string }
    if (!devices.specs.some((s) => s.deviceId === id)) {
      return reply.code(404).send({ error: 'ERR_UNKNOWN_DEVICE', deviceId: id })
    }
    const { windows } = req.body as { windows?: ScheduleWindow[] }
    if (!Array.isArray(windows)) return reply.code(400).send({ error: 'ERR_BAD_SCHEDULE' })
    const saved = schedules.set(id, windows)
    store.record('schedule', `schedule updated for ${id} (${windows.length} window(s))`)
    return { deviceId: id, windows: saved }
  })

  app.get('/api/autopilot', async () => autopilot.status())

  app.put('/api/autopilot', async (req: FastifyRequest) => {
    const patch = req.body as Record<string, unknown>
    const allowed: Record<string, true> = { enabled: true, onUgm3: true, offUgm3: true, idleMode: true, stations: true }
    const filtered = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed[k]))
    const status = autopilot.update(filtered)
    store.record('autopilot', 'config updated', status.config)
    return status
  })


  app.post('/api/autopilot/resume', async () => { autopilot.resume(); return autopilot.status() })
  app.post('/api/autopilot/simulate', async (req: FastifyRequest) => {
    const { value } = req.body as { value?: number }
    if (typeof value !== 'number' || value < 0 || value > 500) {
      return { error: 'ERR_BAD_VALUE' }
    }
    return await autopilot.simulate(value)
  })

  app.get('/api/stations', async () => ({ stations: await autopilot.discoverStations() }))

  app.get('/api/members', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authz.isAdmin(req.session.pubkey)) return reply.code(403).send({ error: 'ERR_ADMIN_ONLY' })
    return { admin: cfg.adminNpub, members: authz.list(), sources: { marmot: deps.marmotStatus() } }
  })

  app.put('/api/members', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authz.isAdmin(req.session.pubkey)) return reply.code(403).send({ error: 'ERR_ADMIN_ONLY' })
    const { npub } = req.body as { npub?: string }
    if (!npub) return reply.code(400).send({ error: 'ERR_MEMBER_NPUB_REQUIRED' })
    try {
      const member = authz.add(npub, req.session.npub)
      store.record('auth', `member added: ${npub.slice(0, 16)}…`)
      return { member }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
  })

  app.delete('/api/members/:npub', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authz.isAdmin(req.session.pubkey)) return reply.code(403).send({ error: 'ERR_ADMIN_ONLY' })
    const { npub } = req.params as { npub: string }
    return { removed: authz.remove(decodeURIComponent(npub)) }
  })

  app.get('/api/marmot', async () => deps.marmotStatus())

  app.get('/api/events', async (req: FastifyRequest) => {
    const { limit } = req.query as { limit?: string }
    return { events: store.recent(Number(limit) || 200) }
  })

  return app
}
