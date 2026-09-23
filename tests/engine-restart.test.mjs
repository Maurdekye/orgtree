// engine-restart.test.mjs — the tray's "Restart engine" entry, end to end,
// WITHOUT EVER RESTARTING THE ENGINE THIS MACHINE IS RUNNING.
//
// That constraint is the whole shape of this file. A real restart here would
// kill the agents running under the live engine, so every process this file
// starts is a SANDBOXED FIXTURE: a throwaway launch.py in a temp directory,
// with its own data root, its own guardian and its own port — the same rig
// startup-engine.test.mjs already uses. Nothing here reads ORGTREE_DATA, and
// nothing here can reach the installed application's root.
//
// Three layers, because they fail for different reasons:
//   THE ROW        trayEngineState/refreshTrayEngineMenu — what the menu shows.
//   THE DECISION   Engine.restart against injected doubles — the refusals, the
//                  concurrency guard, and what is NEVER reached when a phase
//                  cannot be proven.
//   THE REAL THING Engine.restart against a live sandbox engine — a genuine
//                  stop, a genuine spawn, and the proof that the first process
//                  was dead before the second existed.
//
// Run: node --test tests/engine-restart.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-engine-restart-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const file = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'cjs' })
  return req(file)
}
const { Engine, trayEngineState, refreshTrayEngineMenu } = await load('engine')

const READY = { state: 'ready' }
const STARTING = { state: 'starting' }
const STOPPED = { state: 'stopped', message: 'Engine exited. Restart Orgtree to recover.' }
const UNAVAILABLE = { state: 'unavailable', message: 'Engine did not become ready in time' }

// --------------------------------------------------------------- the row

test('a running engine shows an ENABLED restart entry', () => {
  // USER RULING 2026-09-17, superseding 2026-09-15. The row used to be hidden
  // here — of hidden, greyed and live the user had chosen hidden, because a
  // mis-click ends every agent under a healthy engine. Hiding it also meant it
  // could not be found in the normal case, which is the case they want it in,
  // so the visibility half of that ruling was reversed: always present, and
  // clickable whenever a restart can actually be performed.
  assert.deepEqual(trayEngineState(READY, false, false), { label: 'Restart engine', visible: true, enabled: true })
})

test('a stopped engine shows an enabled restart entry', () => {
  assert.deepEqual(trayEngineState(STOPPED, false, false), { label: 'Restart engine', visible: true, enabled: true })
})

test('a failed start or restart still offers the entry, so the user can retry', () => {
  // 'unavailable' is where a FAILED restart lands. If the row vanished there,
  // the one moment the user most needs it would be the moment it disappeared.
  assert.deepEqual(trayEngineState(UNAVAILABLE, false, false), { label: 'Restart engine', visible: true, enabled: true })
})

test('boot startup shows the row, greyed: there is no engine to restart yet', () => {
  // `blocked` is what says so — index.ts `engineRestartBlocked()` is true until
  // `engineRestartOptions` is captured, which happens immediately before the
  // first attach/start. The row is visible from the first paint either way.
  assert.deepEqual(trayEngineState(STARTING, false, true), { label: 'Restart engine', visible: true, enabled: false })
})

test('THERE IS NO STATE THAT HIDES THE ROW', () => {
  // The acceptance is "visible in every engine state". Enumerate them all,
  // against every combination of the two flags, rather than sampling four.
  for (const status of [READY, STARTING, STOPPED, UNAVAILABLE]) {
    for (const restarting of [true, false]) for (const blocked of [true, false]) {
      assert.equal(trayEngineState(status, restarting, blocked).visible, true,
        `hidden at ${status.state} restarting=${restarting} blocked=${blocked}`)
      // and enablement is exactly "a restart can be run", independent of state
      assert.equal(trayEngineState(status, restarting, blocked).enabled, !restarting && !blocked,
        `wrong enablement at ${status.state} restarting=${restarting} blocked=${blocked}`)
    }
  }
})

test('a restart in flight says so, stays on screen, and cannot be clicked again', () => {
  // The engine passes through 'starting' during its own restart; the row must
  // not flicker away in the middle of the action the user just took.
  const view = trayEngineState(STARTING, true, false)
  assert.equal(view.label, 'Restarting engine...')
  assert.equal(view.visible, true)
  assert.equal(view.enabled, false)
  // Not even at the instant the engine reports ready — the attempt owns the
  // row until the attempt itself has finished.
  assert.equal(trayEngineState(READY, true, false).enabled, false)
  assert.equal(trayEngineState(STOPPED, true, false).enabled, false)
})

