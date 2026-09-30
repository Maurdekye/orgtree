// engine-liveness.test.mjs — hung-engine recovery for an engine the DESKTOP
// started (item v3-hung-engine-recovery-also-for-an-engine-the-d).
//
// The boot host (engine/service_host.py) ends and replaces a hung engine it
// started. An engine the desktop started itself had no such watch: a hung one
// kept the root lock forever. engine.ts now watches its own managed child by
// the SAME rules. Like engine-restart.test.mjs, every process here is a
// SANDBOXED FIXTURE with its own temp data root; nothing reads ORGTREE_DATA.
//
//   THE RULES      the numbers match service_host.py, and the watch applies them
//   THE DECISION   Engine.checkLiveness against injected doubles
//   THE REAL THING a sandbox engine that stops answering is ended and replaced
//
// Run: node --test tests/engine-liveness.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const repo = path.resolve(import.meta.dirname, '..')
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-engine-liveness-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const file = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'cjs' })
  return req(file)
}
const { Engine, LIVENESS, LIVENESS_LOG, LivenessWatch } = await load('engine')

// ------------------------------------------------------------- the rules

test('the desktop judges a hang by the SAME numbers as the boot host', () => {
  const source = fs.readFileSync(path.join(repo, 'engine/service_host.py'), 'utf8')
  const value = name => {
    const match = source.match(new RegExp(`^${name} = ([0-9.]+)`, 'm'))
    assert.ok(match, `${name} is defined in service_host.py`)
    return Number(match[1])
  }
  assert.equal(LIVENESS.intervalMs, value('LIVENESS_INTERVAL') * 1000)
  assert.equal(LIVENESS.probeTimeoutMs, value('LIVENESS_PROBE_TIMEOUT') * 1000)
  assert.equal(LIVENESS.deadlineMs, value('LIVENESS_DEADLINE') * 1000)
  assert.equal(LIVENESS.minFailures, value('LIVENESS_MIN_FAILURES'))
  assert.equal(LIVENESS.restartLimit, value('HUNG_RESTART_LIMIT'))
  assert.equal(LIVENESS.restartWindowMs, value('HUNG_RESTART_WINDOW') * 1000)
  const log = source.match(/^LIVENESS_LOG = Path\("(\w+)"\) \/ "([\w.-]+)"/m)
  assert.ok(log)
  assert.equal(LIVENESS_LOG, path.join(log[1], log[2]), 'both watchers write the same file')
})

function clocked() {
  const clock = { now: 1_000_000 }
  return { clock, watch: new LivenessWatch(() => clock.now) }
}

test('hung needs BOTH five minutes of silence AND three failed probes', () => {
  const { clock, watch } = clocked()
  watch.record(null)
  for (let i = 0; i < 3; i++) watch.record('timeout')
  clock.now += 299_000
  assert.equal(watch.hung(), false, 'three failures inside the deadline are contention')
  clock.now += 1_000
  assert.equal(watch.hung(), true)
  assert.equal(watch.lastError, 'timeout')
})

test('a long silence with too few failed probes is not hung', () => {
  const { clock, watch } = clocked()
  watch.record('timeout'); watch.record('timeout')
  clock.now += 10_000_000
  assert.equal(watch.hung(), false)
})

test('one answer resets the watch, and the silence counts from that answer', () => {
  const { clock, watch } = clocked()
  for (let i = 0; i < 3; i++) watch.record('timeout')
  clock.now += 400_000
  assert.equal(watch.hung(), true)
  watch.record(null)
  assert.deepEqual([watch.failures, watch.lastError, watch.hung()], [0, null, false])
  for (let i = 0; i < 3; i++) watch.record('timeout')
  clock.now += 299_000
  assert.equal(watch.hung(), false, 'an engine that answered 299 s ago is not hung')
  assert.equal(watch.silentMs(), 299_000)
  clock.now += 1_000
  assert.equal(watch.hung(), true)
})

// ---------------------------------------------------------- the decision

const fakeChild = (pid = 4242) => ({ pid, exitCode: null, signalCode: null })
const OPTIONS = { python: 'py', directory: 'dir', dataRoot: 'root', forbiddenRoot: 'v1', uiDirectory: 'ui' }

/** An Engine whose managed child is `child`, with every phase that would
 *  touch a process replaced by a recorder. Its watch is already HUNG. */
