'use strict'

const client = require('../client')

module.exports = async () => String((await client.getSystemInfo()).mining)
