// Proof: `rig build` takes the machine-wide build lock in queue order, hands
// it on when the build ends, and never touches a MOVED marker (docket
// rig-build-takes-the-d-build-lock-in-queue-order-h).
//   Every case runs the rig's withBuildLock against a temporary lock folder
//   and queue (ORGTREE_BUILD_LOCK), never the real ones, with a fake build
//   (no cargo) and ORGTREE_AGENT set to the case's caller:
//   a MOVED marker is refused and kept, even when it looks stale; a free lock
//   is taken only by the first queued name (whose line goes) and goes to the
//   next name when the build ends, failed or not; a lock handed over to the
//   caller, or claimed by its own watchdog, builds; a fresh lock of another
//   agent is refused; a stale lock is left while a build process runs in the
//   build folder, then cleared for a caller with nobody ahead, or handed to
//   the first queued name; a lock someone took during the build stays
//   theirs; short of RAM a free lock is not taken and a held one is kept;
//   blank lines and CR/LF in the queue are tolerated
//   the rig home defaults to the caller's own D:\orgtree-work\rig\<agent> and
//   the lock to D:\orgtree-work\cargo-target (when D:\orgtree-work exists);
//   the shared D:\orgtree-work\rig, or a home with another rig home inside
//   it, is refused; CARGO_TARGET_DIR on C: or E: is refused
// Run: node tools/rig/proofs/build-lock.mjs   (no engine, no rig run, no real build lock)

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = fileURLToPath(import.meta.url)
const LIB = pathToFileURL(path.join(path.dirname(SELF), '..', 'lib.mjs')).href
const WORK = 'D:\\orgtree-work'
const MIN = 60 * 1000

// --defaults: a child prints the rig home (or why it is refused) and the lock the rig picks with its environment
if (process.argv.includes('--defaults')) {
  const m = await import(LIB)
  let home = null, homeError = null
  try { home = m.rigHome() } catch (e) { homeError = e.message }
  console.log(JSON.stringify({ home, homeError, lock: m.buildLockPaths ? m.buildLockPaths() : { lock: m.BUILD_LOCK } }))
  process.exit(0)
}

// the temporary lock and queue (in the caller's rig home), set before lib.mjs
// loads (the rig before the fix read ORGTREE_BUILD_LOCK once, at import)
const agentName = (process.env.ORGTREE_AGENT || os.userInfo().username).replace(/[^A-Za-z0-9._-]+/g, '-')
const home = process.env.ORGTREE_RIG_HOME || (fs.existsSync(WORK) ? path.join(WORK, 'rig', agentName) : path.join(os.tmpdir(), 'orgtree-rig'))
const root = path.join(home, 'tmp', `build-lock-${process.pid}-${Date.now()}`)
const LOCK = path.join(root, 'build.lock')
const OWNER = path.join(LOCK, 'owner.txt')
const QUEUE = path.join(root, 'build.queue.txt')
process.env.ORGTREE_BUILD_LOCK = LOCK

const lib = await import(LIB)
const { Proof } = await import(pathToFileURL(path.join(path.dirname(SELF), '..', 'proof.mjs')).href)

const same = (a, b) => !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
const libLock = lib.buildLockPaths ? lib.buildLockPaths().lock : lib.BUILD_LOCK
if (!same(libLock, LOCK)) throw new Error(`refusing to run: the rig would use ${libLock}, not the proof's ${LOCK}`)

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString()
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A fresh case: the lock folder with `owner` (aged `ownerAgeMs`; negative = in the future) or none, the queue's text or none. */
function reset({ owner, ownerAgeMs, queue } = {}) {
  fs.rmSync(LOCK, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  if (owner !== undefined) {
    fs.mkdirSync(LOCK)
    fs.writeFileSync(OWNER, owner + '\n')
    if (ownerAgeMs) { const t = new Date(Date.now() - ownerAgeMs); fs.utimesSync(OWNER, t, t) }
  }
  if (queue === undefined) fs.rmSync(QUEUE, { force: true })
  else fs.writeFileSync(QUEUE, queue)
}

function state() {
  let owner = null, mtime = null, queueText = null
  try { owner = fs.readFileSync(OWNER, 'utf8').trim(); mtime = fs.statSync(OWNER).mtimeMs } catch {}
  try { queueText = fs.readFileSync(QUEUE, 'utf8') } catch {}
  return { lock: fs.existsSync(LOCK), owner, mtime, queueText, queue: (queueText ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean) }
}

/** withBuildLock as `caller` with a fake build (`build` may throw); what happened. */
function attempt(caller, { ram = 16, build } = {}) {
  process.env.ORGTREE_AGENT = caller
  const said = []
  const errorLog = console.error
  console.error = (...a) => said.push(a.join(' '))
  let ran = false, during = null, error = null, out
  try {
    out = lib.withBuildLock('proof build', () => { ran = true; during = state(); if (build) build(); return { built: true } }, { freeRam: () => ram })
  } catch (e) { error = e.message } finally { console.error = errorLog }
  return { ran, during, error, out, said: said.join('\n'), after: state() }
}

const slim = r => ({
  ran: r.ran, error: r.error?.slice(0, 400), said: r.said.slice(0, 300) || undefined, lock: r.out?.lock,
  during: r.during && { owner: r.during.owner, queue: r.during.queue }, after: { lock: r.after.lock, owner: r.after.owner, queue: r.after.queue },
})

async function waitFor(fn, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(300) }
  return false
}

