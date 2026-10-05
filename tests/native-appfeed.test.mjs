import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-native-feed-'))
const file = path.join(temp, 'native.cjs')
await build({ entryPoints: ['apps/desktop/main/appfeed.ts'], outfile: file,
  bundle: true, platform: 'node', format: 'cjs' })
const { nativeAppFeed } = createRequire(import.meta.url)(file)
test.after(() => rmSync(temp, { recursive: true, force: true }))
const copy = { type: 'app_snapshot', epoch: 'native-test', seq: 1,
  registry: { type: 'registry_snapshot', epoch: 'native-test', cursor: { app_uuid: 'a', incarnation: 'i', rev: 1 }, records: [] },
  summaries: {}, notices: {}, runtime: { values: {}, orgs: {} } }

test('native HTTP and real Node WebSocket both authenticate with the current engine token', async t => {
  t.diagnostic(`runtime node=${process.versions.node} electron=${process.versions.electron ?? 'standalone'}`)
  const requests = [], sockets = new Set()
  const server = createServer((req, res) => {
    requests.push([req.url, req.headers['x-orgtree-desktop-token']])
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(copy))
  })
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    requests.push([req.url, req.headers['x-orgtree-desktop-token']])
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    const body = Buffer.from(JSON.stringify(copy)), header = Buffer.alloc(4)
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(body.length, 2)
    socket.write(Buffer.concat([header, body]))
    socket.on('data', () => socket.end())
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const engine = { origin: `http://127.0.0.1:${server.address().port}`, token: 'fixture-first' }
  let settled
  const feed = nativeAppFeed(engine, () => { if (feed.status === 'current') settled?.() })
  async function connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`native socket failed: ${feed.error}`)), 4000)
      settled = () => { clearTimeout(timer); resolve() }
      feed.start()
    })
  }
  try {
    await connect(); feed.stop()
    engine.token = 'fixture-recovered'
    await connect()
    assert.deepEqual(requests, [
      ['/api/app/records', 'fixture-first'], ['/api/app/ws', 'fixture-first'],
      ['/api/app/records', 'fixture-recovered'], ['/api/app/ws', 'fixture-recovered'],
    ])
    assert.equal(feed.state.epoch, 'native-test')
  } finally {
    feed.stop(); for (const socket of sockets) socket.destroy()
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  }
})

test('native feed refuses a remote origin before sending its credential', async () => {
  const original = globalThis.fetch
  let calls = 0, settled
  globalThis.fetch = async () => { calls++; throw Error('must not fetch') }
  const feed = nativeAppFeed({ origin: 'https://example.invalid', token: 'fixture' }, () => {
    if (feed.status === 'offline') settled?.()
  })
  try {
    await new Promise(resolve => { settled = resolve; feed.start() })
    assert.equal(calls, 0)
    assert.match(feed.error, /Invalid local engine origin/)
  } finally { feed.stop(); globalThis.fetch = original }
})
