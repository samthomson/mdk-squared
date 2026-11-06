'use strict'

const client = require('../client')

module.exports = async (params) => client.setFanSpeed(Number(params.pct))
