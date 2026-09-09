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
// This machine's %TEMP% carries inherited write ACEs for other local accounts
// (sandbox users), so the REAL trust check would rightly refuse fixtures that
// live there. Identity/lifecycle tests therefore stub it; the real check has
// its own dedicated positive and negative controls on icacls-cleaned dirs.
const trusting = engine => { engine.trustCheck = async () => ({ ok: true, detail: 'test stub' }); return engine }
// REAL trust-check fixtures cannot live under %TEMP%: its ancestor chain
// carries foreign delete-class ACEs on this machine, which the ancestor
// replacement rule rightly refuses. The worktree's own chain is clean.
const aclBase = fs.mkdtempSync(path.join(process.cwd(), 'acl-fixtures-'))
test.after(() => { try { fs.rmSync(aclBase, { recursive: true, force: true }) } catch {} })

test('attach adopts a verified boot engine and refuses to stop it', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    writeDescriptor(descriptor({ port }))
    const engine = trusting(new Engine())
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
  const engine = trusting(new Engine())
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
      const engine = trusting(new Engine())
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
    const engine = trusting(new Engine())
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false)
    assert.notEqual(engine.attachDiagnostic, '')
    assert.equal(engine.managed, true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('only the root-owned refusal code parses; everything else fails fast', () => {
  assert.equal(policy.parseRefusal(JSON.stringify({ type: 'refused', code: 'root-owned', reason: 'another engine owns this data root' })), 'another engine owns this data root')
  for (const bad of ['not json', '{}', JSON.stringify({ type: 'ready' }),
    JSON.stringify({ type: 'refused', reason: 'no code at all' }),
    JSON.stringify({ type: 'refused', code: 'future-unknown', reason: 'x' }),
    JSON.stringify({ type: 'refused', code: 'root-owned', reason: 7 })])
    assert.equal(policy.parseRefusal(bad), null, bad)
  assert.equal(policy.parseRefusal(JSON.stringify({ type: 'refused', code: 'root-owned', reason: 'x'.repeat(999) })).length, 300)
})

test('a refused spawn is distinguishable and the same engine can then attach (boot race recovery)', async () => {
  // node runs the stub "launch.py" (its content is JavaScript; the engine
  // only cares about the absolute interpreter path and the stdout protocol).
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-refused-'))
  fs.writeFileSync(path.join(directory, 'launch.py'),
    `console.log(JSON.stringify({ type: 'refused', code: 'root-owned', reason: 'another engine owns this data root; inspect .desktop-engine-status.json' }))`)
  const engine = trusting(new Engine())
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
    // Disowned-exit guard regression: the killed spawn's late 'exit' event
    // must not clobber the attachment with a 'stopped' state.
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.equal(engine.status.state, 'ready', 'a disowned child exit must not disturb a later attach')
    assert.equal(engine.origin, `http://127.0.0.1:${port}`)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('attachWithRetry waits out a host that has not published yet, and gives up on a bounded deadline', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  try {
    const late = setTimeout(() => writeDescriptor(descriptor({ port })), 300)
    const engine = trusting(new Engine())
    assert.equal(await engine.attachWithRetry({ dataRoot, forbiddenRoot: forbidden }, 3000, 100), true)
    clearTimeout(late)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json'), { force: true }) }
  const start = Date.now()
  assert.equal(await trusting(new Engine()).attachWithRetry({ dataRoot, forbiddenRoot: forbidden }, 400, 100), false)
  assert.ok(Date.now() - start < 2000, 'the retry window is bounded')
})

test('attached death needs two consecutive probe failures; a blip resets', async () => {
  const handler = (request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  }
  const { server, port } = await identityServer(handler)
  const engine = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    await engine.verifyAttached()
    assert.equal(engine.status.state, 'ready', 'a live attachment stays ready')
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  // One failed sample is a blip on a busy engine, not death.
  await new Promise(resolve => server.close(resolve))
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'ready', 'one probe failure must not declare death')
  // The engine answers again on the SAME port: the failure count resets…
  const revived = http.createServer((request, response) => {
    if (request.url === '/api/desktop/identity') return handler(request, response)
    response.writeHead(404); response.end()
  })
  await new Promise(resolve => revived.listen(port, '127.0.0.1', resolve))
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'ready')
  await new Promise(resolve => revived.close(resolve))
  // …so the next single failure is again only a blip (reset is observable)…
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'ready', 'the counter must reset on a successful probe')
  // …and the SECOND consecutive failure declares death.
  await engine.verifyAttached()
  assert.equal(engine.status.state, 'stopped')
  assert.match(engine.status.message, /Background engine stopped/)
  assert.equal(engine.origin, '')
})

test('a disowned child exit cannot clobber a live attachment (forced ordering)', async () => {
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    // The exact late-exit ordering the real race only sometimes produces.
    engine.childExited({ fake: 'disowned child object' })
    assert.equal(engine.status.state, 'ready', 'a disowned exit must be ignored')
    assert.equal(engine.origin, `http://127.0.0.1:${port}`)
  } finally { server.close(); fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
})

