import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import {EventEmitter} from 'node:events'
import {PassThrough} from 'node:stream'
import {createRequire} from 'node:module'
import {buildSync} from 'esbuild'

const require = createRequire(import.meta.url)
const source = buildSync({entryPoints: ['apps/desktop/main/engine.ts'],
  bundle: true, platform: 'node', format: 'cjs', write: false}).outputFiles[0].text
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-refusal-order-'))
const refusal = JSON.stringify({type: 'refused', code: 'root-owned', reason: 'another engine owns this data root'}) + '\n'

// A process exit does not mean its stdout has drained. Model the real child
// event contract explicitly: exit, remaining data, end, then close.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(temp, 'root-'))
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  })
  const module = {exports: {}}
  vm.runInNewContext(source, {module, exports: module.exports,
    require: name => name === 'node:child_process' ? {...require(name), spawn: () => child} : require(name),
    process, Buffer, URL, Error, fetch, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval, console})
  const engine = new module.exports.Engine()
  let kills = 0, releaseProbes = 0
  engine.forceKillTree = async () => { kills++; child.exitCode = 1 }
  engine.awaitAttachedRelease = async () => { releaseProbes++; return {released: false} }
  engine.trustCheck = async () => ({ok: true, detail: 'synthetic identity fixture'})
  const options = {binary: process.execPath, python: '', directory: root, uiDirectory: root,
    dataRoot: root, forbiddenRoot: path.join(temp, 'forbidden'), timeoutMs: 200}
  const exit = (code = 3) => { child.exitCode = code; child.emit('exit', code, null) }
  const close = () => { child.stdout.end(); child.stderr.end(); child.emit('close', child.exitCode, null) }
  t.after(() => { child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy() })
  return {engine, child, root, options, exit, close, cleanup: () => ({kills, releaseProbes})}
}

test('exit before a complete refusal line still returns the retryable refusal', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.root, '.desktop-engine.lock'), '0')
  const started = f.engine.start(f.options)
  const outcome = started.then(() => '', e => e.message)
  f.exit()
  f.child.stdout.write(refusal)
  f.close()
  assert.match(await outcome, /^Engine start refused: /)
  assert.deepEqual(f.cleanup(), {kills: 0, releaseProbes: 0}, 'the refused child never owned the other engine tree')
})

test('exit between chunks of a refusal cannot discard its final chunk', async t => {
  const f = fixture(t)
  const outcome = f.engine.start(f.options).then(() => '', e => e.message)
  f.child.stdout.write(refusal.slice(0, 30))
  f.exit()
  f.child.stdout.write(refusal.slice(30))
  f.close()
  assert.match(await outcome, /^Engine start refused: /)
})

test('refusal before exit retains the existing retry path', async t => {
  const f = fixture(t)
  const outcome = f.engine.start(f.options).then(() => '', e => e.message)
  // The OS has exited, but its event is still queued behind readable data.
  f.child.exitCode = 3
  f.child.stdout.write(refusal)
  f.exit()
  f.close()
  assert.match(await outcome, /^Engine start refused: /)
})

test('exit-first refusal attaches to a delayed owner without another managed spawn', async t => {
  const f = fixture(t)
  const token = 'ab'.repeat(32), realRoot = fs.realpathSync.native(f.root)
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/desktop/identity')
    assert.equal(req.headers['x-orgtree-desktop-token'], token)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({protocol: 1, pid: 9876, dataRootId: realRoot}))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const outcome = f.engine.start(f.options).then(() => '', e => e.message)
  f.exit(); f.child.stdout.write(refusal); f.close()
  assert.match(await outcome, /^Engine start refused: /)
  const later = setTimeout(() => fs.writeFileSync(path.join(realRoot, 'engine-attach.json'),
    JSON.stringify({type: 'attach', protocol: 1, port: server.address().port, enginePid: 9876,
      dataRootId: realRoot, token})), 60)
  try {
    assert.equal(await f.engine.attachWithRetry(f.options, 1000, 10), true)
    assert.equal(f.engine.managed, false)
    assert.equal(f.engine.status.state, 'ready')
    assert.equal(f.engine.origin, `http://127.0.0.1:${server.address().port}`)
    f.child.emit('exit', 3, null)
    assert.equal(f.engine.status.state, 'ready', 'late loser exit cannot clobber the attachment')
  } finally { clearTimeout(later) }
})

for (const [name, text, code] of [
  ['no refusal', '', 1],
  ['unknown refusal code', '{"type":"refused","code":"unknown","reason":"x"}\n', 3],
  ['malformed refusal', '{"type":"refused","code":"root-owned","reason":7}\n', 3],
]) test(`${name} fails after stream closure and is never an attach permission`, async t => {
  const f = fixture(t)
  const outcome = f.engine.start(f.options).then(() => '', e => e.message)
  f.exit(code); f.child.stdout.write(text); f.close()
  assert.match(await outcome, /exited before readiness/)
  assert.doesNotMatch(await outcome, /^Engine start refused: /)
})

test('an exited child whose stdout never closes still has a bounded startup wait', async t => {
  const f = fixture(t)
  const outcome = f.engine.start({...f.options, timeoutMs: 40}).then(() => '', e => e.message)
  f.exit(1)
  assert.match(await outcome, /did not become ready in time|exited before readiness/)
})

test('Quit cancels a delayed-owner attachment without spawning again', async t => {
  const f = fixture(t)
  f.engine.cancelLaunches()
  assert.equal(await f.engine.attachWithRetry(f.options, 1000, 10), false)
  assert.equal(f.engine.child, undefined)
})