test('a quit, an update install or an installer upgrade disables the entry without hiding it', () => {
  const view = trayEngineState(STOPPED, false, true)
  assert.equal(view.visible, true, 'the user still sees why nothing can be restarted')
  assert.equal(view.enabled, false)
})

test('the row NEVER claims the engine is back at the moment of the click', () => {
  // There is no argument to this function that represents "was clicked", so an
  // optimistic tray is unrepresentable. What the click DOES change is
  // `restarting`, and while that is true the row is greyed in every engine
  // state — including the instant the engine reports ready, because the
  // attempt owns the row until the attempt itself settles.
  for (const status of [READY, STARTING, STOPPED, UNAVAILABLE]) {
    assert.equal(trayEngineState(status, true, false).enabled, false)
    assert.match(trayEngineState(status, true, false).label, /Restarting engine/)
  }
})

const menuDouble = () => {
  const item = { label: 'Restart engine', enabled: false, visible: false }
  return { item, getMenuItemById: id => (id === 'engine-restart' ? item : null) }
}

test('refreshTrayEngineMenu writes label, visibility and enablement onto the live item', () => {
  const menu = menuDouble()
  refreshTrayEngineMenu(menu, STOPPED, false, false)
  assert.deepEqual(menu.item, { label: 'Restart engine', enabled: true, visible: true })
  refreshTrayEngineMenu(menu, STARTING, true, false)
  assert.deepEqual(menu.item, { label: 'Restarting engine...', enabled: false, visible: true })
  refreshTrayEngineMenu(menu, READY, false, false)
  assert.deepEqual(menu.item, { label: 'Restart engine', enabled: true, visible: true })
  // and a blocked shutdown greys it in place rather than removing it
  refreshTrayEngineMenu(menu, READY, false, true)
  assert.deepEqual(menu.item, { label: 'Restart engine', enabled: false, visible: true })
})

test('a menu built without the row is left alone rather than crashing the refresh', () => {
  // Same tolerance refreshTrayUpdateMenu has for a development build whose
  // update rows are absent.
  refreshTrayEngineMenu({ getMenuItemById: () => null }, STOPPED, false, false)
})

// ---------------------------------------------------------- the decision
//
// Injected doubles, the idiom this codebase already uses for `trustCheck` and
// for `forceKillTree` in startup-engine.test.mjs: replace one phase on the
// instance and watch what the rest of the path does about it.

function instrumented({ stopped = true, released = true, start = async () => {} } = {}) {
  const engine = new Engine()
  const calls = { stop: 0, start: 0 }
  engine.stop = async () => { calls.stop++ }
  engine.stoppedConfirmed = async () => stopped
  engine.rootReleased = async () => released
  engine.start = async options => { calls.start++; return start(options) }
  return { engine, calls }
}
const OPTIONS = { python: 'py', directory: 'dir', dataRoot: 'root', forbiddenRoot: 'v1', uiDirectory: 'ui' }

test('an attached background engine is refused, and nothing is stopped or started', async () => {
  const { engine, calls } = instrumented()
  engine.managed = false
  await assert.rejects(engine.restart(OPTIONS), /cannot restart it/)
  assert.deepEqual(calls, { stop: 0, start: 0 })
})

test('an unconfirmed stop refuses rather than starting a second engine over the first', async () => {
  const { engine, calls } = instrumented({ stopped: false })
  await assert.rejects(engine.restart(OPTIONS), /did not confirm that it stopped/)
  assert.equal(calls.stop, 1, 'the stop was attempted')
  assert.equal(calls.start, 0, 'but nothing was spawned on top of it')
})

test('an unreleased data root refuses rather than starting a second engine over the first', async () => {
  const { engine, calls } = instrumented({ released: false })
  await assert.rejects(engine.restart(OPTIONS), /has not released the data root/)
  assert.equal(calls.start, 0)
})

test('repeated clicks join the one attempt; they never spawn a second engine', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { engine, calls } = instrumented({ start: () => gate })
  assert.equal(engine.restartInProgress, false)
  const first = engine.restart(OPTIONS)
  assert.equal(engine.restartInProgress, true, 'in flight before the caller has even awaited')
  const others = [engine.restart(OPTIONS), engine.restart(OPTIONS), engine.restart(OPTIONS)]
  release()
  await Promise.all([first, ...others])
  assert.equal(calls.start, 1, 'four clicks, one engine')
  assert.equal(calls.stop, 1)
  assert.equal(engine.restartInProgress, false, 'the slot is released when the attempt ends')
})

