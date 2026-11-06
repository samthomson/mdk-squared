'use strict'

const client = require('../client')

module.exports = async () => (await client.getSystemInfo()).pm25_ugm3
