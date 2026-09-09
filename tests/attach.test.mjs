import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-attach-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const policy = await load('policy'), { Engine, ENGINE_REFUSED } = await load('engine')

const forbidden = path.join(temp, 'v1'); fs.mkdirSync(forbidden)
const dataRoot = path.join(temp, 'v2'); fs.mkdirSync(dataRoot)
const realRoot = fs.realpathSync.native(dataRoot)
const token = 'ab'.repeat(32)
const descriptor = (extra = {}) => ({ type: 'attach', protocol: 1, port: 1, enginePid: 4242, hostPid: 1, dataRootId: realRoot, token, startedAt: 'x', ...extra })

test('attach descriptor validation rejects every malformed or foreign field', () => {
  const good = descriptor()
  assert.deepEqual(policy.parseAttach(JSON.stringify(good), realRoot), { port: 1, enginePid: 4242, token })
  assert.throws(() => policy.parseAttach('not json', realRoot), /not JSON/)
  for (const delta of [{ type: 'ready' }, { protocol: 2 }, { port: 0 }, { port: 65536 }, { port: '80' },
    { enginePid: 0 }, { enginePid: 1.5 }, { token: 'short' }, { token: 'G'.repeat(64) }, { token: 7 },
    { dataRootId: 'relative' }, { dataRootId: path.join(realRoot, 'other') }])
    assert.throws(() => policy.parseAttach(JSON.stringify({ ...good, ...delta }), realRoot), undefined, JSON.stringify(delta))
  // Possession of a descriptor for a DIFFERENT root never validates here.
  assert.throws(() => policy.parseAttach(JSON.stringify(good), path.join(realRoot, 'elsewhere')))
})

function identityServer(handler) {
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      if (request.url !== '/api/desktop/identity') { response.writeHead(404); response.end(); return }
      handler(request, response)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}
const respond = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
const writeDescriptor = value => fs.writeFileSync(path.join(realRoot, 'engine-attach.json'), JSON.stringify(value))
const engineIdentity = { protocol: 1, pid: 4242, dataRootId: realRoot }

test('attach adopts a verified boot engine and refuses to stop it', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    writeDescriptor(descriptor({ port }))
    const engine = new Engine()
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    assert.equal(engine.origin, `http://127.0.0.1:${port}`)
    assert.equal(engine.token, token)
    assert.equal(engine.managed, false)
    assert.equal(engine.status.state, 'ready')
    await engine.stop() // must be a no-op: the server (our stand-in engine) stays up
    const check = await fetch(`http://127.0.0.1:${port}/api/desktop/identity`, { headers: { 'x-orgtree-desktop-token': token } })
    assert.equal(check.status, 200, 'attached stop must not shut the boot engine down')
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('attach without a descriptor is a quiet decline', async () => {
  const engine = new Engine()
  assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false)
  assert.equal(engine.attachDiagnostic, '')
  assert.equal(engine.managed, true)
})