test('a failed restart reports the failure and leaves the entry usable for another try', async () => {
  const { engine, calls } = instrumented({ start: async () => { throw new Error('port 23001 is already in use') } })
  await assert.rejects(engine.restart(OPTIONS), /port 23001 is already in use/)
  // Nothing swallowed: the caller learns the real reason, which is what the
  // tray puts in its failure dialog.
  assert.equal(engine.restartInProgress, false)
  const { calls: second } = { calls }
  await engine.restart(OPTIONS).catch(() => {})
  assert.equal(second.start, 2, 'a failure does not permanently disable the entry')
})

test('every caller of a joined attempt is told the truth about its failure', async () => {
  let release
  const gate = new Promise((_, reject) => { release = reject })
  const { engine } = instrumented({ start: () => gate })
  const first = engine.restart(OPTIONS)
  const second = engine.restart(OPTIONS)
  release(new Error('the engine executable is missing'))
  await assert.rejects(first, /executable is missing/)
  await assert.rejects(second, /executable is missing/, 'a joined click is not told it succeeded')
})

// -------------------------------------------------------- the real thing
//
// A REAL engine process, in a temp data root of its own. Never the live one.

let python = ''
if (process.platform === 'win32') python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
const windowsOnly = process.platform !== 'win32' ? 'INERT: the real guardian requires Windows' : false

/** A sandbox engine. `mode: 'ready'` announces readiness, answers the
 *  authenticated shutdown route by exiting, and records every launch; `mode:
 *  'fail'` dies before readiness, which is what a broken restart looks like. */
function fixture(mode, directory = fs.mkdtempSync(path.join(temp, 'fixture-'))) {
  const dataRoot = path.join(directory, 'data')
  if (!fs.existsSync(dataRoot)) fs.mkdirSync(dataRoot)
  const source = `import os,sys,time,json,threading
from pathlib import Path
sys.path.insert(0,${JSON.stringify(process.cwd())})
from engine.process_lifetime import arm_process_lifetime
from engine.startup_progress import StartupProgress
from http.server import BaseHTTPRequestHandler,HTTPServer
root=Path(os.environ['ORGTREE_DATA'])
progress=StartupProgress(root)
guardian=arm_process_lifetime(root,parent_pid=int(os.environ['ORGTREE_V2_PARENT_PID']))
progress.report('lifetime-owned')
def record(what):
    with open(root/'launches.log','a') as f: f.write('%d %s\\n'%(os.getpid(),what))
if ${JSON.stringify(mode)} == 'fail':
    record('exited-before-ready')
    sys.exit(3)
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers()
        self.wfile.write(b'{"accepted":true}')
        threading.Thread(target=lambda:(time.sleep(.2),os._exit(0))).start()
    def log_message(self,*a): pass
server=HTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
record('ready')
print(json.dumps(dict(type='ready',protocol=1,pid=os.getpid(),dataRootId=str(root),port=server.server_address[1],guardianPid=guardian)),flush=True)
time.sleep(120)
`
  fs.writeFileSync(path.join(directory, 'launch.py'), source)
  return { python, directory, dataRoot, forbiddenRoot: path.join(directory, 'v1'), uiDirectory: directory, timeoutMs: 20000 }
}

const launches = options => {
  const file = path.join(options.dataRoot, 'launches.log')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : []
}
const alive = pid => execFileSync(python, ['-c',
  `import ctypes;h=ctypes.windll.kernel32.OpenProcess(0x100000,False,${pid});print('alive' if h and ctypes.windll.kernel32.WaitForSingleObject(h,0)==258 else 'gone')`],
  { encoding: 'utf8' }).trim() === 'alive'

async function teardown(engine, options) {
  const child = engine.child
  if (child?.pid && child.exitCode === null && child.signalCode === null) await engine.forceKillTree(child.pid)
  await engine.awaitAttachedRelease('', '', path.join(options.dataRoot, '.desktop-engine.lock'), 5000)
}

