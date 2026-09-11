import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgtree-startup-engine-'))
const req = createRequire(import.meta.url)
async function load(name) {
  const file = path.join(temp, name + '.cjs')
  await build({ entryPoints: [`apps/desktop/main/${name}.ts`], outfile: file, bundle: true, platform: 'node', format: 'cjs' })
  return req(file)
}
const { Engine, QUIT_DEADLINES } = await load('engine')
const { parseProgress } = await load('policy')

test('only advancing progress from the spawned process and root extends readiness', () => {
  const root = temp
  const event = { type: 'startup-progress', protocol: 1, pid: 123, dataRootId: root, sequence: 2, phase: 'api-loaded' }
  const parse = extra => parseProgress(JSON.stringify({ ...event, ...extra }), root, 123, 1)
  assert.equal(parse({}), 2)
  for (const invalid of [{ sequence: 1 }, { sequence: 0 }, { sequence: 1.5 }, { sequence: '2' }, { pid: 456 }, { protocol: 2 },
    { type: 'log' }, { dataRootId: path.join(root, 'foreign') }, { dataRootId: '.' }, { phase: '' }]) assert.equal(parse(invalid), 1)
  assert.equal(parseProgress('still working', root, 123, 1), 1)
})

let python = ''
if (process.platform === 'win32') python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()

function fixture(mode) {
  const directory = fs.mkdtempSync(path.join(temp, 'fixture-'))
  const dataRoot = path.join(directory, 'data')
  fs.mkdirSync(dataRoot)
  const source = `import os,sys,time,json,subprocess
from pathlib import Path
sys.path.insert(0,${JSON.stringify(process.cwd())})
from engine.process_lifetime import arm_process_lifetime
from engine.startup_progress import StartupProgress
root=Path(os.environ['ORGTREE_DATA'])
progress=StartupProgress(root)
guardian=arm_process_lifetime(root,parent_pid=int(os.environ['ORGTREE_V2_PARENT_PID']))
progress.report('lifetime-owned')
descendant=subprocess.Popen([sys.executable,'-c','import time;time.sleep(90)'])
(root/'child-pid').write_text(str(descendant.pid))
mode=${JSON.stringify(mode)}
if mode == 'progress':
    for i in range(4):
        time.sleep(.9)
        progress.report('stage-completed')
elif mode == 'duplicate':
    for i in range(30):
        time.sleep(.25)
        print(json.dumps(dict(type='startup-progress',protocol=1,pid=os.getpid(),dataRootId=str(root),sequence=1,phase='lifetime-owned')),flush=True)
elif mode == 'silent':
    time.sleep(90)
print(json.dumps(dict(type='ready',protocol=1,pid=os.getpid(),dataRootId=str(root),port=23001,guardianPid=guardian)),flush=True)
time.sleep(90)
`
  fs.writeFileSync(path.join(directory, 'launch.py'), source)
  return { python, directory, dataRoot, forbiddenRoot: path.join(directory, 'v1'), uiDirectory: directory, timeoutMs: 3000 }
}

async function kill(engine, root) {
  const child = engine.child
  if (child?.pid && child.exitCode === null && child.signalCode === null) await engine.forceKillTree(child.pid)
  const proof = await engine.awaitAttachedRelease('', '', path.join(root, '.desktop-engine.lock'), 5000)
  assert.equal(proof.released, true, 'real guardian lock must release')
}

test('slow advancing startup succeeds beyond the silence deadline', { skip: process.platform !== 'win32' ? 'INERT: real guardian requires Windows' : false }, async () => {
  const engine = new Engine(), options = fixture('progress')
  const started = Date.now()
  try {
    await engine.start(options)
    assert.ok(Date.now() - started > options.timeoutMs, 'control must exceed original fixed deadline')
    assert.equal(engine.status.state, 'ready')
  } finally { await kill(engine, options.dataRoot) }
})

test('silence kills the tree and releases the root before rejection; the next start succeeds', { skip: process.platform !== 'win32' ? 'INERT: real guardian requires Windows' : false }, async () => {
  const engine = new Engine(), options = fixture('silent')
  await assert.rejects(engine.start(options), /did not become ready in time$/)
  assert.equal(engine.guardianReleased(path.join(options.dataRoot, '.desktop-engine.lock')), true)
  const pid = fs.readFileSync(path.join(options.dataRoot, 'child-pid'), 'utf8')
  // Positive descendant exists before timeout (PID receipt), then Windows
  // reports it gone; a parent-only test misses the second-launch failure.
  assert.match(pid, /^\d+$/)
  const probe = execFileSync(python, ['-c', `import ctypes;h=ctypes.windll.kernel32.OpenProcess(0x100000,False,${pid});print('alive' if h and ctypes.windll.kernel32.WaitForSingleObject(h,0)==258 else 'gone')`], { encoding: 'utf8' }).trim()
  assert.equal(probe, 'gone')
  const ready = fixture('ready')
  fs.copyFileSync(path.join(ready.directory, 'launch.py'), path.join(options.directory, 'launch.py'))
  try {
    await engine.start(options)
    assert.equal(engine.status.state, 'ready')
  } finally { await kill(engine, options.dataRoot) }
})

test('duplicate progress cannot keep a stalled startup alive', { skip: process.platform !== 'win32' ? 'INERT: real guardian requires Windows' : false }, async () => {
  const engine = new Engine(), options = fixture('duplicate')
  await assert.rejects(engine.start(options), /did not become ready in time$/)
  assert.equal(engine.guardianReleased(path.join(options.dataRoot, '.desktop-engine.lock')), true)
})

test('failed cleanup is reported and prevents another managed start', { skip: process.platform !== 'win32' ? 'INERT: real guardian requires Windows' : false }, async () => {
  const engine = new Engine(), options = fixture('silent')
  const force = engine.forceKillTree.bind(engine), oldProof = QUIT_DEADLINES.provenMs
  QUIT_DEADLINES.provenMs = 100
  engine.forceKillTree = async () => {} // positive control: the termination request did nothing
  try {
    await assert.rejects(engine.start(options), /tree release could not be verified/)
    await assert.rejects(engine.start(options), /already started/)
    assert.equal(engine.guardianReleased(path.join(options.dataRoot, '.desktop-engine.lock')), false)
  } finally {
    QUIT_DEADLINES.provenMs = oldProof
    engine.forceKillTree = force
    await kill(engine, options.dataRoot)
  }
})
