// probe-host.test.mjs — THE PROBE HOST'S CONTRACT, AND THE TWO OTHER MAIN-THREAD MOVES THAT CARRY STATE.
// @item:orgtree/nick-pc-4-6-0-desktop-main-process-stalls-input-f (USER 2026-11-16 m8fe70e62fc2c "Full scope + guard").
//  - probe-host.ts: execFile's callback shape through a utilityProcess (here a fake child); requests made before the
//    host exists wait for it; a host that exits fails what it held (EPROBEHOST) and the next request forks a new one;
//    a hung host is bounded at timeout + 2 s; after stop every request fails at once; plain node runs in process.
//  - harnesses.ts HarnessCache: never waits, scans at most every 5 minutes, rebuilds the tray when a scan lands.
//  - preferences.ts: the live copy changes at once, the file follows asynchronously and coalesced; flushSync at quit.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-probe-host-'))
test.after(() => fs.rmSync(temp, { recursive: true, force: true }))
const load = async name => {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  return createRequire(import.meta.url)(out)
}
const host = await load('probe-host'), { HarnessCache } = await load('harnesses'), { Preferences } = await load('preferences')

/** a utilityProcess stand-in: records requests; the test answers or exits it */
function fakeChild() {
  const c = new EventEmitter()
  c.requests = []; c.killed = false
  c.postMessage = m => c.requests.push(m)
  c.kill = () => { c.killed = true; c.emit('exit', 0); return true }
  c.answer = (i, reply) => c.emit('message', { id: c.requests[i].id, ...reply })
  return c
}
const run = (file, args, options = {}) => new Promise(resolve => host.execFile(file, args, options, (error, stdout, stderr) => resolve({ error, stdout, stderr })))
const tick = () => new Promise(resolve => setImmediate(resolve))

test('a request made before the host exists waits for it, then gets execFile\'s answer shape', async t => {
  host.resetProbeHostForTests(); t.after(() => host.resetProbeHostForTests())
  const realType = process.type
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true })   // the Electron main process
  t.after(() => Object.defineProperty(process, 'type', { value: realType, configurable: true }))
  const pending = run('tasklist', ['/NH'], { timeout: 4000, windowsHide: true })
  await tick()
  const child = fakeChild(); let forks = 0
  host.configureProbeHost(() => { forks++; return child })
  assert.equal(forks, 1, 'configuring forks the host')
  assert.equal(child.requests.length, 1, 'the early request is sent')
  assert.deepEqual({ file: child.requests[0].file, args: child.requests[0].args, timeout: child.requests[0].options.timeout, op: child.requests[0].op },
    { file: 'tasklist', args: ['/NH'], timeout: 4000, op: 'exec' })
  child.answer(0, { error: { message: 'Command failed: x', code: 3, killed: false, signal: null }, stdout: 'out', stderr: 'err' })
  const { error, stdout, stderr } = await pending
  assert.equal(error.message, 'Command failed: x'); assert.equal(error.code, 3); assert.equal(error.killed, false)
  assert.equal(stdout, 'out'); assert.equal(stderr, 'err')
  const ok = run('reg', ['query', 'k'], { timeout: 4000 })
  child.answer(1, { error: null, stdout: 'fine', stderr: '' })
  assert.deepEqual(await ok, { error: null, stdout: 'fine', stderr: '' })
  assert.equal(forks, 1, 'one host serves every request')
})

test('a host that exits fails what it held, and the next request forks a new one', async t => {
  host.resetProbeHostForTests(); t.after(() => host.resetProbeHostForTests())
  const children = []
  host.configureProbeHost(() => { const c = fakeChild(); children.push(c); return c })
  const held = run('tasklist', [], { timeout: 4000 })
  await tick()
  children[0].emit('exit', 1)
  const { error } = await held
  assert.equal(error.code, 'EPROBEHOST', 'a failed request, as a failed execFile would be')
  const next = run('tasklist', [], { timeout: 4000 })
  await new Promise(resolve => setTimeout(resolve, host.REFORK_MS + 100))
  assert.equal(children.length, 2, 'a new host, at most once a second')
  children[1].answer(0, { error: null, stdout: 'again', stderr: '' })
  assert.equal((await next).stdout, 'again')
})

