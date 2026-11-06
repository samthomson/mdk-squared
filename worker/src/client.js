'use strict'

// Device "vendor SDK" for the Heatbit BitAir: plain I/O against its AxeOS-style
// local HTTP API. No MDK concepts here. The runtime loads this module fresh
// into a private registry per device, so binding to the ambient device module
// at require time yields one client per device with no factory plumbing.

const { opts, env, logger } = require('@tetherto/mdk-worker/device')

// Log only non-secret fields: `env` may carry credentials - never log values.
logger('config received: host=%s port=%s env keys=%o', opts.host, opts.port, Object.keys(env || {}))

const TIMEOUT_MS = opts.timeoutMs || 5000
const base = `http://${opts.host || '127.0.0.1'}:${opts.port}`
const auth = env.DEVICE_TOKEN ? { authorization: `Bearer ${env.DEVICE_TOKEN}` } : {}

const call = async (path, callOpts = {}) => {
  let res
  let body
  try {
    res = await fetch(base + path, {
      ...callOpts,
      headers: { ...auth, ...(callOpts.headers || {}) },
      signal: callOpts.signal || AbortSignal.timeout(TIMEOUT_MS)
    })
    body = await res.json()
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`ERR_DEVICE_TIMEOUT: ${path}`)
    // An unreachable device or a non-JSON reply surfaces as this plugin's own
    // error code, not fetch's bare "fetch failed".
    throw new Error(`ERR_DEVICE_CALL_FAILED: ${(err.cause && err.cause.code) || err.message}`)
  }
  if (!res.ok || body.ok === false) {
    // The device's own ERR_* codes pass through; everything else is wrapped.
    const err = body && body.error
    if (typeof err === 'string' && err.startsWith('ERR_')) throw new Error(err)
    throw new Error(`ERR_DEVICE_CALL_FAILED: ${res.status}`)
  }
  return body
}

const post = (path, payload) => call(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload)
})

module.exports = {
  getSystemInfo: () => call('/api/system/info'),
  setPowerMode: (mode) => post('/api/system/powermode', { mode }),
  setFanSpeed: (pct) => post('/api/system/fanspeed', { pct }),
  setMining: (enabled) => post('/api/system/mining', { enabled }),
  reboot: () => post('/api/system/reboot', {})
}
