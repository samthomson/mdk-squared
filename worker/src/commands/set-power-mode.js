'use strict'

const client = require('../client')

module.exports = async (params) => client.setPowerMode(params.mode)