test('a stopped sandbox engine is brought back up, and the tray only says so once it really is', { skip: windowsOnly }, async () => {
  const engine = new Engine(), options = fixture('ready')
  const seen = []
  engine.on('status', status => seen.push(status.state))
  try {
    await engine.start(options)
    assert.equal(engine.status.state, 'ready')
    const [first] = launches(options)
    const firstPid = Number(first.split(' ')[0])

    // Take it down the way a crashed or stopped engine leaves the app: the
    // process is gone and the status says stopped.
    await engine.stop()
    assert.equal(await engine.stoppedConfirmed(10000), true)
    engine.childExited(engine.child)
    assert.equal(engine.status.state, 'stopped')
    assert.equal(trayEngineState(engine.status, false, false).visible, true, 'the entry is there for the user to click')

    // THE RESTART — through Engine.restart, which is what the menu item calls.
    seen.length = 0
    const attempt = engine.restart(options)
    assert.equal(engine.restartInProgress, true)
    assert.notEqual(engine.status.state, 'ready', 'the click alone never makes the tray say ready')
    await attempt

    assert.equal(engine.status.state, 'ready')
    assert.deepEqual(seen, ['starting', 'ready'], 'ready is announced by the engine, after starting, not by the click')
    const log = launches(options)
    assert.equal(log.length, 2, 'exactly one further engine was launched')
    const secondPid = Number(log[1].split(' ')[0])
    assert.notEqual(secondPid, firstPid)
    assert.equal(alive(firstPid), false, 'the first engine was dead before the second existed')
    assert.equal(alive(secondPid), true)
    const after = trayEngineState(engine.status, false, false)
    assert.equal(after.visible, true, 'the entry is still there over a healthy engine')
    assert.equal(after.enabled, true, 'and clickable again, now that the attempt has settled')
  } finally { await teardown(engine, options) }
})

test('a restart that cannot bring the engine up says so, and never reports success', { skip: windowsOnly }, async () => {
  const engine = new Engine(), options = fixture('ready')
  try {
    await engine.start(options)
    await engine.stop()
    assert.equal(await engine.stoppedConfirmed(10000), true)
    engine.childExited(engine.child)
    // The engine binary is replaced by one that dies before readiness — the
    // "the process dies immediately" failure the ticket names.
    fixture('fail', options.directory)
    await assert.rejects(engine.restart(options), error => {
      assert.match(error.message, /exited before readiness|could not start|tree release/)
      return true
    })
    assert.equal(engine.status.state, 'unavailable', 'a failed restart is never left looking healthy')
    assert.equal(engine.restartInProgress, false)
    const view = trayEngineState(engine.status, false, false)
    assert.equal(view.visible, true, 'and the entry is still there to try again')
    assert.equal(view.label, 'Restart engine')
    assert.ok(launches(options).some(line => line.endsWith('exited-before-ready')), 'the failing engine really was launched')
  } finally { await teardown(engine, options) }
})

test('clicking a real restart four times launches exactly one engine', { skip: windowsOnly }, async () => {
  const engine = new Engine(), options = fixture('ready')
  try {
    await engine.start(options)
    await engine.stop()
    assert.equal(await engine.stoppedConfirmed(10000), true)
    engine.childExited(engine.child)
    const before = launches(options).length
    await Promise.all([engine.restart(options), engine.restart(options), engine.restart(options), engine.restart(options)])
    assert.equal(launches(options).length, before + 1, 'four clicks, one engine process')
    assert.equal(engine.status.state, 'ready')
  } finally { await teardown(engine, options) }
})

// --------------------------------------------------------------- wiring
//
// index.ts requires Electron and runs an application, so what it actually
// CALLS is asserted at source level — the idiom lifetime-wiring.test.mjs and
// updater-wiring.test.mjs already use for exactly this reason.

const indexSource = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'apps/desktop/main/index.ts'), 'utf8')

