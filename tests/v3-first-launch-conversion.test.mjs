// v3-first-launch-conversion.test.mjs — THE DESKTOP'S HALF OF THE FIRST-LAUNCH
// CONVERSION (user decision 38, 2026-09-28: the first v3 start converts a
// 2.1.12 SQLite data folder to PostgreSQL automatically).
//
// The engine side (engine/pg_process.py, engine/service_host.py) belongs to
// p03-ws1-pgservice. The contract agreed with it, and pinned here:
//   * progress phases prefixed `database-convert`, on the ordinary
//     startup-progress protocol;
//   * one stdout line {"type":"refused","code":"conversion-failed","reason"};
//   * <data>\conversion\current.json (orgtree.conversion-status/v1).
// What the desktop must do with it:
//   1. a conversion-failed line is NOT the root-owned attach race: never
//      retried, and its reason reaches the fatal dialog;
//   2. while the latest phase is a conversion, the readiness window between
//      checkpoints is the long one;
//   3. waiting to ATTACH to a boot host that is converting keeps waiting for
//      as long as its process lives, and a failure during the wait ends it
//      with the conversion's reason;
//   4. the user sees what is happening (the `conversion` event drives a
//      window; its page escapes what it shows).
//
// Nothing here builds, packages, installs or touches a real data folder.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-v3-conversion-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const file = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'cjs' })
  return req(file)
}
const policy = await load('policy')
const { Engine, ENGINE_REFUSED } = await load('engine')

const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '0']); return r.pid }
const status = (root, fields) => {
  fs.mkdirSync(path.join(root, 'conversion'), { recursive: true })
  fs.writeFileSync(path.join(root, 'conversion', 'current.json'), JSON.stringify({ schema: 'orgtree.conversion-status/v1',
    state: 'running', phase: 'database-convert: copying acme (1 of 4): 120000 rows', pid: process.pid,
    at: new Date().toISOString(), log: path.join(root, 'conversion', 'x'), reason: null, ...fields }))
}

test('1. conversion-failed parses as its own verdict and is never the root-owned retry', () => {
  const line = JSON.stringify({ type: 'refused', code: 'conversion-failed', reason: 'orgtree.db could not be read back; log: C:\\d\\conversion\\1' })
  assert.equal(policy.parseConversionFailure(line), 'orgtree.db could not be read back; log: C:\\d\\conversion\\1')
  assert.equal(policy.parseRefusal(line), null, 'must not reach the attach-retry path')
  for (const other of [JSON.stringify({ type: 'refused', code: 'root-owned', reason: 'x' }), JSON.stringify({ type: 'refused', code: 'conversion-failed', reason: 7 }),
    JSON.stringify({ type: 'progress', code: 'conversion-failed', reason: 'x' }), 'not json', '{}'])
    assert.equal(policy.parseConversionFailure(other), null, other)
  assert.ok(!policy.CONVERSION_FAILED.startsWith(ENGINE_REFUSED))
})

test('2. only a database-convert phase is a conversion, and the message says so plainly', () => {
  const p = JSON.stringify({ type: 'startup-progress', protocol: 1, pid: 1, dataRootId: temp, sequence: 3, phase: 'database-convert: copying acme (1 of 4)' })
  assert.equal(policy.progressPhase(p), 'database-convert: copying acme (1 of 4)')
  assert.equal(policy.isConversionPhase(policy.progressPhase(p)), true)
  for (const phase of ['database-up', 'api-loaded', '', null, undefined, 'converting']) assert.equal(policy.isConversionPhase(phase), false, String(phase))
  assert.match(policy.conversionMessage('database-convert: copying acme (1 of 4)'), /^Orgtree is converting your data to the new storage\. This happens once[^\n]*\n\ncopying acme \(1 of 4\)$/)
  const page = policy.conversionPage('database-convert: <script>alert(1)</script> & "q"')
  assert.ok(!page.includes('<script>') && page.includes('&lt;script&gt;') && page.includes('&amp;') && page.includes('&quot;q&quot;'))
  assert.ok(!/<script|javascript:|src=|href=/i.test(page), 'the page carries no script or remote content')
})

