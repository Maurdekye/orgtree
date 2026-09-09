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
const policy = await load('policy'), { Engine } = await load('engine')

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