function hungEngine({ released = true, stopped = true, root = fs.mkdtempSync(path.join(temp, 'root-')) } = {}) {
  const engine = new Engine()
  const child = fakeChild()
  const calls = { kill: [], start: 0 }
  engine.child = child
  engine.lastOptions = OPTIONS
  engine.forceKillTree = async pid => { calls.kill.push(pid); child.exitCode = 1 }
  engine.stoppedConfirmed = async () => stopped
  engine.rootReleased = async () => released
  engine.start = async () => { calls.start++; const next = fakeChild(calls.start + 5000); engine.child = next; arm(engine, next) }
  engine.probeAlive = async () => 'TimeoutError: the operation was aborted'
  const arm = (target, armed) => {
    const clock = { now: 0 }
    const watch = new LivenessWatch(() => clock.now)
    for (let i = 0; i < 3; i++) watch.record('timeout')
    clock.now = LIVENESS.deadlineMs
    target.liveness = { child: armed, timer: setInterval(() => {}, 1e9), watch }
    return watch
  }
  const watch = arm(engine, child)
  const events = () => {
    const file = path.join(root, LIVENESS_LOG)
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
  }
  const tick = async () => {
    const { child: current, watch: currentWatch } = engine.liveness ?? { child: engine.child, watch }
    await engine.checkLiveness(current, root, currentWatch)
  }
  return { engine, child, calls, root, events, tick, cleanup: () => engine.stopLiveness() }
}

test('a hung managed engine is recorded, killed, proven released, and replaced', async () => {
  const h = hungEngine()
  try {
    await h.tick()
    assert.deepEqual(h.calls.kill, [4242], 'the hung tree was killed')
    assert.equal(h.calls.start, 1, 'and exactly one fresh engine was started')
    const events = h.events()
    assert.deepEqual(events.map(e => e.event), ['hung', 'killed'])
    assert.equal(events[0].enginePid, 4242)
    assert.equal(events[0].failedProbes, 4, 'the three before this tick, and the tick\'s own')
    assert.match(events[0].lastError, /TimeoutError/)
    assert.equal(events[0].watcher, 'desktop', 'the log says which watcher acted')
    assert.equal(events[1].released, true)
    assert.equal(h.engine.restartInProgress, false, 'the restart slot is given back')
  } finally { h.cleanup() }
})

test('a release that cannot be proven starts NOTHING: never two engines on one root', async () => {
  for (const [released, stopped] of [[false, true], [true, false]]) {
    const h = hungEngine({ released, stopped })
    try {
      await h.tick()
      assert.deepEqual(h.calls.kill, [4242])
      assert.equal(h.calls.start, 0, `released=${released} stopped=${stopped}`)
      assert.equal(h.events().at(-1).released, false)
      assert.equal(h.engine.status.state, 'unavailable')
      assert.match(h.engine.status.message, /will not start a second engine/)
    } finally { h.cleanup() }
  }
})

test('at most three hung engines are replaced within an hour; the fourth is not', async () => {
  const h = hungEngine()
  try {
    for (let i = 0; i < 4; i++) await h.tick()
    assert.equal(h.calls.kill.length, 4, 'every hung engine is ended')
    assert.equal(h.calls.start, 3, 'but only three are replaced')
    assert.equal(h.events().at(-1).event, 'not-restarted')
    assert.equal(h.engine.status.state, 'unavailable')
    assert.match(h.engine.status.message, /4 times within an hour/)
  } finally { h.cleanup() }
})

test('hangs older than an hour no longer count toward the limit', async () => {
  const h = hungEngine()
  try {
    h.engine.hangs = [Date.now() - LIVENESS.restartWindowMs - 1, Date.now() - LIVENESS.restartWindowMs - 1, Date.now() - LIVENESS.restartWindowMs - 1]
    await h.tick()
    assert.equal(h.calls.start, 1)
  } finally { h.cleanup() }
})

test('an ATTACHED engine is never probed, killed or replaced by the desktop', async () => {
  // It belongs to the boot host, whose own watch acts on it: one watcher per engine.
  const h = hungEngine()
  try {
    h.engine.managed = false
    await h.tick()
    assert.deepEqual([h.calls.kill, h.calls.start, h.events()], [[], 0, []])
  } finally { h.cleanup() }
})

test('an attached engine never gets a watch in the first place', () => {
  const engine = new Engine()
  engine.managed = false
  engine.watchLiveness(fakeChild(), temp)
  assert.equal(engine.liveness, undefined)
})

test('nothing is ended while the app is quitting or installing, or while a restart is already running', async () => {
  const blocked = hungEngine()
  const busy = hungEngine()
  try {
    blocked.engine.hungRestartAllowed = () => false
    await blocked.tick()
    assert.deepEqual([blocked.calls.kill, blocked.calls.start], [[], 0])
    busy.engine.restarting = new Promise(() => {})
    await busy.tick()
    assert.deepEqual([busy.calls.kill, busy.calls.start], [[], 0], 'a hang never starts a second restart beside the tray one')
  } finally { blocked.cleanup(); busy.cleanup() }
})

test('a deliberate stop disarms the watch', async () => {
  const h = hungEngine()
  h.engine.stop = Object.getPrototypeOf(h.engine).stop
  h.child.exitCode = 0
  await h.engine.stop()
  assert.equal(h.engine.liveness, undefined)
  await h.engine.checkLiveness(h.child, h.root, new LivenessWatch())
  assert.deepEqual([h.calls.kill, h.calls.start], [[], 0])
})

