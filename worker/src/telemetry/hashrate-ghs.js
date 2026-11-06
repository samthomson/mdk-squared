'use strict'

const client = require('../client')

module.exports = async () => (await client.getSystemInfo()).hashrate_ghs
