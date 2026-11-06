'use strict'

const client = require('../client')

module.exports = async (params) => client.setMining(Boolean(params.enabled))
