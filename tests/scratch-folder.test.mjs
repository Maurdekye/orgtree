import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scratch-folder-'))
const bundle = path.join(temp, 'native.cjs')
await build({ entryPoints: ['apps/desktop/main/scratch-folder.ts'], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' })
const { openAgentScratchFolder } = createRequire(import.meta.url)(bundle)
test.after(() => fs.rm(temp, { recursive: true, force: true }))

test('production IPC registration restricts folder opening to the caller organization', async () => {
  const source = await fs.readFile('apps/desktop/main/index.ts', 'utf8')
  const start = source.indexOf("    handle('desktop:open-agent-scratch-folder'")
  assert.ok(start >= 0)
  const end = source.indexOf("    handleApp('desktop:open-charter-folder'", start)
  assert.ok(end > start)
  const calls = []
  const engine = { origin: 'http://127.0.0.1:1234', token: 'fixture' }
  let callback
  const options = { dataRoot: temp }
  const register = new Function('handle', 'engineRestartOptions', 'windows', 'engine', 'shell', 'openAgentScratchFolder', source.slice(start, end))
  register((channel, fn) => { assert.equal(channel, 'desktop:open-agent-scratch-folder'); callback = fn },
    options, { identity: id => id === 'mine-window' ? { org: 'mine' } : { kind: 'homepage' } }, engine,
    { openPath: async directory => { calls.push(['shell', directory]); return '' } },
    async (current, org, node, opener, scope) => {
      calls.push(scope ? [current, org, node, scope] : [current, org, node])
      await opener(temp); return { ok: true }
    })
  assert.equal(callback({ id: 'mine-window' }, 'other', 'alice').ok, false)
  assert.equal(callback({ id: 'home-window' }, 'mine', 'alice').ok, false)
  assert.deepEqual(calls, [])
  assert.deepEqual(await callback({ id: 'mine-window' }, 'mine', 'alice'), { ok: true })
  assert.deepEqual(calls, [[engine, 'mine', 'alice'], ['shell', temp]])
  assert.deepEqual(await callback({ id: 'mine-window' }, 'mine', 'alice', 'team'), { ok: true })
  assert.deepEqual(await callback({ id: 'mine-window' }, 'mine', '', 'shared'), { ok: true })
  assert.deepEqual(calls.slice(2), [[engine, 'mine', 'alice', 'team'], ['shell', temp],
    [engine, 'mine', '', 'shared'], ['shell', temp]])
  assert.equal(callback({ id: 'mine-window' }, 'other', '', 'shared').ok, false)
  options.dataRoot = ''
  assert.equal(callback({ id: 'mine-window' }, 'mine', 'alice').ok, false)
  assert.equal(calls.length, 6)
})

test('identity lookup authenticates, opens only an existing directory, and reports native errors', async () => {
  const directory = path.join(temp, 'stored folder & literal $name')
  await fs.mkdir(directory)
  const file = path.join(temp, 'program.exe')
  await fs.writeFile(file, 'not executable')
  const opened = [], requests = []
  let body = { path: directory }, status = 200
  const server = createServer((req, res) => {
    requests.push([req.url, req.headers['x-orgtree-desktop-token']])
    res.writeHead(status, status === 302 ? { Location: '/should-never-follow' } : { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const engine = { origin: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token' }
  const open = async dir => { opened.push(dir); return '' }
  const call = () => openAgentScratchFolder(engine, 'mine', 'renamed & name', open)
  try {
    assert.deepEqual(await call(), { ok: true })
    assert.deepEqual(opened, [await fs.realpath(directory)])
    assert.deepEqual(requests[0], ['/api/orgs/mine/nodes/renamed%20%26%20name/scratch-folder', 'fixture-token'])
    for (const bad of [file, path.join(temp, 'missing'), 'relative', '', null, 123]) {
      body = { path: bad }
      assert.equal((await call()).ok, false, String(bad))
    }
    assert.equal(opened.length, 1)
    assert.equal(await fs.stat(path.join(temp, 'missing')).then(() => true, () => false), false)
    body = { path: directory }
    assert.deepEqual(await openAgentScratchFolder(engine, 'mine', 'agent', async () => 'OS refused'), { ok: false, error: 'OS refused' })
    assert.equal((await openAgentScratchFolder(engine, 'mine', 'agent', async () => { throw new Error('shell failed') })).error, 'shell failed')
    status = 404; assert.equal((await call()).ok, false)
    status = 302
    const before = requests.length
    assert.equal((await call()).ok, false)
    assert.equal(requests.length, before + 1, 'redirect is never followed')
    const count = requests.length
    assert.equal((await openAgentScratchFolder({ ...engine, origin: 'https://remote.example' }, 'mine', 'agent', open)).ok, false)
    assert.equal((await openAgentScratchFolder(engine, 'mine', '..', open)).ok, false)
    assert.equal(requests.length, count)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('team and shared scope use the existing authenticated resolver and native opener', async () => {
  const directory = path.join(temp, 'engine resolved shared directory')
  await fs.mkdir(directory)
  const requests = [], opened = []
  let echoScope = true
  const server = createServer((req, res) => {
    requests.push([req.url, req.headers['x-orgtree-desktop-token']])
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const scope = new URL(req.url, 'http://127.0.0.1').searchParams.get('scope')
    res.end(JSON.stringify({ path: directory, ...(echoScope ? { scope } : {}) }))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const engine = { origin: `http://127.0.0.1:${server.address().port}`, token: 'scoped-fixture-token' }
  const open = async dir => { opened.push(dir); return '' }
  try {
    assert.deepEqual(await openAgentScratchFolder(engine, 'mine', 'leaf', open, 'team'), { ok: true })
    assert.deepEqual(requests[0], ['/api/orgs/mine/nodes/leaf/scratch-folder?scope=team', 'scoped-fixture-token'])
    assert.deepEqual(await openAgentScratchFolder(engine, 'mine', '', open, 'shared'), { ok: true })
    assert.deepEqual(requests[1], ['/api/orgs/mine/nodes/_shared/scratch-folder?scope=shared', 'scoped-fixture-token'])
    assert.deepEqual(opened, [await fs.realpath(directory), await fs.realpath(directory)])
    echoScope = false
    assert.equal((await openAgentScratchFolder(engine, 'mine', 'leaf', open, 'team')).ok, false,
      'an old engine ignoring scope must not open the personal directory')
    assert.equal(opened.length, 2)
    const count = requests.length
    for (const scope of ['../shared', null, {}, 1]) {
      assert.equal((await openAgentScratchFolder(engine, 'mine', 'leaf', open, scope)).ok, false)
    }
    assert.equal((await openAgentScratchFolder(engine, 'mine', 'leaf', open, 'shared')).ok, false,
      'org-scoped request cannot carry a conflicting agent identity')
    assert.equal((await openAgentScratchFolder(engine, 'mine', '', open, 'team')).ok, false)
    assert.equal((await openAgentScratchFolder({ ...engine, origin: 'http://remote.example' }, 'mine', '', open, 'shared')).ok, false)
    assert.equal(requests.length, count, 'invalid scope/identity/remote calls never reach the engine')
  } finally { await new Promise(resolve => server.close(resolve)) }
})
