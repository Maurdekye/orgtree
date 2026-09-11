// What an intentional "Quit Orgtree" must leave behind: nothing.
//
// Measured on the operator's machine 2026-09-11. The desktop was ATTACHED to
// the boot host's engine, `Engine.stop()` begins `if (!this.managed) return`,
// and the tray-menu Quit runs nothing else — so the quit left the boot host,
// its engine, its guardian and every provider child running, and only a PC
// reboot ended them. The same early return also made an acknowledged
// maintenance RESTART restart the window alone.
//
// `stop()` KEEPS that refusal (a window closing is not a reason to end a
// headless engine) and the first test here is its control; `stopForQuit` is
// the path a real quit takes.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-quit-test-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const out = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: out, bundle: true, platform: 'node', format: 'cjs' })
  return req(out)
}
const { Engine, QUIT_DEADLINES, QUIT_STOP_BUDGET_MS } = await load('engine')

const forbidden = path.join(temp, 'v1'); fs.mkdirSync(forbidden)
const dataRoot = path.join(temp, 'v2'); fs.mkdirSync(dataRoot)
const realRoot = fs.realpathSync.native(dataRoot)
const token = 'ab'.repeat(32)
const enginePid = 4242
const descriptorPath = path.join(realRoot, 'engine-attach.json')
const lockPath = path.join(realRoot, '.desktop-engine.lock')
// The guardian's lock FILE survives release; only its byte-range lock drops.
fs.writeFileSync(lockPath, '0')
const engineIdentity = { protocol: 1, pid: enginePid, dataRootId: realRoot }
const descriptor = (extra = {}) => ({ type: 'attach', protocol: 1, port: 1, enginePid, hostPid: 1, dataRootId: realRoot, token, startedAt: 'x', ...extra })
const writeDescriptor = value => fs.writeFileSync(descriptorPath, JSON.stringify(value))
const dropDescriptor = () => fs.rmSync(descriptorPath, { force: true })
// %TEMP% carries inherited write ACEs for other local accounts on this
// machine, so the REAL descriptor trust check would rightly refuse these
// fixtures; it has its own dedicated controls in attach.test.mjs.
const trusting = engine => { engine.trustCheck = async () => ({ ok: true, detail: 'test stub' }); return engine }
const respond = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }

/** A stand-in boot engine: answers identity, and runs `onShutdown` when the
 *  authenticated shutdown route is called. */
const rigs = []
function standInEngine(onShutdown = () => {}) {
  const seen = { shutdownToken: '' }
  return new Promise(resolve => {
    const server = http.createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/api/desktop/shutdown') {
        seen.shutdownToken = request.headers['x-orgtree-desktop-token']
        respond(response, 200, { accepted: true })
        onShutdown()
        return
      }
      if (request.url === '/api/desktop/identity' && request.headers['x-orgtree-desktop-token'] === token) return respond(response, 200, engineIdentity)
      respond(response, 401, {})
    })
    rigs.push(server)
    // An open server (or a held lock) left by a FAILING leg keeps the test
    // runner alive for ever, and an inconclusive hang is the one result this
    // suite must never produce — it is about processes outliving their owner.
    server.unref()
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port,
      kill: () => { server.closeAllConnections?.(); server.close() } }))
  })
}

async function attached(port) {
  const engine = trusting(new Engine())
  writeDescriptor(descriptor({ port }))
  assert.equal(await engine.attach({ dataRoot, forbiddenRoot: forbidden }), true)
  return engine
}

/** Hold the guardian's real byte-range root lock from another process, so
 *  "the tree has not released this root" is a fact and not a fixture flag.
 *  Tracked and swept at the end: a holder left behind by a FAILING leg would
 *  otherwise keep the test runner alive for its whole sleep, which reads as a
 *  hung suite instead of the failure it is. */
const holders = []
async function holdRootLock() {
  const script = `import sys,time;sys.path.insert(0,r'${process.cwd()}');from pathlib import Path;from engine.process_lifetime import RootLock;l=RootLock(Path(r'${realRoot}'));print('held',flush=True);time.sleep(120);l.close()`
  const holder = spawn('python', ['-c', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  holders.push(holder)
  holder.unref()
  await new Promise((resolve, reject) => {
    holder.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve() })
    holder.on('exit', () => reject(new Error('lock holder died early')))
    setTimeout(() => reject(new Error('lock holder never confirmed')), 15000)
  })
  // Idempotent: a leg whose own stub already released the lock must be able
  // to call this again in its `finally` without waiting for an exit that has
  // already happened — that wait never resolves, and the runner hangs.
  return { release: () => new Promise(resolve => {
    if (holder.exitCode !== null || holder.signalCode !== null) return resolve()
    holder.once('exit', resolve)
    holder.kill()
  }) }
}