test('a host that never answers is bounded at the timeout plus its grace; after stop every request fails at once', async t => {
  host.resetProbeHostForTests(); t.after(() => host.resetProbeHostForTests())
  const child = fakeChild()
  host.configureProbeHost(() => child)
  const started = Date.now()
  const { error } = await run('core-control', ['status'], { timeout: 50 })
  assert.equal(error.code, 'EPROBEHOST'); assert.equal(error.killed, true)
  assert.ok(Date.now() - started >= 50 + host.HOST_GRACE_MS - 20, 'not before timeout + grace')
  host.stopProbeHost()
  assert.equal(child.killed, true, 'stop ends the host')
  assert.equal((await run('tasklist', [], { timeout: 4000 })).error.code, 'EPROBEHOST', 'a request after stop fails')
})

test('outside the Electron main process a request runs in this process (unit tests, CI tools)', async t => {
  host.resetProbeHostForTests(); t.after(() => host.resetProbeHostForTests())
  const { error, stdout } = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { timeout: 10_000, input: 'through stdin' })
  assert.equal(error, null)
  assert.equal(stdout, 'through stdin', 'input is written to stdin and stdin is closed')
  const missing = await run(path.join(temp, 'no-such-program.exe'), [], { timeout: 10_000 })
  assert.equal(missing.error.code, 'ENOENT', "node's own error codes come through")
})

test('the harness cache never waits, scans at most every 5 minutes, and rebuilds the tray when a scan lands', async () => {
  let now = 0, scans = 0, updates = 0
  let release
  const cache = new HarnessCache(() => updates++, () => { scans++; return new Promise(r => { release = r }) }, () => now)
  const first = cache.current(true)
  assert.ok(first.every(r => r.detected === false), 'before the first scan every harness reads not detected')
  assert.equal(scans, 1, 'a stale cache starts a scan')
  cache.current(true); assert.equal(scans, 1, 'never two at once')
  release([{ id: 'claude', name: 'Claude Code', url: 'u', detected: true }]); await tick(); await tick()
  assert.equal(updates, 1, 'the tray rebuilds when it lands')
  assert.equal(cache.current(true)[0].detected, true)
  now += 4 * 60_000; cache.current(true); assert.equal(scans, 1, 'fresh for 5 minutes')
  now += 60_000; cache.current(false); assert.equal(scans, 1, 'no refresh while the engine registry answers')
  cache.current(true); assert.equal(scans, 2, 'stale after 5 minutes')
})

test('a preference change is live at once; the file follows coalesced, and flushSync writes what is pending', async () => {
  const file = path.join(temp, 'prefs', 'desktop-settings.json')
  const prefs = new Preferences(file)
  assert.equal(prefs.set({ exitOnClose: true }).exitOnClose, true, 'the live copy changes at once')
  prefs.set({ startAtLogin: false }); prefs.set({ exitOnClose: false })
  await prefs.flush()
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(saved.exitOnClose, false); assert.equal(saved.startAtLogin, false, 'the latest value of every change')
  assert.throws(() => prefs.set({ exitOnClose: 'yes' }), /Invalid/, 'an invalid change still throws at once')
  prefs.set({ onboarded: true })
  prefs.flushSync()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).onboarded, true, 'the quit-time flush writes the pending change')
  await prefs.flush()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).onboarded, true, 'and no older write lands over it')
  prefs.set({ exitOnClose: true }); await prefs.flush()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).exitOnClose, true, 'a change after the flush is still written')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['desktop-settings.json'], 'no temp file is left')
})
