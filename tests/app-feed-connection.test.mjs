import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
const temp = mkdtempSync(path.join(tmpdir(), 'orgtree-app-connection-'))
const output = path.join(temp, 'connection.cjs')
await build({ entryPoints: ['packages/contracts/app-feed-connection.ts'], outfile: output,
  bundle: true, platform: 'node', format: 'cjs' })
const { AppFeedConnection } = createRequire(import.meta.url)(output)
test.after(() => rmSync(temp, { recursive: true, force: true }))
const full = (epoch, seq, value = 'old') => ({ type: 'app_snapshot', epoch, seq,
  registry: { type: 'registry_snapshot', epoch, cursor: { app_uuid: 'app', incarnation: 'i', rev: 1 }, records: [] },
  summaries: {}, notices: {}, runtime: { values: { providers: { epoch, seq, value } }, orgs: {} } })
function setup() {
  const requests = [], sockets = [], timers = new Set()
  const c = new AppFeedConnection({
    copy: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    socket(receive, closed) {
      const socket = { receive: frame => receive(JSON.stringify(frame)), closed, close() { closed() } }
      sockets.push(socket); return socket
    },
    changed() {},
    later(fn, ms) { const timer = { fn, ms }; timers.add(timer); return () => timers.delete(timer) },
  })
  const probe = async () => { requests.at(-1).resolve(full('probe-only', 999)); await Promise.resolve() }
  return { c, requests, sockets, timers, probe }
}
test('only first socket copy establishes epoch; handshake timer clears after it', async () => {
  const f = setup(); f.c.start(); await f.probe()
  assert.equal(f.c.state.epoch, null)
  assert.equal(f.timers.size, 1)
  f.sockets[0].receive(full('host', 1))
  assert.equal(f.c.status, 'current')
  assert.equal(f.c.state.epoch, 'host')
  assert.equal(f.timers.size, 0)
  f.c.stop()
})
test('old socket and delayed HTTP response cannot overwrite the reconnected epoch', async () => {
  const f = setup(); f.c.start(); await f.probe()
  f.sockets[0].receive(full('old', 1))
  const request = f.c.refresh(), pending = f.requests.at(-1)
  f.sockets[0].closed()
  assert.equal(f.c.status, 'offline')
  const timer = [...f.timers][0]; f.timers.delete(timer); timer.fn()
  await f.probe()
  f.sockets[1].receive(full('new', 1, 'replacement'))
  f.sockets[0].receive(full('old', 9999))
  pending.resolve(full('old', 9999))
  await request
  assert.equal(f.c.state.value('providers'), 'replacement')
  f.c.stop()
})
test('capability off never opens a socket or retries; stop disposes pending retry', async () => {
  const f = setup(); f.c.start()
  f.requests[0].reject(Object.assign(new Error('off'), { status: 501 }))
  await Promise.resolve()
  assert.equal(f.c.status, 'unsupported')
  assert.equal(f.sockets.length, 0)
  assert.equal(f.timers.size, 0)
  f.c.stop(); f.c.start(); await f.probe()
  f.sockets[0].closed()
  assert.equal(f.timers.size, 1)
  f.c.stop()
  assert.equal(f.timers.size, 0)
})
test('silent handshake and malformed first frame both reconnect without data acceptance', async () => {
  for (const malformed of [false, true]) {
    const f = setup(); f.c.start(); await f.probe()
    if (malformed) f.sockets[0].receive({ type: 'app_runtime', epoch: 'wrong', seq: 1 })
    else { const timer = [...f.timers][0]; f.timers.delete(timer); timer.fn() }
    assert.equal(f.c.status, 'offline')
    assert.equal(f.c.state.epoch, null)
    assert.equal(f.timers.size, 1)
    f.c.stop()
  }
})