test('3a. the status file: agreed schema only; running needs a live process, failed a finished one', () => {
  const root = fs.mkdtempSync(path.join(temp, 'status-'))
  assert.equal(policy.readConversionStatus(root), null)
  status(root, {})
  assert.equal(policy.readConversionStatus(root).state, 'running')
  assert.deepEqual(policy.conversionWait(policy.readConversionStatus(root)), { converting: 'database-convert: copying acme (1 of 4): 120000 rows' })
  const dead = deadPid()
  status(root, { pid: dead })
  assert.equal(policy.conversionWait(policy.readConversionStatus(root)), null, 'a killed conversion is not a verdict: the next start re-runs it')
  status(root, { state: 'failed', pid: dead, reason: 'read-back mismatch in acme; log: X' })
  assert.deepEqual(policy.conversionWait(policy.readConversionStatus(root)), { failed: 'read-back mismatch in acme; log: X' })
  status(root, { state: 'failed', reason: 'still exiting' })
  assert.equal(policy.conversionWait(policy.readConversionStatus(root)), null, 'failed but its process still alive: not final yet')
  status(root, { state: 'done' })
  assert.equal(policy.conversionWait(policy.readConversionStatus(root)), null)
  for (const bad of [{ schema: 'other' }, { state: 'paused' }, { pid: 0 }, { pid: '12' }, { phase: 5 }, { reason: 5 }]) {
    status(root, bad)
    assert.equal(policy.readConversionStatus(root), null, JSON.stringify(bad))
  }
  assert.equal(policy.processExists(process.pid), true)
  assert.equal(policy.processExists(1, () => { const e = new Error('x'); e.code = 'EPERM'; throw e }), true)
  assert.equal(policy.processExists(1, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e }), false)
})

test('3b. waiting to attach outlasts the budget while a live process converts, and ends on a failure during the wait', async () => {
  const root = fs.mkdtempSync(path.join(temp, 'attach-'))
  const engine = new Engine()
  const phases = []
  engine.on('conversion', phase => phases.push(phase))
  status(root, {})
  const began = Date.now()
  setTimeout(() => status(root, { state: 'failed', pid: deadPid(), reason: 'acme: rows differ after copy; log: L' }), 900)
  const attached = await engine.attachWithRetry({ dataRoot: root, forbiddenRoot: path.join(temp, 'v1') }, 300, 50)
  const waited = Date.now() - began
  assert.equal(attached, false)
  assert.ok(waited >= 850, `waited only ${waited} ms: the 300 ms budget was not extended while converting`)
  assert.equal(engine.conversionFailure, 'acme: rows differ after copy; log: L')
  assert.deepEqual(phases, ['database-convert: copying acme (1 of 4): 120000 rows', null])
})

test('3c. negative controls: no conversion keeps the ordinary budget; an OLD failure is not this wait\'s verdict', async () => {
  const forbiddenRoot = path.join(temp, 'v1')
  const none = fs.mkdtempSync(path.join(temp, 'none-'))
  const engine = new Engine()
  let began = Date.now()
  assert.equal(await engine.attachWithRetry({ dataRoot: none, forbiddenRoot }, 300, 50), false)
  assert.ok(Date.now() - began < 800)
  assert.equal(engine.conversionFailure, '')
  const old = fs.mkdtempSync(path.join(temp, 'old-'))
  status(old, { state: 'failed', pid: deadPid(), reason: 'last week', at: new Date(Date.now() - 3600e3).toISOString() })
  began = Date.now()
  assert.equal(await engine.attachWithRetry({ dataRoot: old, forbiddenRoot }, 300, 50), false)
  assert.ok(Date.now() - began < 800)
  assert.equal(engine.conversionFailure, '')
})

test('3d. f1: a stale running file whose pid is alive (reused) keeps only the ordinary budget', async () => {
  const root = fs.mkdtempSync(path.join(temp, 'stale-'))
  status(root, { at: new Date(Date.now() - 5000).toISOString() })
  const engine = new Engine()
  const phases = []
  engine.on('conversion', phase => phases.push(phase))
  const began = Date.now()
  assert.equal(await engine.attachWithRetry({ dataRoot: root, forbiddenRoot: path.join(temp, 'v1') }, 300, 50, { staleMs: 2000, capMs: 60000 }), false)
  assert.ok(Date.now() - began < 800, 'a stale file must not extend the wait')
  assert.deepEqual(phases, [], 'a stale phase is never shown')
  assert.ok(policy.CONVERSION_WINDOW_MS < (await load('engine')).ATTACH_CONVERSION_LIMITS.staleMs, 'stale only past the host checkpoint window')
})