test('the probe accepts only the engine itself: another pid or root is a failure', async () => {
  const http = await import('node:http')
  const root = fs.mkdtempSync(path.join(temp, 'probe-'))
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/desktop/alive') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ protocol: 1, pid: 42, dataRootId: root }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const engine = new Engine()
    engine.endpoint = `http://127.0.0.1:${server.address().port}`
    assert.equal(await engine.probeAlive(42, root), null)
    assert.match(await engine.probeAlive(43, root), /another identity/)
    assert.match(await engine.probeAlive(42, path.join(root, 'x')), /another identity/)
  } finally { server.close() }
})

// -------------------------------------------------------- the real thing

let python = ''
if (process.platform === 'win32') python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
const windowsOnly = process.platform !== 'win32' ? 'INERT: the real guardian requires Windows' : false

/** A sandbox engine that answers its liveness route `answers` times and then
 *  hangs: its one server thread sleeps inside the handler, so every later
 *  request waits forever while the process and its root lock live on. */
function fixture(answers) {
  const directory = fs.mkdtempSync(path.join(temp, 'fixture-'))
  const dataRoot = path.join(directory, 'data')
  fs.mkdirSync(dataRoot)
  const source = `import os,sys,time,json,threading
from pathlib import Path
sys.path.insert(0,${JSON.stringify(repo)})
from engine.process_lifetime import arm_process_lifetime
from engine.startup_progress import StartupProgress
from http.server import BaseHTTPRequestHandler,HTTPServer
root=Path(os.environ['ORGTREE_DATA'])
progress=StartupProgress(root)
guardian=arm_process_lifetime(root,parent_pid=int(os.environ['ORGTREE_V2_PARENT_PID']))
progress.report('lifetime-owned')
with open(root/'launches.log','a') as f: f.write('%d\\n'%os.getpid())
served=[0]
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        served[0]+=1
        if served[0]>${answers}: time.sleep(3600)
        body=json.dumps(dict(protocol=1,pid=os.getpid(),dataRootId=str(root))).encode()
        self.send_response(200); self.send_header('content-type','application/json'); self.send_header('content-length',str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self,*a): pass
server=HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps(dict(type='ready',protocol=1,pid=os.getpid(),dataRootId=str(root),port=server.server_address[1],guardianPid=guardian)),flush=True)
time.sleep(120)
`
  fs.writeFileSync(path.join(directory, 'launch.py'), source)
  return { python, directory, dataRoot, forbiddenRoot: path.join(directory, 'v1'), uiDirectory: directory, timeoutMs: 20000 }
}

const alive = pid => execFileSync(python, ['-c',
  `import ctypes;h=ctypes.windll.kernel32.OpenProcess(0x100000,False,${pid});print('alive' if h and ctypes.windll.kernel32.WaitForSingleObject(h,0)==258 else 'gone')`],
  { encoding: 'utf8' }).trim() === 'alive'

test('a REAL managed engine that stops answering is ended and replaced by a live one', { skip: windowsOnly, timeout: 90000 }, async () => {
  const engine = new Engine(), options = fixture(2)
  engine.livenessRules = { ...LIVENESS, intervalMs: 150, probeTimeoutMs: 400, deadlineMs: 1500, minFailures: 2 }
  const launches = () => fs.readFileSync(path.join(options.dataRoot, 'launches.log'), 'utf8').trim().split('\n').map(Number)
  const seen = []
  engine.on('status', status => seen.push(status.state))
  try {
    await engine.start(options)
    const [first] = launches()
    assert.ok(engine.liveness, 'a ready managed engine is watched')
    const deadline = Date.now() + 60000
    while (launches().length < 2 || engine.status.state !== 'ready') {
      assert.ok(Date.now() < deadline, `no replacement engine within 60 s (states ${seen.join(',')})`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const [, second] = launches()
    assert.notEqual(second, first)
    assert.equal(alive(first), false, 'the hung engine is gone')
    assert.equal(alive(second), true, 'and its replacement is running')
    const events = fs.readFileSync(path.join(options.dataRoot, LIVENESS_LOG), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(events.map(e => [e.event, e.enginePid]), [['hung', first], ['killed', first]])
    assert.equal(events[1].released, true, 'the root was proven released before the second engine started')
    assert.ok(events[0].failedProbes >= 2)
    assert.ok(seen.includes('stopped') && seen.at(-1) === 'ready')
  } finally {
    engine.stopLiveness()
    const child = engine.child
    if (child?.pid && child.exitCode === null && child.signalCode === null) await engine.forceKillTree(child.pid)
    await engine.awaitAttachedRelease('', '', path.join(options.dataRoot, '.desktop-engine.lock'), 5000)
  }
})

// --------------------------------------------------------------- wiring

test('the app stops hang recovery whenever a restart is blocked (quit, update, installer)', () => {
  const index = fs.readFileSync(path.join(repo, 'apps/desktop/main/index.ts'), 'utf8')
  assert.match(index, /engine\.hungRestartAllowed = \(\) => !engineRestartBlocked\(\)/)
})