test('the tray menu is built with the restart row already VISIBLE', () => {
  // The seed, not just the refresh: `refreshTrayEngine()` runs a few lines
  // later, and a row seeded invisible would be invisible in between. Seeded
  // disabled because no engine options are captured at that instant.
  assert.match(indexSource, /\{ id: 'engine-restart', label: 'Restart engine', visible: true, enabled: false,/)
  assert.doesNotMatch(indexSource, /\{ id: 'engine-restart',[^\n]*visible: false/,
    'the 2026-09-15 hidden seed must be gone, not merely overridden at runtime')
  assert.match(indexSource, /click: \(\) => \{ void restartEngine\(\) \} \}/)
  // It shares the Quit group's separator rather than introducing its own.
  assert.match(indexSource, /\{ type: 'separator' \},\s*(?:\n\s*\/\/[^\n]*)+\n\s*\{ id: 'engine-restart'/)
})

test('the superseded 2026-09-15 hide-while-running rule is recorded, not left standing', () => {
  // The old justification sat above `trayEngineState` and described behaviour
  // the code no longer has. It must name the new ruling and its date, and it
  // must not still read as the rule in force.
  const engineSource = fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'apps/desktop/main/engine.ts'), 'utf8')
  const doc = engineSource.slice(engineSource.lastIndexOf('/**', engineSource.indexOf('export function trayEngineState')),
    engineSource.indexOf('export function trayEngineState'))
  assert.match(doc, /ALWAYS VISIBLE \(user ruling 2026-09-17\)/, 'the new ruling and its date are recorded')
  assert.match(doc, /2026-09-15/, 'the superseded ruling is kept rather than deleted')
  assert.match(doc, /SUPERSEDING|supersed/i, 'and it is marked as superseded, so it does not read as current')
  assert.doesNotMatch(doc, /HIDDEN WHILE THE ENGINE RUNS \(user ruling 2026-09-15\)/,
    'the stale heading that asserted the old rule is gone')
  // USER RULING 2026-09-17 16:02: "No confirmation." The user was told the row
  // becomes clickable while agents are live and that ending their turns is not
  // undoable, and chose the unguarded row anyway. The comment must say so, or
  // the next reader reads the hazard as an oversight and "fixes" it.
  assert.match(doc, /ACCEPTED COST/, 'the mis-click hazard is recorded as accepted, not as an open gap')
  assert.match(doc, /No confirmation/, 'the ruling is quoted')
})

test('a click restarts immediately: there is no confirmation step in front of it', () => {
  // The user ruled against a confirmation dialog on 2026-09-17 with the hazard
  // in front of them. `restartEngine` DOES use dialog.showMessageBox — for the
  // FAILURE report, after the attempt — so the assertion is specifically that
  // nothing prompts BEFORE the restart is handed to the engine.
  const handler = indexSource.slice(indexSource.indexOf('const restartEngine = async () =>'), indexSource.indexOf('const rebuildTray = () =>'))
  const beforeRestart = handler.slice(0, handler.indexOf('engine.restart(options)'))
  assert.ok(!/showMessageBox|confirm|areYouSure/i.test(beforeRestart),
    'nothing may prompt the user between the click and the restart')
  // and the only guard on the path is the mechanical one: can a restart run
  assert.match(beforeRestart, /if \(!options \|\| engineRestartBlocked\(\) \|\| engine\.restartInProgress\) return/)
})

test('the click drives the existing engine lifecycle, not a new spawn path', () => {
  const handler = indexSource.slice(indexSource.indexOf('const restartEngine = async () =>'), indexSource.indexOf('const rebuildTray = () =>'))
  assert.ok(handler.includes('engine.restart(options)'), 'the restart goes through Engine.restart')
  assert.ok(!handler.includes('spawn('), 'nothing in the tray path spawns a process of its own')
  assert.ok(handler.includes('engineRestartOptions'), 'and it restarts with the options the engine was started with')
  assert.match(indexSource, /engineRestartOptions = engineOptions/)
})

test('a failed restart raises the same kind of failure dialog a failed update does', () => {
  assert.match(indexSource, /message: 'Orgtree could not restart its engine\.'/)
  assert.match(indexSource, /detail: error instanceof Error \? error\.message : 'Unknown restart error'/)
})

test('the row is refreshed on every rebuild and while the menu is open', () => {
  assert.match(indexSource, /if \(trayMenuOpen\) \{ refreshTrayUpdates\(\); refreshTrayEngine\(\); return \}/)
  assert.match(indexSource, /refreshTrayUpdates\(\)\s*\n\s*refreshTrayEngine\(\)\s*\n\s*tray\.setContextMenu/)
  // The engine's own status event is what rebuilds the tray, which is why the
  // row can only follow the engine rather than the click.
  const listener = indexSource.slice(indexSource.indexOf("engine.on('status'"))
  assert.ok(listener.slice(0, listener.indexOf('\n')).includes('rebuildTray()'),
    'every engine status change rebuilds the tray')
})

test('a restart is not offered while something else is already taking the engine down', () => {
  assert.match(indexSource, /const engineRestartBlocked = \(\) => !engineRestartOptions \|\| quitting \|\| updateApplying \|\| installerUpgradeShutdown/)
  const handler = indexSource.slice(indexSource.indexOf('const restartEngine = async () =>'), indexSource.indexOf('const rebuildTray = () =>'))
  assert.ok(handler.includes('engineRestartBlocked()'), 'the click re-checks, not only the menu item')
  assert.ok(handler.includes('engine.restartInProgress'))
})
