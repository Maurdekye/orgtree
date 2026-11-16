import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { alive, stubEngine } from './engine-stub.mjs'
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

// A sandboxed engine: the test-native stub with a real Job guardian and root
// lock (tests/engine-stub.mjs), owning one sleeping descendant whose pid it
// records. mode: progress (four advancing checkpoints), duplicate (repeats
// one checkpoint), silent (never ready), ready.
function fixtureScript(mode) {
  return `progress('lifetime-owned')
const descendant = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { stdio: 'ignore', windowsHide: true })
fs.writeFileSync(path.join(ROOT, 'child-pid'), String(descendant.pid))
const mode = ${JSON.stringify(mode)}
;(async () => {
  if (mode === 'progress') {
    for (let i = 0; i < 4; i++) { await sleep(900); progress('stage-completed') }
  } else if (mode === 'duplicate') {
    for (let i = 0; i < 30; i++) {
      await sleep(250)
      say({ type: 'startup-progress', protocol: 1, pid: PID, dataRootId: ROOT, sequence: 1, phase: 'lifetime-owned' })
    }
  } else if (mode === 'silent') {
    await sleep(90000)
  }
  ready(23001, { guardianPid: GUARDIAN })
  await sleep(90000)
  process.exit(0)
})()
`
}

function fixture(mode) {
  const directory = fs.mkdtempSync(path.join(temp, 'fixture-'))
  const dataRoot = path.join(directory, 'data')
  fs.mkdirSync(dataRoot)
  const { binary } = stubEngine({ script: fixtureScript(mode), directory })
  return { binary, directory, dataRoot, forbiddenRoot: path.join(directory, 'v1'), uiDirectory: directory, timeoutMs: 3000 }
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
  assert.equal(alive(pid), false, 'the descendant must be gone')
  stubEngine({ script: fixtureScript('ready'), directory: options.directory })
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

// 4.6.1: the Python engine launcher is gone. A managed start without the Rust
// engine binary refuses before anything runs, and nothing in engine.ts can
// fall back to a Python interpreter.
test('a managed start needs the engine binary; there is no Python launcher', async () => {
  const engine = new Engine()
  const dataRoot = fs.mkdtempSync(path.join(temp, 'no-binary-'))
  await assert.rejects(engine.start({ directory: dataRoot, dataRoot, forbiddenRoot: path.join(temp, 'v1'), uiDirectory: dataRoot }),
    /The Orgtree engine is missing/)
  await assert.rejects(new Engine().start({ binary: path.join(dataRoot, 'missing.exe'), directory: dataRoot, dataRoot, forbiddenRoot: path.join(temp, 'v1'), uiDirectory: dataRoot }),
    /The Orgtree engine is missing/)
  const source = fs.readFileSync('apps/desktop/main/engine.ts', 'utf8')
  assert.doesNotMatch(source, /launch\.py|options\.python|ORGTREE_V2_PYTHON|PYTHONUNBUFFERED|Python engine/)
})
