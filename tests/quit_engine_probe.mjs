// REAL-PROCESS probe for `stop-the-engine-when-orgtree-quits`.
//
// Nothing here is a stand-in for the thing under test: it boots the actual
// engine/service_host.py, which spawns the actual engine/launch.py, which arms
// the actual engine/process_lifetime.py guardian and its Windows job object,
// against a throwaway data root — then drives the REAL desktop Engine class
// (esbuilt from apps/desktop/main/engine.ts) at it.
//
//   §A  reproduces the reported failure: `engine.stop()`, which is all a tray
//       Quit used to run, leaves the host, the engine and the guardian alive.
//   §B  the quit path stops the same tree and proves it gone.
//   §C  a quit that gets NO graceful stop terminates the tree by force.
//   §D  killing the engine takes its DESCENDANTS, through the real guardian.
//
// Negative controls (each must make the probe FAIL, and is what shows the
// probe is capable of failing at all):
//   --mutant no-quit    §B calls stop() instead of stopForQuit
//   --mutant no-force   §C's forced termination is stubbed out
//   --mutant no-job     §D arms no guardian, so nothing owns the descendants
//
// Usage:  node tests/quit_engine_probe.mjs [--mutant <name>] [--python <exe>]
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const argv = process.argv.slice(2)
const flag = name => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : '' }
const MUTANT = flag('--mutant')
const PACKAGED = 'C:/Program Files/Orgtree/resources/engine/runtime/python.exe'
const PYTHON = flag('--python') || (fs.existsSync(PACKAGED) ? PACKAGED : 'python')
const REPO = process.cwd()

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-quit-probe-'))
const ui = path.join(temp, 'ui'); fs.mkdirSync(path.join(ui, 'assets'), { recursive: true }); fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html>')
const req = createRequire(import.meta.url)
const built = path.join(temp, 'engine.cjs')
await build({ entryPoints: [path.join(REPO, 'apps/desktop/main/engine.ts')], outfile: built, bundle: true, platform: 'node', format: 'cjs' })
const { Engine } = req(built)

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const gone = async (pids, ms) => {
  const until = Date.now() + ms
  for (;;) {
    const left = pids.filter(alive)
    if (!left.length) return []
    if (Date.now() >= until) return left
    await pause(100)
  }
}
/** The engine's guardian children, by COMMAND LINE and not merely by
 *  parentage: a real engine also spawns short-lived helpers, and one of those
 *  exiting on its own would otherwise read as the tree coming down. */
function guardiansOf(pid) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | Where-Object { $_.CommandLine -like '*process_lifetime*' } | Select-Object -ExpandProperty ProcessId) -join ','`],
    { encoding: 'utf8', timeout: 30000 })
  return out.trim() ? out.trim().split(',').map(Number) : []
}

/** Boot the real service host on its own data root and wait for the real
 *  attach descriptor it publishes only AFTER the ready handshake. */
async function bootRealEngine(label) {
  const root = path.join(temp, label); fs.mkdirSync(root)
  const env = { ...process.env, ORGTREE_V2_DATA: root, ORGTREE_V2_UI_DIR: ui, PYTHONUNBUFFERED: '1' }
  for (const key of ['ORGTREE_DATA', 'ORGTREE_PORT', 'ORGTREE_BASE', 'ORGTREE_V2_TOKEN', 'ORGTREE_V2_PORT']) delete env[key]
  const host = spawn(PYTHON, [path.join(REPO, 'engine/service_host.py')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  host.stderr.on('data', chunk => { log += chunk })
  host.stdout.on('data', () => {})
  const descriptorFile = path.join(fs.realpathSync.native(root), 'engine-attach.json')
  const until = Date.now() + 180000
  while (!fs.existsSync(descriptorFile)) {
    if (host.exitCode !== null) throw new Error(`${label}: host exited ${host.exitCode}\n${log}`)
    if (Date.now() >= until) { host.kill(); throw new Error(`${label}: no descriptor in time\n${log}`) }
    await pause(200)
  }
  const record = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
  const guardians = guardiansOf(record.enginePid)
  assert.ok(guardians.length >= 1, `${label}: the engine must have spawned its guardian`)
  const tree = [host.pid, record.enginePid, ...guardians]
  assert.deepEqual(tree.filter(p => !alive(p)), [], `${label}: the whole tree must be running before the test`)
  return { root: fs.realpathSync.native(root), host, record, guardians, tree, log: () => log }
}

async function attachTo(rig) {
  const engine = new Engine()
  // %TEMP%'s inherited ACEs would rightly fail the real descriptor trust
  // check; that check has its own dedicated controls in attach.test.mjs, and
  // nothing here depends on it.
  engine.trustCheck = async () => ({ ok: true, detail: 'probe stub' })
  const ok = await engine.attach({ dataRoot: rig.root, forbiddenRoot: path.join(temp, 'no-such-v1') })
  assert.equal(ok, true, 'the probe must attach to the real boot engine')
  assert.equal(engine.managed, false)
  return engine
}

const results = []
const record = (name, detail) => { results.push(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`) }

