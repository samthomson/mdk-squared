'use strict'

// Contract-level tests: drive loadContract + validateContract + createInstance
// against the mock, with no WorkerRuntimeV2 involved (the shape the
// build-a-worker guide prescribes for third-party packages).

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const path = require('path')
const { loadContract, validateContract, createInstance } = require('@tetherto/mdk-worker')
const { createServer } = require('../mock/server')

const pkgDir = path.join(__dirname, '..')

const bootMock = async (serial) => {
  const mock = createServer({ host: '127.0.0.1', port: 0, serial })
  await once(mock.server, 'listening')
  return mock
}

const openInstance = (port, serial) => {
  const { contract, entries } = loadContract(pkgDir)
  const device = {
    id: serial,
    opts: { host: '127.0.0.1', port },
    env: {},
    config: {},
    workerId: 'bitair-test',
    logger: () => {}
  }
  return createInstance({ dir: pkgDir, entries, device })
}

test('contract validates against the vendored schema in strict mode', () => {
  const { contract } = loadContract(pkgDir)
  const result = validateContract(contract, { dir: pkgDir, strict: true })
  assert.equal(result.ok, true, `errors: ${JSON.stringify(result.errors)}`)
})

test('declared telemetry reads live values from the device', async () => {
  const mock = await bootMock('BA-T1')
  const inst = openInstance(mock.server.address().port, 'BA-T1')

  const hashrate = await inst.telemetry.get('hashrate_ghs')()
  const power = await inst.telemetry.get('power_w')()
  const fan = await inst.telemetry.get('fan_rpm')()
  const mode = await inst.telemetry.get('power_mode')()
  const mining = await inst.telemetry.get('mining')()
  const pm25 = await inst.telemetry.get('pm25_ugm3')()
  const filter = await inst.telemetry.get('filter_life_pct')()
  const temp = await inst.telemetry.get('temp_c')()

  assert.equal(typeof hashrate, 'number')
  assert.ok(hashrate > 0, 'mining on in eco scales hashrate above zero')
  assert.equal(typeof power, 'number')
  assert.ok(fan > 0)
  assert.equal(mode, 'eco')
  assert.equal(mining, 'true')
  assert.ok(Number.isFinite(Number(pm25)), 'pm25 parses as float')
  assert.ok(filter > 0 && filter <= 100)
  assert.ok(temp > 20 && temp < 85)

  mock.exit()
})

test('commands change device state and telemetry reflects it', async () => {
  const mock = await bootMock('BA-T2')
  const port = mock.server.address().port
  const inst = openInstance(port, 'BA-T2')

  await inst.commands.get('setPowerMode')({ mode: 'high' })
  assert.equal(await inst.telemetry.get('power_mode')(), 'high')
  const highHash = await inst.telemetry.get('hashrate_ghs')()
  assert.ok(highHash > 1100, `high mode hashrate near max: ${highHash}`)

  await inst.commands.get('setMining')({ enabled: false })
  assert.equal(await inst.telemetry.get('hashrate_ghs')(), 0)

  await inst.commands.get('setFanSpeed')({ pct: 100 })
  assert.equal(await inst.telemetry.get('fan_rpm')(), 3200)

  await inst.commands.get('reboot')()
  assert.equal((await inst.telemetry.get('temp_c')()) > 0, true)

  mock.exit()
})

test('device rejects a bad mode with its ERR_ code, passed through the client', async () => {
  const mock = await bootMock('BA-T3')
  const inst = openInstance(mock.server.address().port, 'BA-T3')

  await assert.rejects(
    inst.commands.get('setPowerMode')({ mode: 'turbo' }),
    /ERR_BAD_POWER_MODE/
  )
  mock.exit()
})

test('an unreachable device surfaces ERR_DEVICE_CALL_FAILED', async () => {
  const mock = await bootMock('BA-T4')
  const port = mock.server.address().port
  const inst = openInstance(port, 'BA-T4')
  mock.exit()
  await once(mock.server, 'close')

  await assert.rejects(
    inst.telemetry.get('hashrate_ghs')(),
    /ERR_DEVICE_CALL_FAILED/
  )
})