test('stop() still refuses an attached engine, and a QUIT stops the same one', async () => {
  const rig = await standInEngine()
  const engine = await attached(rig.port)
  try {
    // The control, and the behaviour that must not change: an ordinary
    // window teardown leaves a boot engine alone.
    await engine.stop()
    const alive = await fetch(`http://127.0.0.1:${rig.port}/api/desktop/identity`, { headers: { 'x-orgtree-desktop-token': token } })
    assert.equal(alive.status, 200, 'stop() must remain a no-op for an attached engine')
    assert.equal(engine.status.state, 'ready')

    // The quit: the engine goes away, exactly as the boot host's own exit
    // would take it (endpoint dead, descriptor removed, lock released).
    rig.server.removeAllListeners('request')
    rig.server.on('request', (request, response) => {
      if (request.method === 'POST' && request.url === '/api/desktop/shutdown') {
        rig.seen.shutdownToken = request.headers['x-orgtree-desktop-token']
        respond(response, 200, { accepted: true })
        setTimeout(() => { rig.kill(); dropDescriptor() }, 50)
        return
      }
      if (request.url === '/api/desktop/identity' && request.headers['x-orgtree-desktop-token'] === token) return respond(response, 200, engineIdentity)
      respond(response, 401, {})
    })
    assert.equal(await engine.stopForQuit(), 'stopped')
    assert.equal(rig.seen.shutdownToken, token, 'the quit goes through the authenticated route')
    assert.equal(engine.status.state, 'stopped')
  } finally { rig.kill(); dropDescriptor() }
})

test('a quit that gets no graceful stop terminates the tree it authenticated', async () => {
  const rig = await standInEngine()            // ignores shutdown entirely
  const lock = await holdRootLock()
  const engine = await attached(rig.port)
  const killed = []
  engine.forceKillTree = async pid => {
    killed.push(pid)
    rig.kill(); dropDescriptor(); await lock.release()
  }
  assert.equal(await engine.stopForQuit(4000), 'forced')
  assert.deepEqual(killed, [enginePid], 'the PID terminated is the one the descriptor names')
  assert.equal(engine.status.state, 'stopped')
})

test('a forced kill that does not release the root is reported, never claimed', async () => {
  const rig = await standInEngine()
  const lock = await holdRootLock()
  const engine = await attached(rig.port)
  const killed = []
  engine.forceKillTree = async pid => { killed.push(pid) }   // the kill does not land
  try {
    assert.equal(await engine.stopForQuit(1500), 'unverified')
    assert.deepEqual(killed, [enginePid], 'positive control: the force really was attempted')
    assert.notEqual(engine.status.state, 'stopped', 'a quit must never claim a stop it cannot see')
  } finally { rig.kill(); dropDescriptor(); await lock.release() }
})

test('the force is refused when the root has moved on: newer descriptor, or released lock', async () => {
  // (1) A NEWER host republished: the PID recorded here is not its engine,
  //     and by now may not be anyone's.
  const replaced = await standInEngine()
  const lock = await holdRootLock()
  const engine = await attached(replaced.port)
  const killed = []
  engine.forceKillTree = async pid => { killed.push(pid) }
  writeDescriptor(descriptor({ port: replaced.port, enginePid: enginePid + 1, hostPid: 9 }))
  try {
    assert.equal(await engine.stopForQuit(1500), 'unverified')
    assert.deepEqual(killed, [], 'a replaced descriptor must never be killed by PID')
  } finally { replaced.kill(); dropDescriptor(); await lock.release() }

  // (2) The guardian's lock is free, so the tree has already released this
  //     root — there is nothing left to terminate.
  const free = await standInEngine()
  const engine2 = await attached(free.port)
  const killed2 = []
  engine2.forceKillTree = async pid => { killed2.push(pid) }
  try {
    assert.equal(engine2.guardianReleased(lockPath), true, 'positive control: the lock really is free')
    assert.equal(await engine2.stopForQuit(1500), 'unverified')
    assert.deepEqual(killed2, [], 'a released root has no tree to kill')
  } finally { free.kill(); dropDescriptor() }
})

// ---------------------------------------------------------- managed engine
// A real child process, spawned exactly as the desktop spawns one: the
// stand-in "launch.py" is JavaScript and the "python" is this node binary
// (the same trick attach.test.mjs uses for the recovery spawn).
const stubDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-quit-stub-'))
fs.writeFileSync(path.join(stubDirectory, 'launch.py'), `
  const http = require('node:http')
  const srv = http.createServer((request, response) => { response.statusCode = 404; response.end() })
  srv.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ type: 'ready', protocol: 1, port: srv.address().port, pid: process.pid, dataRootId: process.env.ORGTREE_DATA }))
  })
  setInterval(() => {}, 1000)   // never leaves on its own
`)
const managedOptions = { directory: stubDirectory, python: process.execPath, dataRoot, forbiddenRoot: forbidden, uiDirectory: stubDirectory }
const running = pid => { try { process.kill(pid, 0); return true } catch { return false } }
// Every stub child this file starts, so a leg that FAILS to stop one cannot
// hold the test runner open on its stdio for ever — a hang reads as an
// inconclusive suite, and the whole subject here is processes outliving the
// thing that started them.
const spawned = []
const startManaged = async () => {
  const engine = trusting(new Engine())
  await engine.start(managedOptions)
  spawned.push(engine.child.pid)
  return engine
}
const goneWithin = async (pid, ms) => { const until = Date.now() + ms; while (Date.now() < until) { if (!running(pid)) return true; await new Promise(r => setTimeout(r, 50)) } return !running(pid) }

