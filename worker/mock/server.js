'use strict'

// A standalone BitAir simulator: the AxeOS-style local HTTP API the Worker's
// src/client.js speaks, the way a real BitAir on the LAN would respond. It
// knows nothing about MDK.
//
// Device model (plausible for a $179 purifier+miner; real values TBD by
// Heatbit's firmware docs):
//   - ~1.2 TH/s solo miner, up to ~220 W draw at high
//   - purification modes: off / eco / low / high, each a power+fan+hashrate scale
//   - PM2.5 sensor reading tracks a settable ambient, reduced by fan output
//
// Test/demo-only endpoints (not part of the device model, never called by the
// Worker): POST /mock/pm25 { value } drives the ambient, POST /mock/fault
// { type } injects faults (overheat, fan_stuck), POST /mock/fault { type: 'clear' }.

const http = require('http')
const debug = require('debug')('mdk:worker:bitair:mock')

const POWER_MODES = {
  off: { power: 0.04, hashrate: 0, fanPct: 0 },
  eco: { power: 0.35, hashrate: 0.5, fanPct: 25 },
  low: { power: 0.6, hashrate: 0.8, fanPct: 55 },
  high: { power: 1, hashrate: 1, fanPct: 100 }
}

const MAX_HASHRATE_GHS = 1200 // 1.2 TH/s expressed in GH/s
const MAX_POWER_W = 220
const MAX_FAN_RPM = 3200

function jitter (value) {
  return Math.round(value * (0.97 + Math.random() * 0.06) * 100) / 100
}

function createServer ({ host, port, serial }) {
  const state = {
    serial: serial || 'BA-0000',
    powerMode: 'eco',
    fanPct: POWER_MODES.eco.fanPct,
    mining: true,
    ambientPm25: 18,
    filterLifePct: 92,
    bootTime: Date.now(),
    faults: { overheat: false, fanStuck: false }
  }

  const fanPct = () => (state.faults.fanStuck ? 0 : state.fanPct)
  const fanRpm = () => Math.round(MAX_FAN_RPM * (fanPct() / 100))

  const summary = () => {
    const scale = POWER_MODES[state.powerMode]
    const hashrate = state.mining ? MAX_HASHRATE_GHS * scale.hashrate : 0
    const tempC = 42 + (scale.power * 26) + (state.faults.overheat ? 38 : 0)
    // Indoor PM2.5: the fan pulls the reading toward clean air (2 µg/m³).
    const cleaned = state.ambientPm25 * (1 - (fanPct() / 100) * 0.82)
    const pm25 = Math.max(1, cleaned * (state.faults.overheat ? 1.6 : 1))
    return {
      ok: true,
      serial: state.serial,
      model: 'BITAIR',
      firmware: 'v0.9.0-mock',
      uptime_s: Math.floor((Date.now() - state.bootTime) / 1000),
      power_mode: state.powerMode,
      fan_pct: fanPct(),
      mining: state.mining,
      hashrate_ghs: jitter(hashrate),
      power_w: jitter(MAX_POWER_W * scale.power + (state.mining ? 0 : -6)),
      fan_rpm: fanRpm(),
      temp_c: jitter(tempC),
      pm25_ugm3: String(Math.round(pm25 * 10) / 10),
      filter_life_pct: Math.round(state.filterLifePct * 10) / 10
    }
  }

  const faultsApplied = () => {
    if (state.faults.fanStuck && state.powerMode !== 'off') {
      // A stuck fan with the miner hashing is thermally bad.
      state.faults.overheat = state.faults.overheat || true
    }
  }

  const routes = {
    'GET /api/system/info': () => { faultsApplied(); return summary() },
    'POST /api/system/powermode': (body) => {
      if (!POWER_MODES[body.mode]) throw new Error(`ERR_BAD_POWER_MODE: ${body.mode}`)
      state.powerMode = body.mode
      state.fanPct = POWER_MODES[body.mode].fanPct
      return { ok: true, power_mode: state.powerMode, fan_pct: state.fanPct }
    },
    'POST /api/system/fanspeed': (body) => {
      const pct = Number(body.pct)
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('ERR_BAD_FAN_SPEED')
      state.fanPct = pct
      return { ok: true, fan_pct: fanPct() }
    },
    'POST /api/system/mining': (body) => {
      state.mining = Boolean(body.enabled)
      return { ok: true, mining: state.mining }
    },
    'POST /api/system/reboot': () => {
      state.bootTime = Date.now()
      return { ok: true, rebooting: true }
    },
    'POST /mock/pm25': (body) => {
      state.ambientPm25 = Number(body.value)
      return { ok: true, ambient_pm25: state.ambientPm25 }
    },
    'POST /mock/fault': (body) => {
      if (body.type === 'clear') { state.faults = { overheat: false, fanStuck: false }; return { ok: true, faults: state.faults } }
      if (!(body.type in state.faults)) throw new Error(`ERR_UNKNOWN_FAULT: ${body.type}`)
      state.faults[body.type] = true
      return { ok: true, faults: state.faults }
    }
  }

  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`
    const handler = routes[key]
    const reply = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (!handler) return reply(404, { ok: false, error: 'ERR_NOT_FOUND' })

    if (req.method === 'POST') {
      let buf = ''
      req.on('data', (chunk) => { buf += chunk })
      req.on('end', () => {
        try {
          reply(200, handler(JSON.parse(buf || '{}')))
        } catch (err) {
          reply(400, { ok: false, error: err.message })
        }
      })
      return
    }
    try {
      reply(200, handler({}))
    } catch (err) {
      reply(400, { ok: false, error: err.message })
    }
  })

  server.listen(port, host || '127.0.0.1', () => {
    debug('bitair mock %s listening on %s:%d', state.serial, host || '127.0.0.1', server.address().port)
  })

  return {
    server,
    state,
    exit () { server.close() }
  }
}

module.exports = { createServer }