try {
  // ── §A · the reported failure, reproduced against real processes ───────
  {
    const rig = await bootRealEngine('orphan')
    const engine = await attachTo(rig)
    await engine.stop()
    await pause(3000)
    assert.deepEqual(rig.tree.filter(p => !alive(p)), [],
      '§A: stop() is a no-op for an attached engine — the tree must still be running')
    const answer = await fetch(`http://127.0.0.1:${rig.record.port}/api/desktop/identity`,
      { headers: { 'X-Orgtree-Desktop-Token': rig.record.token } })
    assert.equal(answer.status, 200, '§A: the orphaned engine still serves')
    record('§A the pre-fix orphan reproduces', `host ${rig.host.pid}, engine ${rig.record.enginePid}, guardian ${rig.guardians.join(',')} all alive after stop()`)

    // ── §B · the quit path, on the very same tree ────────────────────────
    const outcome = MUTANT === 'no-quit' ? (await engine.stop(), 'stopped') : await engine.stopForQuit(20000)
    assert.equal(outcome, 'stopped', '§B: a graceful quit must stop the attached engine')
    const survivors = await gone(rig.tree, 15000)
    assert.deepEqual(survivors, [], `§B: the whole tree must be gone (survivors: ${survivors})`)
    assert.equal(fs.existsSync(path.join(rig.root, 'engine-attach.json')), false, '§B: the descriptor must be gone')
    record('§B a quit stops the boot engine, its guardian and its host', `all of ${rig.tree.join(',')} gone`)
  }

  // ── §C · a wedged engine is terminated, not left behind ────────────────
  {
    const rig = await bootRealEngine('forced')
    const engine = await attachTo(rig)
    // The engine is healthy; what is simulated is the desktop getting NO
    // graceful stop out of it — the case the update path refuses and a quit
    // cannot. Nothing else about the tree is faked.
    engine.requestAttachedShutdown = async () => {}
    if (MUTANT === 'no-force') engine.forceKillTree = async () => {}
    const outcome = await engine.stopForQuit(2000)
    assert.equal(outcome, 'forced', '§C: a quit with no graceful stop must force')
    const survivors = await gone(rig.tree, 15000)
    assert.deepEqual(survivors, [], `§C: the forced quit must leave nothing (survivors: ${survivors})`)
    record('§C a quit with no graceful stop terminates the real tree', `forced ${rig.record.enginePid}`)
  }

  // ── §D · descendants, through the real guardian ────────────────────────
  {
    const root = path.join(temp, 'job'); fs.mkdirSync(root)
    const script = path.join(temp, 'job-engine.py')
    fs.writeFileSync(script, [
      'import os, subprocess, sys, time',
      `sys.path.insert(0, r'${REPO}')`,
      'from engine.process_lifetime import arm_process_lifetime',
      `guardian = ${MUTANT === 'no-job' ? '0' : `arm_process_lifetime(r'${root}')`}`,
      // A REAL grandchild, started after the job is armed so it inherits it.
      "kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(600)'])",
      "print(guardian, kid.pid, flush=True)",
      'time.sleep(600)',
    ].join('\n'))
    const child = spawn(PYTHON, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const line = await new Promise((resolve, reject) => {
      let buffer = ''
      child.stdout.on('data', chunk => { buffer += chunk; if (buffer.includes('\n')) resolve(buffer.split('\n')[0].trim()) })
      child.on('exit', code => reject(new Error(`job stand-in exited ${code}`)))
      setTimeout(() => reject(new Error('job stand-in never reported')), 60000)
    })
    const [guardian, kid] = line.split(/\s+/).map(Number)
    assert.equal(alive(kid), true, '§D positive control: the descendant is running')
    execFileSync('taskkill', ['/PID', String(child.pid), '/F'], { stdio: 'pipe' })
    const survivors = await gone([child.pid, kid, ...(guardian ? [guardian] : [])], 15000)
    assert.deepEqual(survivors, [], `§D: killing the engine must take its descendants (survivors: ${survivors})`)
    record('§D killing the engine takes its descendants', `engine ${child.pid}, guardian ${guardian || 'none'}, child ${kid}`)
  }

  console.log(`\nQUIT ENGINE PROBE: PASS${MUTANT ? ` (unexpected — mutant "${MUTANT}" should have failed)` : ''}`)
  process.exitCode = MUTANT ? 1 : 0
} catch (error) {
  console.log(results.join('\n'))
  console.log(`\nQUIT ENGINE PROBE: FAIL${MUTANT ? ` (expected for mutant "${MUTANT}")` : ''}\n${error.stack || error}`)
  process.exitCode = MUTANT ? 0 : 1
} finally {
  // Never leave a probe engine behind: this is a probe about orphans.
  for (const name of fs.readdirSync(temp)) {
    const descriptorFile = path.join(temp, name, 'engine-attach.json')
    if (!fs.existsSync(descriptorFile)) continue
    try {
      const record = JSON.parse(fs.readFileSync(descriptorFile, 'utf8'))
      for (const pid of [record.enginePid, record.hostPid]) {
        if (alive(pid)) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'pipe' })
      }
    } catch { /* nothing to sweep */ }
  }
  await pause(500)
  try { fs.rmSync(temp, { recursive: true, force: true }) } catch { /* %TEMP% sweeps it */ }
}
