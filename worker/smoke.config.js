'use strict'

// Device spec for `mdk validate worker --path . --smoke`: setup() starts one
// BitAir simulator and returns how to reach it plus a sample param set per
// command. reboot is deliberately left out: nobody watches the device during
// an automated smoke run.

const { once } = require('node:events')
const { createServer } = require('./mock/server')

module.exports = {
  async setup () {
    const mock = createServer({ host: '127.0.0.1', port: 0, serial: 'SMOKE-BA' })
    await once(mock.server, 'listening')

    return {
      config: { host: '127.0.0.1', port: mock.server.address().port },
      commands: {
        setPowerMode: { mode: 'high' },
        setFanSpeed: { pct: 80 },
        setMining: { enabled: true }
      },
      teardown: () => mock.exit()
    }
  }
}