test('the real trust check accepts an owner-exclusive file (positive control)', async () => {
  const { execFileSync } = await import('node:child_process')
  const me = process.env.USERDOMAIN + '\\' + process.env.USERNAME
  const clean = fs.mkdtempSync(path.join(aclBase, 'clean-'))
  execFileSync('icacls', [clean, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`], { stdio: 'pipe' })
  const file = path.join(clean, 'engine-attach.json')
  fs.writeFileSync(file, '{}')
  const result = await policy.verifyDescriptorTrust(file)
  assert.equal(result.ok, true, result.detail)
  assert.match(result.detail, /^owner S-/)
})

test('the real trust check rejects foreign write access, measured with actual ACLs', async () => {
  const { execFileSync } = await import('node:child_process')
  const me = process.env.USERDOMAIN + '\\' + process.env.USERNAME
  // A user-owned FILE that Everyone can write: ownership alone would pass it.
  const looseDir = fs.mkdtempSync(path.join(aclBase, 'loose-'))
  execFileSync('icacls', [looseDir, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`], { stdio: 'pipe' })
  const looseFile = path.join(looseDir, 'engine-attach.json')
  fs.writeFileSync(looseFile, '{}')
  execFileSync('icacls', [looseFile, '/grant', '*S-1-1-0:(W)'], { stdio: 'pipe' })
  const fileVerdict = await policy.verifyDescriptorTrust(looseFile)
  assert.equal(fileVerdict.ok, false)
  assert.match(fileVerdict.detail, /descriptor writable by .*S-1-1-0/)
  // A DIRECTORY others can write lets them replace the file wholesale; the
  // file itself stays owner-only (the Everyone grant is not object-inherit).
  const openDir = fs.mkdtempSync(path.join(aclBase, 'open-'))
  execFileSync('icacls', [openDir, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`, '/grant', '*S-1-1-0:(WD)'], { stdio: 'pipe' })
  const inside = path.join(openDir, 'engine-attach.json')
  fs.writeFileSync(inside, '{}')
  const dirVerdict = await policy.verifyDescriptorTrust(inside)
  assert.equal(dirVerdict.ok, false)
  assert.match(dirVerdict.detail, /directory writable by .*S-1-1-0/)
})

test('a descriptor owned by someone else is rejected BEFORE the token is sent anywhere', async () => {
  let identityRequests = 0
  const { server, port } = await identityServer((request, response) => { identityRequests++; respond(response, 200, engineIdentity) })
  try {
    writeDescriptor(descriptor({ port }))
    const engine = trusting(new Engine())
    engine.trustCheck = async () => ({ ok: false, detail: 'owner S-1-5-21-attacker is not current user S-1-5-21-me' })
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), false)
    assert.match(engine.attachDiagnostic, /trust rejected/)
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

test('an attached update stop needs BOTH proofs: dead endpoint and host-confirmed exit', async () => {
  const descriptorPath = path.join(realRoot, 'engine-attach.json')
  const rig = async () => {
    let sawShutdown = ''
    const { server, port } = await identityServer(() => {})
    server.removeAllListeners('request')
    return await new Promise(resolve => resolve({ sawShutdown: () => sawShutdown, server, port,
      arm: onShutdown => server.on('request', (request, response) => {
        if (request.method === 'POST' && request.url === '/api/desktop/shutdown') {
          sawShutdown = request.headers['x-orgtree-desktop-token']
          respond(response, 200, { accepted: true })
          onShutdown()
          return
        }
        if (request.url === '/api/desktop/identity' && request.headers['x-orgtree-desktop-token'] === token) return respond(response, 200, engineIdentity)
        respond(response, 401, {})
      }) }))
  }

  // Success: the endpoint dies AND the host removes the descriptor (which it
  // only does after the engine process exited) — both proofs present.
  const good = await rig()
  good.arm(() => setTimeout(() => { good.server.close(); fs.rmSync(descriptorPath, { force: true }) }, 50))
  const engine = trusting(new Engine())
  writeDescriptor(descriptor({ port: good.port }))
  assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  await engine.stopAttachedForUpdate(8000)
  assert.equal(good.sawShutdown(), token, 'shutdown goes through the authenticated route')
  assert.equal(engine.status.state, 'stopped')

  // Hung host: the endpoint dies but the descriptor REMAINS — the process
  // has not confirmed exit, so the update is refused.
  const hung = await rig()
  hung.arm(() => setTimeout(() => hung.server.close(), 50))
  const engine2 = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port: hung.port }))
    assert.equal(await engine2.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    await assert.rejects(engine2.stopAttachedForUpdate(2500), /has not confirmed process exit/)
  } finally { fs.rmSync(descriptorPath, { force: true }) }

  // Stubborn engine: identity keeps answering — refused as before.
  const alive = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine3 = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port: alive.port }))
    assert.equal(await engine3.attach({ dataRoot, forbiddenRoot: forbidden }), true)
    await assert.rejects(engine3.stopAttachedForUpdate(1500), /did not stop/)
  } finally { alive.server.close(); fs.rmSync(descriptorPath, { force: true }) }

  // Busy-but-alive: the engine accepts connections and never answers within
  // the probe timeout, and the descriptor happens to be absent. A timeout
  // must NOT count as the port closing (root finding), so the update is
  // still refused rather than declared stopped over a live engine.
  const busy = await new Promise(resolve => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/desktop/shutdown') return respond(response, 200, { accepted: true })
      if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
      respond(response, 200, engineIdentity)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
  const engine4 = trusting(new Engine())
  writeDescriptor(descriptor({ port: busy.port }))
  assert.equal(await engine4.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  fs.rmSync(descriptorPath, { force: true }) // no descriptor: the timeout is the only thing between busy and 'stopped'
  busy.server.removeAllListeners('request')
  busy.server.on('request', (request, response) => {
    if (request.method === 'POST' && request.url === '/api/desktop/shutdown') return respond(response, 200, { accepted: true })
    // identity requests hang: connection accepted, no answer within 2s probe
  })
  try {
    await assert.rejects(engine4.stopAttachedForUpdate(3000), /did not stop/)
    assert.notEqual(engine4.status.state, 'stopped', 'a busy engine must never be declared stopped on a timeout')
  } finally { busy.server.closeAllConnections?.(); await new Promise(resolve => busy.server.close(resolve)) }
})

test('a lost attachment recovers by re-attaching to the republished host with its NEW token', async () => {
  const first = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port: first.port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json')) }
  await new Promise(resolve => first.server.close(resolve))
  await engine.verifyAttached()
  await engine.verifyAttached() // death needs two consecutive failed probes
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
  const engine = trusting(new Engine())
  engine.managed = false // simulate a previously attached engine that was lost
  const outcome = await engine.recoverAttached(options)
  assert.equal(outcome, 'spawned')
  assert.equal(engine.managed, true)
  assert.ok(engine.origin.startsWith('http://127.0.0.1:'), engine.origin)
  // Positive control for the disowned-exit guard: the CURRENT child's exit
  // is honored (so the guard is a filter, not a dead branch).
  engine.childExited(engine.child)
  assert.equal(engine.status.state, 'stopped', 'the current child must still be honored')
  await engine.stop()

  const broken = trusting(new Engine())
  broken.managed = false
  const failed = await broken.recoverAttached({ ...options, python: path.join(directory, 'missing.exe') })
  assert.equal(failed, 'failed')
  assert.equal(broken.managed, false, 'a failed recovery must remain recoverable next poll')
  assert.equal(broken.status.state, 'stopped')
  assert.match(broken.status.message, /Reconnecting/)
})

test('a replaceable ancestor is refused, measured with actual ACLs', async () => {
  const { execFileSync } = await import('node:child_process')
  const me = process.env.USERDOMAIN + '\\' + process.env.USERNAME
  const grand = fs.mkdtempSync(path.join(aclBase, 'grand-'))
  execFileSync('icacls', [grand, '/inheritance:r', '/grant:r', `${me}:(OI)(CI)F`, '/grant', '*S-1-1-0:(D)'], { stdio: 'pipe' })
  const mid = path.join(grand, 'mid'); fs.mkdirSync(mid)
  const leaf = path.join(mid, 'engine-attach.json'); fs.writeFileSync(leaf, '{}')
  const verdict = await policy.verifyDescriptorTrust(leaf)
  assert.equal(verdict.ok, false)
  assert.match(verdict.detail, /ancestor .*S-1-1-0/)
})

test('the update stop also demands the guardian tree release the root lock', async () => {
  // Windows paths drop straight into python raw strings; no escaping games.
  const holdScript = `import sys,time;sys.path.insert(0,r'${process.cwd()}');from pathlib import Path;from engine.process_lifetime import RootLock;l=RootLock(Path(r'${realRoot}'));print('held',flush=True);time.sleep(3);l.close();print('released',flush=True)`
  const { spawn } = await import('node:child_process')
  const holder = spawn('python', ['-c', holdScript], { stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve() })
    holder.on('exit', () => reject(new Error('lock holder died early')))
    setTimeout(() => reject(new Error('lock holder never confirmed')), 10000)
  })
  const { server, port } = await identityServer((request, response) => {
    if (request.headers['x-orgtree-desktop-token'] !== token) return respond(response, 401, {})
    respond(response, 200, engineIdentity)
  })
  const engine = trusting(new Engine())
  try {
    writeDescriptor(descriptor({ port }))
    assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  } finally { fs.rmSync(path.join(realRoot, 'engine-attach.json'), { force: true }) }
  await new Promise(resolve => server.close(resolve))
  // Endpoint dead (connection refused), descriptor gone — but the guardian
  // still holds the root: the update must be refused, naming the lock.
  await assert.rejects(engine.stopAttachedForUpdate(2000), /guardian lock still held/)
  await new Promise(resolve => holder.on('exit', resolve))
  // Tree released: the same stop now completes.
  await engine.stopAttachedForUpdate(5000)
  assert.equal(engine.status.state, 'stopped')
})