test('3e. f1: a conversion that keeps reporting still stops at the absolute cap', async () => {
  const root = fs.mkdtempSync(path.join(temp, 'cap-'))
  status(root, {})
  const refresh = setInterval(() => status(root, {}), 100)
  const engine = new Engine()
  const began = Date.now()
  try {
    assert.equal(await engine.attachWithRetry({ dataRoot: root, forbiddenRoot: path.join(temp, 'v1') }, 300, 50, { staleMs: 60000, capMs: 1200 }), false)
  } finally { clearInterval(refresh) }
  const waited = Date.now() - began
  assert.ok(waited >= 1100 && waited < 2000, `waited ${waited} ms: expected the 1200 ms cap, not the budget and not forever`)
  assert.equal(engine.conversionFailure, '')
})

let python = ''
if (process.platform === 'win32') python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
const skip = process.platform !== 'win32' ? 'INERT: the fake engine is driven with the Windows python' : false

function fakeEngine(script) {
  const directory = fs.mkdtempSync(path.join(temp, 'engine-'))
  const dataRoot = path.join(directory, 'data')
  fs.mkdirSync(dataRoot)
  fs.writeFileSync(path.join(directory, 'launch.py'), `import os,sys,time,json
root=os.environ['ORGTREE_DATA']
seq=[0]
def progress(phase):
    seq[0]+=1
    print(json.dumps(dict(type='startup-progress',protocol=1,pid=os.getpid(),dataRootId=root,sequence=seq[0],phase=phase)),flush=True)
def ready():
    print(json.dumps(dict(type='ready',protocol=1,pid=os.getpid(),dataRootId=root,port=23011)),flush=True)
${script}
time.sleep(2)
`)
  return { directory, dataRoot }
}
const options = (f, extra) => ({ python, directory: f.directory, dataRoot: f.dataRoot, forbiddenRoot: path.join(temp, 'v1'),
  uiDirectory: temp, timeoutMs: 1500, ...extra })

test('2b. a conversion step longer than the ordinary window succeeds; the window event opens and closes', { skip }, async () => {
  const f = fakeEngine(`progress('database-up')
progress('database-convert: copying acme (1 of 2)')
time.sleep(3)
progress('database-convert: copying beta (2 of 2)')
time.sleep(3)
progress('api-loaded')
ready()`)
  const engine = new Engine()
  const phases = []
  engine.on('conversion', phase => phases.push(phase))
  await engine.start(options(f, { conversionWindowMs: 6000 }))
  assert.equal(engine.status.state, 'ready')
  assert.deepEqual(phases, ['database-convert: copying acme (1 of 2)', 'database-convert: copying beta (2 of 2)', null])
  await engine.stopForQuit(3000).catch(() => {})
})

test('2c. negative control: the same 3 s silence in an ordinary phase still times out', { skip }, async () => {
  const f = fakeEngine(`progress('database-up')
time.sleep(3)
ready()`)
  const engine = new Engine()
  await assert.rejects(engine.start(options(f, { conversionWindowMs: 6000 })), /did not become ready in time/)
})

test('1b. a conversion-failed line ends the start with the reason, not a lock refusal', { skip }, async () => {
  const f = fakeEngine(`progress('database-convert: copying acme (1 of 1)')
print(json.dumps(dict(type='refused',code='conversion-failed',reason='acme could not be read back. Nothing was changed. Log: C:/d/conversion/1')),flush=True)
sys.exit(1)`)
  const engine = new Engine()
  const phases = []
  engine.on('conversion', phase => phases.push(phase))
  const error = await engine.start(options(f, {})).then(() => null, e => e)
  assert.ok(error instanceof Error)
  assert.ok(error.message.startsWith(policy.CONVERSION_FAILED + 'acme could not be read back. Nothing was changed. Log: C:/d/conversion/1'), error.message)
  assert.ok(!error.message.startsWith(ENGINE_REFUSED))
  assert.deepEqual(phases, ['database-convert: copying acme (1 of 1)', null])
})

test('4. startup wiring: the window follows the conversion event, and an attach-wait failure shows its reason first', () => {
  const source = fs.readFileSync('apps/desktop/main/index.ts', 'utf8')
  assert.match(source, /engine\.on\('conversion', \(phase: string \| null\) => conversionWindow\.update\(phase\)\)/)
  const wiredAt = source.indexOf("engine.on('conversion'")
  assert.ok(wiredAt > 0 && wiredAt < source.indexOf('engine.attach(engineOptions)'), 'wired before the first attach or start')
  const retry = source.indexOf('if (!await engine.attachWithRetry(engineOptions)) {')
  const failure = source.indexOf('if (engine.conversionFailure) throw new Error(CONVERSION_FAILED + engine.conversionFailure)', retry)
  const diagnostic = source.indexOf('if (engine.attachDiagnostic) throw', retry)
  assert.ok(retry > 0 && failure > retry && failure < diagnostic)
})