test('wrong token, wrong process, wrong root and dead port are each rejected with a diagnostic', async () => {
  const cases = [
    // The engine only ever accepts ITS token; a descriptor left by a dead
    // host carries the previous boot's.
    { name: 'engine rejects the stale token', identity: engineIdentity, descriptorToken: '0'.repeat(64), expect: /401/ },
    { name: 'process mismatch', identity: { ...engineIdentity, pid: 4243 }, expect: /process mismatch/ },
    { name: 'root mismatch', identity: { ...engineIdentity, dataRootId: path.join(realRoot, 'other') }, expect: /root mismatch/ },
    { name: 'protocol mismatch', identity: { ...engineIdentity, protocol: 2 }, expect: /protocol mismatch/ },
  ]
  for (const options of cases) {
    const { server, port } = await identityServer((request, response) => {
      if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
      respond(response, 200, options.identity)
    })
    try {
      writeDescriptor(descriptor({ port, token: options.descriptorToken ?? token }))
      const engine = new Engine()
      assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false, options.name)
      assert.match(engine.attachDiagnostic, options.expect, options.name)
      assert.equal(engine.managed, true, options.name)
      assert.equal(engine.origin, '', options.name)
    } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  }
  // Dead port: nothing listens where the stale descriptor points.
  const idle = await identityServer(() => {})
  const deadPort = idle.port
  await new Promise(resolve => idle.server.close(resolve))
  writeDescriptor(descriptor({ port: deadPort }))
  try {
    const engine = new Engine()
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false)
    assert.notEqual(engine.attachDiagnostic, '')
    assert.equal(engine.managed, true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('refusal line parses and everything else does not', () => {
  assert.equal(policy.parseRefusal(JSON.stringify({ type: 'refused', reason: 'another engine owns this data root' })), 'another engine owns this data root')
  for (const bad of ['not json', '{}', JSON.stringify({ type: 'ready' }), JSON.stringify({ type: 'refused', reason: 7 })])
    assert.equal(policy.parseRefusal(bad), null)
  assert.equal(policy.parseRefusal(JSON.stringify({ type: 'refused', reason: 'x'.repeat(999) })).length, 300)
})

test('a refused spawn is distinguishable and the same engine can then attach (boot race recovery)', async () => {
  // node runs the stub "launch.py" (its content is JavaScript; the engine
  // only cares about the absolute interpreter path and the stdout protocol).
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-refused-'))
  fs.writeFileSync(path.join(directory, 'launch.py'),
    `console.log(JSON.stringify({ type: 'refused', reason: 'another engine owns this data root; inspect .desktop-engine-status.json' }))`)
  const engine = new Engine()
  const options = { directory, python: process.execPath, dataRoot, forbiddenRoot: forbidden, uiDirectory: directory }
  await assert.rejects(engine.start(options), error => error.message.startsWith(ENGINE_REFUSED) && /owns this data root/.test(error.message))
  // The lost race resolves by attaching once the winning host publishes.
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach(options), true, 'attach must be possible after a lost-race spawn')
    assert.equal(engine.managed, false)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('attachWithRetry waits out a host that has not published yet, and gives up on a bounded deadline', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    const late = setTimeout(() => writeDescriptor(descriptor({ port })), 300)
    const engine = new Engine()
    assert.equal(await engine.attachWithRetry({ dataRoot, forbiddenRoot: forbidden }, 3000, 100), true)
    clearTimeout(late)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json'), { force: true }) }
  const start = Date.now()
  assert.equal(await new Engine().attachWithRetry({ dataRoot, forbiddenRoot: forbidden }, 400, 100), false)
  assert.ok(Date.now() - start < 2000, 'the retry window is bounded')
})

test('an attached engine that dies underneath us reads as stopped, not forever-ready', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine = new Engine()
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    await engine.verifyAttached()
    assert.equal(engine.status.state, 'ready', 'a live attachment stays ready')
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  await new Promise(resolve => setTimeout(resolve, 50))
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'stopped')
  assert.match(engine.status.message, /Background engine stopped/)
  assert.equal(engine.origin, '')
})

test('the real owner check accepts a file this user just created (positive control)', async () => {
  const file = path.join(realRoot, 'owned-probe.json')
  fs.writeFileSync(file, '{}')
  try {
    const result = await policy.verifyDescriptorOwner(file)
    assert.equal(result.ok, true, result.detail)
    assert.match(result.detail, /^owner S-/)
  } finally { fs.rmSync(file) }
})

