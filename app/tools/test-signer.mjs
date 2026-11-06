// Headless-verification helper: a tiny CORS-open signer for the test admin
// key, so a browser without a Nostr extension can complete NIP-98 login.
// Test-only; never run in production.
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'

const sk = new Uint8Array(Buffer.from(readFileSync('.test-admin-sk.hex', 'utf8').trim(), 'hex'))

http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-headers', 'content-type')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }
  res.setHeader('content-type', 'application/json')
  if (req.method === 'GET' && req.url === '/pk') {
    res.end(JSON.stringify({ pubkey: getPublicKey(sk) }))
    return
  }
  if (req.method === 'POST' && req.url === '/sign') {
    let buf = ''
    req.on('data', (c) => { buf += c })
    req.on('end', () => {
      const template = JSON.parse(buf || '{}')
      res.end(JSON.stringify(finalizeEvent(template, sk)))
    })
    return
  }
  res.statusCode = 404
  res.end('{}')
}).listen(8123, '127.0.0.1', () => console.log('test signer on :8123'))