const p = new Proof('build-lock')
const cases = {}
const agent = process.env.ORGTREE_AGENT
let busy = null
try {
  // ------------------------------------------------------------ the MOVED marker
  const MOVED = 'MOVED 2026-10-10 12:50Z: the build lock and queue now live in D:\\orgtree-work\\cargo-target (build.lock, build.queue.txt). Never remove this folder.'
  reset({ owner: MOVED, ownerAgeMs: 120 * MIN })
  const marker = state()
  let r = cases.movedStale = attempt('alice')
  p.check('a MOVED marker that looks stale (owner.txt 2 h old) is refused; the folder and its owner.txt stay exactly as they were',
    !r.ran && /MOVED|marker/.test(r.error ?? '') && r.after.lock && r.after.owner === MOVED && Math.abs(r.after.mtime - marker.mtime) < 2000, slim(r))

  reset({ owner: MOVED, ownerAgeMs: -3 * 365 * 24 * 60 * MIN })
  r = cases.movedFuture = attempt('alice')
  p.check('a MOVED marker dated in the future (the coordinator\'s stopgap) is refused and kept', !r.ran && r.error && r.after.owner === MOVED, slim(r))

  // ------------------------------------------------------------ queue order and handover
  reset({ queue: 'alice\nbob\n' })
  r = cases.notFirst = attempt('bob')
  p.check('a free lock is not taken by a caller behind another name in the queue; nothing changes',
    !r.ran && /alice/.test(r.error ?? '') && !r.after.lock && r.after.queueText === 'alice\nbob\n', slim(r))

  reset({ queue: 'alice\r\nbob\r\n' })
  r = cases.first = attempt('alice')
  p.check('the first queued name takes the free lock and only its line goes',
    r.ran && /^alice /.test(r.during?.owner ?? '') && r.during?.queueText === 'bob\r\n', slim(r))
  p.check('when the build ends the lock goes to the next queued name (owner.txt names them, their line goes) and the caller is told to mail them',
    r.after.lock && /^bob .*handed over by alice/.test(r.after.owner ?? '') && r.after.queue.length === 0
      && /send bob an orgtree_message "build lock is yours"/.test(r.said) && /bob/.test(String(r.out?.lock ?? '')), slim(r))

  reset({ owner: `bob ${iso()} handed over by alice`, queue: 'carol\n' })
  r = cases.handed = attempt('bob')
  p.check('a lock handed over to the caller builds at once (owner.txt rewritten for the build) and then goes on to the next name',
    r.ran && /^bob .*proof build/.test(r.during?.owner ?? '') && /^carol .*handed over by bob/.test(r.after.owner ?? '') && r.after.queue.length === 0, slim(r))

  reset({ owner: `dave ${iso()} claimed by dave's watchdog for a rig build (released within 2 minutes if unused)` })
  r = cases.claimed = attempt('dave')
  p.check('a lock claimed by the caller\'s own watchdog builds, and is removed afterwards when nobody is queued', r.ran && !r.after.lock, slim(r))

  const ERIN = `erin ${iso()} cargo test -p orgtree-engine`
  reset({ owner: ERIN, queue: 'frank\n' })
  r = cases.foreign = attempt('frank')
  p.check('a fresh lock of another agent is refused and left alone', !r.ran && /held/.test(r.error ?? '') && r.after.owner === ERIN && r.after.queue.join() === 'frank', slim(r))

  reset({ queue: 'gina\nhank\n' })
  r = cases.failed = attempt('gina', { build: () => { throw new Error('cargo build of the engine failed') } })
  p.check('a failed build still hands the lock to the next queued name',
    r.ran && /cargo build of the engine failed/.test(r.error ?? '') && /^hank .*handed over by gina/.test(r.after.owner ?? '') && r.after.queue.length === 0, slim(r))

  // ------------------------------------------------------------ stale locks
  // a "build process": a copy of node running from under the build folder (as a build script would)
  const exe = path.join(root, 'ivan', 'debug', 'build', 'proof-1234', 'build-script-build.exe')
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.copyFileSync(process.execPath, exe)
  busy = spawn(exe, ['-e', 'setTimeout(() => {}, 300000)'], { stdio: 'ignore', windowsHide: true })
  const seen = await waitFor(() => lib.processesUnder(root).some(x => x.ProcessId === busy.pid), 30000)
  const IVAN = `ivan ${iso(40 * MIN)} rig build into ${path.join(root, 'ivan')}`
  reset({ owner: IVAN, ownerAgeMs: 40 * MIN })
  r = cases.staleBusy = attempt('jack')
  p.check('a stale lock (owner.txt 40 min old) is left alone while a build process runs in the build folder, and the refusal names it',
    seen && !r.ran && /alive/.test(r.error ?? '') && /build-script-build/.test(r.error ?? '') && r.after.owner === IVAN, { seen, ...slim(r) })

  busy.kill()
  await new Promise(resolve => { if (busy.exitCode !== null || busy.signalCode !== null) resolve(); else busy.once('exit', resolve) })
  await waitFor(() => !lib.processesUnder(root).length, 30000)
  busy = null
  reset({ owner: IVAN, ownerAgeMs: 40 * MIN })
  r = cases.staleFree = attempt('jack')
  p.check('with no build process left, a stale lock is cleared for a caller with nobody ahead, who builds', r.ran && /^jack /.test(r.during?.owner ?? '') && !r.after.lock, slim(r))

  const KATE = `kate ${iso(45 * MIN)} gradle assembleDebug`
  reset({ owner: KATE, ownerAgeMs: 45 * MIN, queue: 'liam\nmia\n' })
  r = cases.staleQueued = attempt('mia')
  p.check('a stale lock goes to the first queued name, not to a caller further back, who does not build and is told to mail them',
    !r.ran && /^liam .*handed over by mia/.test(r.after.owner ?? '') && r.after.queue.join() === 'mia'
      && /send liam an orgtree_message "build lock is yours"/.test(`${r.error}\n${r.said}`), slim(r))

  // ------------------------------------------------------------ a lock taken meanwhile; RAM; queue text
  reset()
  const OTTO = `otto ${iso()} took over a stale lock`
  r = cases.takenMeanwhile = attempt('nora', { build: () => fs.writeFileSync(OWNER, OTTO + '\n') })
  p.check('a lock someone else took during the build stays theirs', r.ran && r.after.lock && r.after.owner === OTTO, slim(r))

  reset({ queue: 'pia\nquinn\n' })
  r = cases.ramFree = attempt('pia', { ram: 1.5 })
  p.check('short of RAM (1.5 GB), a free lock is not taken and the caller stays first',
    !r.ran && /RAM/.test(r.error ?? '') && !r.after.lock && r.after.queue.join() === 'pia,quinn', slim(r))

  const ROSA = `rosa ${iso()} handed over by quinn`
  reset({ owner: ROSA, queue: 'sam\n' })
  r = cases.ramHeld = attempt('rosa', { ram: 1.5 })
  p.check('short of RAM under a lock handed over to it, the caller keeps the lock and is told so',
    !r.ran && /RAM/.test(r.error ?? '') && /still hold/.test(r.error ?? '') && r.after.owner === ROSA && r.after.queue.join() === 'sam', slim(r))

  reset({ queue: '\r\n  tess  \r\n\r\numa\r\n' })
  r = cases.queueText = attempt('tess')
  p.check('blank lines and spaces in the queue are ignored; the lines left keep their CR/LF endings',
    r.ran && r.during?.queueText === '\r\n\r\numa\r\n' && /^uma .*handed over by tess/.test(r.after.owner ?? ''), slim(r))

  // ------------------------------------------------------------ defaults
  /** What a child with this environment (ORGTREE_RIG_HOME and ORGTREE_BUILD_LOCK unset unless given) gets. */
  const defaults = extra => {
    const env = { ...process.env, ORGTREE_AGENT: 'proof-agent', ...extra }
    for (const k of ['ORGTREE_RIG_HOME', 'ORGTREE_BUILD_LOCK']) if (!(k in extra)) delete env[k]
    const child = spawnSync(process.execPath, [SELF, '--defaults'], { env, encoding: 'utf8', windowsHide: true, timeout: 60000 })
    try { return JSON.parse(child.stdout.trim().split(/\r?\n/).pop()) } catch { return { status: child.status, stderr: child.stderr?.slice(-500) } }
  }
  const d = cases.defaults = defaults({})
  if (fs.existsSync(WORK)) {
    p.check('without ORGTREE_RIG_HOME the rig home is the caller\'s own D:\\orgtree-work\\rig\\<agent>', same(d?.home, path.join(WORK, 'rig', 'proof-agent')), d)
    p.check('without ORGTREE_BUILD_LOCK the lock is D:\\orgtree-work\\cargo-target\\build.lock with the queue beside it',
      same(d?.lock?.lock, path.join(WORK, 'cargo-target', 'build.lock')) && same(d?.lock?.queue, path.join(WORK, 'cargo-target', 'build.queue.txt')), d)
    const shared = cases.sharedHome = defaults({ ORGTREE_RIG_HOME: path.join(WORK, 'rig') })
    p.check('the shared D:\\orgtree-work\\rig is refused as a rig home', !shared.home && /every agent's rig home/.test(shared.homeError ?? ''), shared)
  } else p.note('no D:\\orgtree-work here: the D: defaults are not checked', cases.defaults)
  const parent = path.join(root, 'parent-home')
  fs.mkdirSync(path.join(parent, 'someone', 'pg'), { recursive: true })
  const nested = cases.nestedHome = defaults({ ORGTREE_RIG_HOME: parent })
  p.check('a rig home with another rig home inside it is refused, naming it', !nested.home && /other rig homes are inside it \(someone\)/.test(nested.homeError ?? ''), nested)
  const prevHome = process.env.ORGTREE_RIG_HOME
  process.env.ORGTREE_RIG_HOME = path.join(home, 'tmp', 'some-other-home')
  const named = lib.rigHome()
  if (prevHome === undefined) delete process.env.ORGTREE_RIG_HOME; else process.env.ORGTREE_RIG_HOME = prevHome
  p.check('ORGTREE_RIG_HOME still names the rig home', same(named, path.join(home, 'tmp', 'some-other-home')), { named })

  const target = v => {
    const prev = process.env.CARGO_TARGET_DIR
    if (v === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = v
    try { return { ok: lib.cargoTarget() } } catch (e) { return { error: e.message } } finally {
      if (prev === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = prev
    }
  }
  const t = cases.cargoTarget = { unset: target(undefined), c: target('C:\\cargo-target\\x'), e: target('E:\\cargo-target\\x'), d: target(path.join(WORK, 'cargo-target', 'x')) }
  if (fs.existsSync(WORK)) {
    p.check('CARGO_TARGET_DIR unset is refused with a D:\\orgtree-work example; on C: or E: it is refused; on D: it is taken',
      /orgtree-work\\cargo-target/.test(t.unset.error ?? '') && !!t.c.error && !!t.e.error && same(t.d.ok, path.join(WORK, 'cargo-target', 'x')), t)
  }
} finally {
  if (busy) busy.kill()
  if (agent === undefined) delete process.env.ORGTREE_AGENT; else process.env.ORGTREE_AGENT = agent
  p.file('cases.json', cases)
  await sleep(500)
  try { fs.rmSync(root, { recursive: true, force: true }) } catch (e) { p.note(`could not remove ${root}: ${e.message}`) }
}

const out = p.summary()
console.log(JSON.stringify(out, null, 2))
if (!out.passed) process.exitCode = 1
