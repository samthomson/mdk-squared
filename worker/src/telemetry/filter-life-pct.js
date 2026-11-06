'use strict'

const client = require('../client')

module.exports = async () => (await client.getSystemInfo()).filter_life_pct