test('a descriptor owned by someone else is rejected BEFORE the token is sent anywhere', async () => {
  let identityRequests = 0
  const { server, port } = await identityServer((request, response) => { identityRequests++; respond(response, 200, engineIdentity) })
  try {
    writeDescriptor(descriptor({ port }))
    const engine = new Engine()
    engine.ownerCheck = async () => ({ ok: false, detail: 'owner S-1-5-21-attacker is not current user S-1-5-21-me' })
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false)
    assert.match(engine.attachDiagnostic, /owner rejected/)
    assert.equal(identityRequests, 0, 'the token must never reach an unauthenticated peer (opus F3)')
    assert.equal(engine.managed, true)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('the attach retry budget covers the host readiness timeout', () => {
  const host = fs.readFileSync('engine/service_host.py', 'utf8')
  const ready = Number(/READY_TIMEOUT = (\d+)/.exec(host)?.[1])
  assert.ok(Number.isFinite(ready) && ready > 0, 'READY_TIMEOUT not found in service_host.py')
  const { ATTACH_RETRY_BUDGET_MS } = req(path.join(temp, 'engine.cjs'))
  assert.ok(ATTACH_RETRY_BUDGET_MS >= (ready + 20) * 1000,
    `retry budget ${ATTACH_RETRY_BUDGET_MS}ms must exceed host readiness ${ready}s plus margin`)
})

test('an attached update stop is graceful, verified, and refuses when the engine will not die', async () => {
  let sawShutdown = ''
  const { server, port } = await identityServer(() => {})
  server.removeAllListeners('request')
  server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/api/desktop/shutdown') {
      sawShutdown = request.headers['x-orgtree-desktop-token']
      respond(response, 200, { accepted: true })
      setTimeout(() => server.close(), 50)
      return
    }
    if (request.url === '/api/desktop/identity' && request.headers['x-orgtree-desktop-token'] === token) return respond(response, 200, engineIdentity)
    respond(response, 401, {})
  })
  const engine = new Engine()
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  await engine.stopAttachedForUpdate(5000)
  assert.equal(sawShutdown, token, 'shutdown goes through the authenticated route')
  assert.equal(engine.status.state, 'stopped')

  // Refusal: a peer that ignores shutdown and never dies (identity keeps
  // answering, the shutdown POST 404s inside the helper server).
  const alive = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const stubborn = new Engine()
  try {
    writeDescriptor(descriptor({ port: alive.port }))
    assert.equal(await stubborn.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    await assert.rejects(stubborn.stopAttachedForUpdate(1500), /did not stop/)
  } finally { alive.server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json'), { force: true }) }
})

test('a lost attachment recovers by re-attaching to the republished host with its NEW token', async () => {
  const first = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine = new Engine()
  try {
    writeDescriptor(descriptor({ port: first.port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  await new Promise(resolve => first.server.close(resolve))
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'stopped')
  assert.equal(engine.managed, false, 'still recoverable')

  const newToken = 'cd'.repeat(32)
  const second = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== newToken) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    writeDescriptor(descriptor({ port: second.port, token: newToken }))
    assert.equal(await engine.recoverAttached({ dataRoot, forbiddenRoot: forbidden }), 'attached')
    assert.equal(engine.token, newToken, 'session signing must pick up the NEW per-boot token')
    assert.equal(engine.origin, `http://127.0.0.1:${second.port}`)
    assert.equal(engine.status.state, 'ready')
  } finally { second.server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json'), { force: true }) }
})

test('recovery falls back to a managed spawn when no host republishes, and stays recoverable when nothing works', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-spawnstub-'))
  fs.writeFileSync(path.join(directory, 'launch.py'), `
    const http = require('node:http')
    const srv = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/desktop/shutdown') { response.end('{}'); process.exit(0) }
      response.statusCode = 404; response.end()
    })
    srv.listen(0, '127.0.0.1', () => {
      console.log(JSON.stringify({ type: 'ready', protocol: 1, port: srv.address().port, pid: process.pid, dataRootId: process.env.ORGTREE_DATA }))
    })
  `)
  const options = { directory, python: process.execPath, dataRoot, forbiddenRoot: forbidden, uiDirectory: directory }
  const engine = new Engine()
  engine.managed = false // simulate a previously attached engine that was lost
  const outcome = await engine.recoverAttached(options)
  assert.equal(outcome, 'spawned')
  assert.equal(engine.managed, true)
  assert.ok(engine.origin.startsWith('http://127.0.0.1:'), engine.origin)
  await engine.stop()

  const broken = new Engine()
  broken.managed = false
  const failed = await broken.recoverAttached({ ...options, python: path.join(directory, 'missing.exe') })
  assert.equal(failed, 'failed')
  assert.equal(broken.managed, false, 'a failed recovery must remain recoverable next poll')
  assert.equal(broken.status.state, 'stopped')
  assert.match(broken.status.message, /Reconnecting/)
})