test('a quit ends the managed child it spawned, and confirms the exit', async () => {
  const engine = await startManaged()
  const pid = engine.child.pid
  assert.equal(running(pid), true, 'positive control: the child really is running')
  // The budget production passes: stop() alone can spend 8 s of it before
  // the confirmation is even asked for.
  assert.equal(await engine.stopForQuit(), 'stopped')
  assert.equal(await goneWithin(pid, 5000), true, 'the managed engine process must be gone')
})

test('a managed child the graceful stop leaves alive is terminated for real', async () => {
  const engine = await startManaged()
  const pid = engine.child.pid
  engine.stop = async () => {}          // the graceful half does nothing at all
  assert.equal(await engine.stopForQuit(), 'forced')
  assert.equal(await goneWithin(pid, 5000), true, 'the real taskkill must have landed')
})

test('the quit budget is the sum of the phases a quit can actually spend', () => {
  const { managedStopMs, requestMs, releaseMs, killMs, provenMs } = QUIT_DEADLINES
  // The worst case of either path — managed (stop → confirm → kill → confirm)
  // or attached (request → release → kill → proof).
  assert.equal(QUIT_STOP_BUDGET_MS, Math.max(managedStopMs, requestMs) + releaseMs + killMs + provenMs)
  assert.ok(QUIT_STOP_BUDGET_MS >= managedStopMs + releaseMs + killMs + provenMs, 'the managed path must fit')
  assert.ok(QUIT_STOP_BUDGET_MS >= requestMs + releaseMs + killMs + provenMs, 'the attached path must fit')
  assert.ok(killMs > 0 && provenMs > 0, 'the force must be given a share at all')
})

test('a budget too small for everything still forces, PROVES it, and is honoured', async () => {
  // The graceful half must never eat the whole budget: by the time the force
  // matters, asking nicely has already failed. 6 s cannot cover the request,
  // the release, the termination AND its proof at full size, so every wait is
  // clamped — and the quit must still come out the far end with a stop it can
  // see, inside the budget it was given.
  const stubborn = await standInEngine()       // answers identity for ever
  const lock = await holdRootLock()
  const engine = await attached(stubborn.port)
  const killed = []
  engine.forceKillTree = async pid => { killed.push(pid); stubborn.kill(); dropDescriptor(); await lock.release() }
  const started = Date.now()
  try {
    assert.equal(await engine.stopForQuit(6000), 'forced')
    const elapsed = Date.now() - started
    assert.deepEqual(killed, [enginePid], 'a short budget must still reach the force')
    assert.ok(elapsed <= 6000 + 1500, `the quit must honour its budget (took ${elapsed}ms)`)
  } finally { stubborn.kill(); dropDescriptor(); await lock.release() }
})

// ------------------------------------------------------------- the wiring
// The before-quit handler cannot be exercised without a real Electron app, so
// what it CALLS is asserted against the source, the way updater-wiring.test.mjs
// asserts the update path's. The behaviour behind it is checked for real by
// tests/quit_engine_probe.mjs, which drives this same Engine at a real boot
// host, a real guardian and a real job object.
test('a quit is wired to stopForQuit, and the update path keeps its own stop', () => {
  const main = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  const handler = main.slice(main.indexOf("app.on('before-quit'"))
  assert.ok(handler.startsWith("app.on('before-quit'"), 'the before-quit handler must exist')
  assert.match(handler.slice(0, 2000), /bounded\(engine\.stopForQuit\(QUIT_STOP_BUDGET_MS\), QUIT_ENGINE_TOTAL_MS\)/,
    'the quit must stop the engine through the quit path')
  // The outer bound is DERIVED from the phases, never typed out again: a
  // bound shorter than its path is what makes `bounded` the thing that ends
  // the quit, with a termination still in flight and its proof never read.
  assert.match(main, /const QUIT_ENGINE_TOTAL_MS = QUIT_STOP_BUDGET_MS \+ UPDATE_DEADLINES\.marginMs/)
  // An installer hands off through prepareAndHandOff, which proves an
  // ATTACHED engine stopped BEFORE any file is replaced and REFUSES when it
  // cannot. That stop is not the quit's and must not become it.
  assert.match(main, /if \(!engine\.managed\) \{ await engine\.stopAttachedForUpdate\(\)/)
  assert.match(main, /stopEngine: \(\) => engine\.stop\(\)/)
})

test.after(() => {
  for (const holder of holders) { try { holder.kill() } catch { /* already gone */ } }
  for (const pid of spawned) { if (running(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } } }
  for (const server of rigs) { try { server.closeAllConnections?.(); server.close() } catch { /* already closed */ } }
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* %TEMP% sweeps it */ }
  try { fs.rmSync(stubDirectory, { recursive: true, force: true }) } catch { /* %TEMP% sweeps it */ }
})
