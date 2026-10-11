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
