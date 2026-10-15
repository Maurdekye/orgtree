// tools/rig/lib.mjs: the test rig's shared library (docs/rust-engine/test-rig.md).
//
// A rig run is one throwaway data root under ORGTREE_RIG_HOME (default
// D:\orgtree-work\rig\<agent>) holding its own PostgreSQL cluster, a debug engine in rig
// mode (SAFE_START, fake home, fake CLIs, /api/rig/tool) kept alive by a
// small keeper process, the fake CLI's scenario and logs. Nothing here reads
// or writes the live data folder, the live cluster or the user's profile.
// Node built-ins only: no npm install is needed to use the rig.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RIG_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(RIG_DIR, '..', '..')
export const TOKEN_HEADER = 'X-Orgtree-Desktop-Token'
export const PG_VERSION = '18.6-4'
/** Ephemeral work (build output, the build lock, rig runs) lives on the SSD
 * (team rule 2026-10-10: E: is a slow disk holding only the repositories). */
export const WORK_ROOT = 'D:\\orgtree-work'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lower = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
const inside = (child, parent) => lower(child) === lower(parent) || lower(child).startsWith(lower(parent) + '\\')

/** Every agent's rig home sits in here, one folder each (D:\orgtree-work\rig\<agent>). */
export const RIG_HOMES = path.join(WORK_ROOT, 'rig')
/** What the rig itself keeps in a home: any other folder holding runs or pg is another rig home. */
const HOME_FOLDERS = new Set(['runs', 'pg', 'bin', 'evidence', 'legacy', 'tmp', 'ui'])

/** The rig home: ORGTREE_RIG_HOME, else the caller's own folder in RIG_HOMES
 * (on a machine without D:\orgtree-work, E:\orgtree-rig or the temp folder).
 * A home never holds another agent's: cleanup kills what runs in its home
 * that none of its runs own, so the shared parent, or any folder with
 * another rig home inside it, is refused. */
export function rigHome() {
  const fromEnv = process.env.ORGTREE_RIG_HOME
  const home = fromEnv ? path.resolve(fromEnv)
    : fs.existsSync(WORK_ROOT) ? path.join(RIG_HOMES, me().replace(/[^A-Za-z0-9._-]+/g, '-'))
    : fs.existsSync('E:\\') ? 'E:\\orgtree-rig' : path.join(os.tmpdir(), 'orgtree-rig')
  assertSafeRoot(home)
  if (lower(home) === lower(RIG_HOMES)) throw new Error(`refusing ${home} as a rig home: every agent's rig home is in it; use ${RIG_HOMES}\\<agent>`)
  let children = []
  try { children = fs.readdirSync(home, { withFileTypes: true }) } catch {}
  const others = children.filter(e => e.isDirectory() && !HOME_FOLDERS.has(e.name.toLowerCase())
    && ['runs', 'pg'].some(sub => fs.existsSync(path.join(home, e.name, sub))))
  if (others.length) throw new Error(`refusing ${home} as a rig home: other rig homes are inside it (${others.map(e => e.name).join(', ')}), and its cleanup would kill their processes`)
  return home
}

/** The live Orgtree data folders: a rig root may never sit inside one. */
export function liveRoots() {
  const roots = []
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'Orgtree v2'), path.join(process.env.APPDATA, 'Orgtree'))
  roots.push(path.join(os.homedir(), 'AppData', 'Roaming', 'Orgtree v2'), path.join(os.homedir(), 'AppData', 'Roaming', 'Orgtree'))
  if (process.env.ORGTREE_V2_DATA) roots.push(process.env.ORGTREE_V2_DATA)
  return roots
}

export function assertSafeRoot(dir) {
  const resolved = path.resolve(dir)
  if (path.parse(resolved).root.toLowerCase() === lower(resolved) + '\\') throw new Error(`refusing a drive root as the rig home: ${resolved}`)
  for (const live of liveRoots()) {
    if (inside(resolved, live) || inside(live, resolved)) throw new Error(`refusing ${resolved}: it overlaps the live Orgtree data folder ${live}`)
  }
  if (inside(resolved, REPO)) throw new Error(`refusing ${resolved}: rig data never goes inside the repository`)
}

// ------------------------------------------------------------ processes (Windows)

function powershell(script, timeout = 90000) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout })
  if (r.error) throw r.error
  return r.stdout.trim()
}

/** Processes matching a PowerShell Where-Object condition on Win32_Process. */
export function processes(where) {
  const out = powershell(`$p = @(Get-CimInstance Win32_Process | Where-Object { ${where} } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine); ConvertTo-Json -InputObject $p -Compress -Depth 3`)
  if (!out) return []
  const v = JSON.parse(out)
  return Array.isArray(v) ? v : [v]
}

const psQuote = s => `'${String(s).replace(/'/g, "''")}'`

/** Every process whose executable lives under one of `dirs` (engine copies, postgres, fake CLIs). */
export function processesUnder(...dirs) {
  return processes(dirs.map(d => `($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith(${psQuote(lower(d) + '\\')}))`).join(' -or '))
}

export function alive(pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

export function killTree(pid) {
  if (!pid || !alive(pid)) return false
  spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' })
  return true
}

export function freeRamGB() {
  const out = powershell('(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory')
  return Number(out) / 1024 / 1024
}

/** One heavy build at a time machine-wide, in queue order (team rules
 * 2026-10-09 and 2026-10-10). The lock is a folder (mkdir is atomic) holding
 * owner.txt ("<name> <UTC> <what>"); agents waiting for it line up in
 * build.queue.txt beside it, one name per line.
 * - A free lock is taken only when the queue is empty or names the caller
 *   first, and the caller's line goes. A lock whose owner.txt already names
 *   the caller (handed over, or claimed by the caller's own watchdog) is the
 *   caller's: it builds under it.
 * - When the build ends, failed or not, the lock goes to the first queued
 *   name (owner.txt rewritten, its line dropped; the rig cannot send org
 *   mail, so the caller must tell that agent "build lock is yours") or, with
 *   nobody waiting, the folder goes. A lock someone else took meanwhile is
 *   left alone.
 * - An owner.txt older than 30 minutes with no build process alive in the
 *   build folder is stale: it is cleared and goes by the queue the same way.
 * - A lock folder whose owner.txt starts with MOVED marks where the lock used
 *   to live: it is never taken, cleared or written.
 * - A build needs BUILD_RAM_GB free, checked before a free lock is taken (a
 *   caller short of RAM stays first) and before building under a held one
 *   (which the caller keeps). */
export const BUILD_RAM_GB = 3
const BUILD_LOCK_STALE_MS = 30 * 60 * 1000

/** The lock folder (ORGTREE_BUILD_LOCK names another) and the queue beside it. */
export function buildLockPaths() {
  const lock = path.resolve(process.env.ORGTREE_BUILD_LOCK || path.join(WORK_ROOT, 'cargo-target', 'build.lock'))
  return { lock, owner: path.join(lock, 'owner.txt'), queue: path.join(path.dirname(lock), 'build.queue.txt') }
}

const sameName = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** The queue's names, first first (blank lines and CR/LF endings tolerated). */
export function buildQueue(queue = buildLockPaths().queue) {
  let text = ''
  try { text = fs.readFileSync(queue, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
}

/** Drops the first line naming `name`; every other line stays as it was. */
function dropFromQueue(queue, name) {
  let text
  try { text = fs.readFileSync(queue, 'utf8') } catch (e) { if (e.code === 'ENOENT') return false; throw e }
  const lines = text.split(/(?<=\n)/)
  const i = lines.findIndex(l => sameName(l.trim(), name))
  if (i < 0) return false
  lines.splice(i, 1)
  fs.writeFileSync(queue, lines.join(''))
  return true
}

/** owner.txt's text and time (the folder's while owner.txt is not written yet); null when there is no lock. */
function lockOwner({ lock, owner }) {
  try { return { text: fs.readFileSync(owner, 'utf8').trim(), at: fs.statSync(owner).mtimeMs } } catch {}
  try { return { text: '', at: fs.statSync(lock).mtimeMs } } catch { return null }
}

/** Build processes alive in `dir`: a cargo or rustc naming it on its command
 * line (rustc's --out-dir does), or anything running from under it (build
 * scripts, test binaries). */
export function buildProcessesIn(dir) {
  return processes(`($_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith(${psQuote(lower(dir) + '\\')})) -or `
    + `($_.Name -match '^(cargo|rustc)\\.exe$' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains(${psQuote(lower(dir))}))`)
}

const handedLine = next => `HANDED THE BUILD LOCK TO ${next}: send ${next} an orgtree_message "build lock is yours" now (team rule)`

/** Takes the lock for `name` in queue order: 'taken' or 'held' (already the caller's), else throws why not. */
function acquireBuildLock(paths, name, ramShort) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = lockOwner(paths)
    if (!cur) {
      const queue = buildQueue(paths.queue)
      if (queue.length && !sameName(queue[0], name)) {
        throw new Error(`the build lock is free but ${queue[0]} is first in ${paths.queue}: append ${name} to it once and wait your turn (team rule)`)
      }
      const short = ramShort()
      if (short) throw new Error(`${short}; the lock was not taken`)
      try { fs.mkdirSync(paths.lock) } catch (e) { if (e.code === 'EEXIST') continue; throw e }
      fs.writeFileSync(paths.owner, `${name} ${new Date().toISOString()} taking the lock\n`)
      if (queue.length) dropFromQueue(paths.queue, name)
      return 'taken'
    }
    if (/^MOVED\b/.test(cur.text)) throw new Error(`${paths.lock} is a marker, not a lock (never take or remove it): ${cur.text}`)
    if (sameName(cur.text.split(/\s+/)[0], name)) {
      const short = ramShort()
      if (short) throw new Error(`${short}; you still hold the build lock (${paths.lock}): build when RAM frees, or hand it over`)
      return 'held'
    }
    const age = Date.now() - cur.at
    if (age < BUILD_LOCK_STALE_MS) throw new Error(`the build lock is held (${cur.text || 'no owner.txt yet'}): wait for ${paths.lock} to go, in queue order`)
    const dir = path.dirname(paths.lock)
    const busy = buildProcessesIn(dir)
    if (busy.length) {
      throw new Error(`the build lock looks stale (owner.txt ${Math.round(age / 60000)} min old: ${cur.text}) but build processes are alive in ${dir}: `
        + busy.map(p => `${p.Name} ${p.ProcessId}`).join(', ') + '; leave it')
    }
    const queue = buildQueue(paths.queue)
    if (!queue.length || sameName(queue[0], name)) {
      // the stale lock would come to the caller anyway: clear it and take it in queue order
      fs.rmSync(paths.lock, { recursive: true, force: true })
      console.error(`build lock: cleared a stale lock (${Math.round(age / 60000)} min old: ${cur.text})`)
      continue
    }
    fs.writeFileSync(paths.owner, `${queue[0]} ${new Date().toISOString()} handed over by ${name} (stale lock of: ${cur.text})\n`)
    dropFromQueue(paths.queue, queue[0])
    console.error(`build lock: ${handedLine(queue[0])}`)
    throw new Error(`the build lock was stale and went to ${queue[0]}, first in the queue (${handedLine(queue[0])}); append ${name} to the queue once and wait your turn`)
  }
  throw new Error(`the build lock kept changing hands: wait for ${paths.lock} to go, in queue order`)
}

/** Gives up the lock written as `mine`: to the first queued name, or removed when nobody waits. */
function releaseBuildLock(paths, name, mine) {
  const cur = lockOwner(paths)
  if (!cur || cur.text !== mine) {
    const left = `the build lock is no longer ${name}'s (${cur ? cur.text || 'no owner.txt' : 'gone'}): left as it is`
    console.error(`build lock: ${left}`)
    return left
  }
  const queue = buildQueue(paths.queue)
  if (!queue.length) {
    fs.rmSync(paths.lock, { recursive: true, force: true })
    return 'released (nobody queued)'
  }
  const next = queue[0]
  dropFromQueue(paths.queue, next)
  if (sameName(next, name)) {
    fs.writeFileSync(paths.owner, `${name} ${new Date().toISOString()} kept: first in the queue again\n`)
    return `kept: ${name} was first in the queue again`
  }
  fs.writeFileSync(paths.owner, `${next} ${new Date().toISOString()} handed over by ${name}\n`)
  console.error(`build lock: ${handedLine(next)}`)
  return handedLine(next)
}

/** Runs `fn` holding the build lock (see above): { result, lock } where
 * `lock` says where the lock went afterwards. */
export function withBuildLock(what, fn, { freeRam = freeRamGB } = {}) {
  const paths = buildLockPaths()
  const name = me()
  const ramShort = () => {
    const free = freeRam()
    return free < BUILD_RAM_GB ? `only ${free.toFixed(1)} GB RAM free; team rule: build with the lock held and at least ${BUILD_RAM_GB} GB free` : null
  }
  const how = acquireBuildLock(paths, name, ramShort)
  const mine = `${name} ${new Date().toISOString()} ${what}${how === 'held' ? ' (under a lock handed over or claimed earlier)' : ''}`.trim()
  fs.writeFileSync(paths.owner, mine + '\n')
  let result
  try { result = fn() } catch (e) { releaseBuildLock(paths, name, mine); throw e }
  return { result, lock: releaseBuildLock(paths, name, mine) }
}

// ------------------------------------------------------------ binaries

export function cargoTarget() {
  const t = process.env.CARGO_TARGET_DIR
  const onD = fs.existsSync(WORK_ROOT)
  const example = 'C:/orgtree-build/<agent>'
  if (!t) throw new Error(`set CARGO_TARGET_DIR to your own build folder (team rule), e.g. ${example}`)
  const resolved = path.resolve(t)
  if (/^c:/i.test(resolved) && !/^c:\\orgtree-build\\/i.test(resolved)) {
    throw new Error(`CARGO_TARGET_DIR is on drive C: (${t}); only paths under C:/orgtree-build/<agent> are allowed there, e.g. ${example}`)
  }
  if (onD && /^e:/i.test(resolved)) throw new Error(`CARGO_TARGET_DIR is on drive E: (${t}); team rule 2026-10-10: E: holds only the repositories, build output goes in ${example}`)
  return resolved
}

export function engineExe(explicit) {
  const exe = explicit || process.env.ORGTREE_RIG_ENGINE || path.join(cargoTarget(), 'debug', 'orgtree-engine.exe')
  if (!fs.existsSync(exe)) throw new Error(`no engine at ${exe}: run \`node tools/rig/rig.mjs build\` first`)
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (!/\(dev\)/.test(v.stdout || '')) throw new Error(`${exe} is not a debug (dev) engine build (${(v.stdout || v.stderr || '').trim()}); the rig needs one`)
  return exe
}

/** The mail hub a run hosts (`up --hub [exe]`): the named binary, else
 * ORGTREE_RIG_HUB_BIN, else an orgtree-mailhub.exe in your cargo target
 * (release first), else the submodule's own release build. */
export function hubExe(explicit) {
  const named = typeof explicit === 'string' ? explicit : process.env.ORGTREE_RIG_HUB_BIN
  const target = (() => { try { return cargoTarget() } catch { return null } })()
  const candidates = named ? [named] : [target && path.join(target, 'release', 'orgtree-mailhub.exe'), target && path.join(target, 'debug', 'orgtree-mailhub.exe'),
    path.join(REPO, 'engine', 'mailhub', 'target', 'release', 'orgtree-mailhub.exe')]
  const exe = candidates.filter(Boolean).find(p => fs.existsSync(p))
  if (!exe) throw new Error(`no mail hub binary found (looked in ${candidates.filter(Boolean).join(', ')}); pass up --hub <orgtree-mailhub.exe>`)
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (!/^orgtree-mailhub /.test(v.stdout || '')) throw new Error(`${exe} is not an orgtree-mailhub binary (${(v.stdout || v.stderr || '').trim()})`)
  return exe
}

/** A loopback port nobody listens on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** The installed Claude Code and Codex CLIs, for a run whose agents drive the
 * REAL harnesses (`up --real-cli`): Claude Code's native binary from its npm
 * package, and Codex's bin folder (codex.exe and the helpers beside it).
 * ORGTREE_RIG_REAL_CLAUDE / ORGTREE_RIG_REAL_CODEX name others. */
export function realCliBins() {
  const appdata = process.env.APPDATA ?? ''
  const local = process.env.LOCALAPPDATA ?? ''
  const first = (...c) => c.filter(Boolean).find(p => fs.existsSync(p))
  const claude = first(process.env.ORGTREE_RIG_REAL_CLAUDE,
    path.join(appdata, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'))
  const codex = first(process.env.ORGTREE_RIG_REAL_CODEX,
    path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'))
  if (!claude) throw new Error('--real-cli: no installed Claude Code (set ORGTREE_RIG_REAL_CLAUDE)')
  if (!codex) throw new Error('--real-cli: no installed Codex (set ORGTREE_RIG_REAL_CODEX)')
  return { claude, codex }
}

export function fakeCliExe(explicit) {
  const exe = explicit || process.env.ORGTREE_RIG_FAKECLI || path.join(cargoTarget(), 'debug', 'orgtree-fakecli.exe')
  if (!fs.existsSync(exe)) throw new Error(`no fake CLI at ${exe}: run \`node tools/rig/rig.mjs build\` first`)
  return exe
}

function mainRepo() {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: REPO, encoding: 'utf8', windowsHide: true })
  return r.status === 0 ? path.dirname(r.stdout.trim()) : null
}

/** The rust-engine integration checkout, in its home on D: (2026-10-10) or its old one beside the main repository. */
function integrationCheckouts(main) {
  return [path.join(WORK_ROOT, 'worktrees', 'rust-engine'), main && path.join(main, '.worktrees', 'rust-engine')].filter(Boolean)
}

/** PostgreSQL binaries, copied once into the rig home (never run in place:
 * a running postgres.exe would block an installer from replacing its own). */
export function pgBin(home) {
  const cached = path.join(home, 'pg', PG_VERSION)
  if (fs.existsSync(path.join(cached, 'bin', 'postgres.exe'))) return path.join(cached, 'bin')
  const main = mainRepo()
  const sources = [
    process.env.ORGTREE_RIG_PG_SOURCE,
    path.join(REPO, 'engine', 'postgresql'),
    main && path.join(main, 'engine', 'postgresql'),
    ...integrationCheckouts(main).map(d => path.join(d, 'engine', 'postgresql')),
    'C:\\Program Files\\Orgtree\\resources\\engine\\postgresql',
  ].filter(Boolean)
  const source = sources.find(s => fs.existsSync(path.join(s, 'bin', 'postgres.exe')) && fs.existsSync(path.join(s, 'bin', 'initdb.exe')))
  if (!source) throw new Error(`no PostgreSQL binaries found (looked in ${sources.join(', ')}); set ORGTREE_RIG_PG_SOURCE`)
  const staging = cached + '.partial'
  fs.rmSync(staging, { recursive: true, force: true })
  for (const sub of ['bin', 'lib', 'share']) fs.cpSync(path.join(source, sub), path.join(staging, sub), { recursive: true })
  fs.renameSync(staging, cached)
  return path.join(cached, 'bin')
}

/** A freshly initialized cluster to copy into each run (initdb takes ~40 s
 * on this machine; a copy takes a few). Made exactly as the engine's own
 * `pg::initdb` makes one: same role, auth, encoding, locale and secrets. */
export function pgTemplate(home, bin) {
  const dir = path.join(home, 'pg', `template-${PG_VERSION}`)
  if (fs.existsSync(path.join(dir, 'cluster', 'data', 'PG_VERSION'))) return path.join(dir, 'cluster')
  const staging = dir + '.partial'
  fs.rmSync(staging, { recursive: true, force: true })
  const secrets = path.join(staging, 'cluster', 'secrets')
  fs.mkdirSync(secrets, { recursive: true })
  const admin = crypto.randomBytes(32).toString('hex'), runtime = crypto.randomBytes(32).toString('hex')
  const pwfile = path.join(secrets, '.initdb-pw.tmp')
  fs.writeFileSync(pwfile, admin)
  const r = spawnSync(path.join(bin, 'initdb.exe'), ['-D', path.join(staging, 'cluster', 'data'), '-U', 'orgtree_admin', `--pwfile=${pwfile}`,
    '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-instructions'], { encoding: 'utf8', windowsHide: true, timeout: 300000 })
  fs.rmSync(pwfile, { force: true })
  if (r.status !== 0) throw new Error(`initdb for the rig template failed: ${r.stderr || r.error}`)
  fs.writeFileSync(path.join(secrets, 'credentials.json'), JSON.stringify({ orgtree_admin: admin, orgtree_runtime: runtime }, null, 2))
  fs.writeFileSync(path.join(secrets, 'pgpass.conf'), `127.0.0.1:*:*:orgtree_admin:${admin}\n127.0.0.1:*:*:orgtree_runtime:${runtime}\n`)
  fs.renameSync(staging, dir)
  return path.join(dir, 'cluster')
}

/** The renderer bundle the scratch engine serves. */
export function uiDir(explicit) {
  const main = mainRepo()
  const candidates = [explicit, process.env.ORGTREE_RIG_UI, path.join(REPO, 'dist', 'renderer'), 'C:\\Program Files\\Orgtree\\resources\\ui',
    ...integrationCheckouts(main).map(d => path.join(d, 'dist', 'renderer'))]
  return candidates.filter(Boolean).find(d => fs.existsSync(path.join(d, 'index.html'))) || null
}

/** Electron, run where it is installed (never linked or copied). */
export function electronExe(explicit) {
  const main = mainRepo()
  const candidates = [explicit, process.env.ORGTREE_RIG_ELECTRON, path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
    main && path.join(main, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ...integrationCheckouts(main).map(d => path.join(d, 'node_modules', 'electron', 'dist', 'electron.exe'))]
  const exe = candidates.filter(Boolean).find(p => fs.existsSync(p))
  if (!exe) throw new Error('no electron.exe found; set ORGTREE_RIG_ELECTRON')
  return exe
}

// ------------------------------------------------------------ runs

export function runsDir(home = rigHome()) { return path.join(home, 'runs') }
// Windows refuses to open or replace a file another process (a reader, often a
// virus scanner) holds for a moment: run.json reads and writes retry for up to
// a second (a keeper died of one unretried EPERM, 2026-10-10).
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
function retrying(fn) {
  for (let i = 0; ; i++) {
    try { return fn() } catch (e) {
      if (i >= 40 || !TRANSIENT.has(e.code)) throw e
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
    }
  }
}
export function readRun(dir) {
  try { return JSON.parse(retrying(() => fs.readFileSync(path.join(dir, 'run.json'), 'utf8'))) } catch { return null }
}
export function writeRun(dir, patch) {
  const file = path.join(dir, 'run.json')
  const cur = readRun(dir)
  // a merge over an unread file would keep only the patch (token, url and pids lost)
  if (!cur && fs.existsSync(file)) throw new Error(`${file} cannot be read; not replacing it`)
  const next = { ...(cur || {}), ...patch, statusAt: new Date().toISOString() }
  const tmp = path.join(dir, `run.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  retrying(() => fs.renameSync(tmp, file))
  return next
}
export function listRuns(home = rigHome()) {
  const d = runsDir(home)
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).map(name => path.join(d, name)).filter(p => fs.existsSync(path.join(p, 'run.json')) || fs.existsSync(path.join(p, 'data')))
    .map(dir => ({ dir, run: readRun(dir) }))
}
export function touch(dir) {
  try { fs.writeFileSync(path.join(dir, 'heartbeat'), new Date().toISOString()) } catch { /* the run is gone */ }
}

/** The run a command means: --run <id|dir>, else the caller's own newest
 * live one. Several agents share the rig: another agent's run is never picked
 * by default. */
export function pickRun(which) {
  const runs = listRuns()
  if (which) {
    const hit = runs.find(r => path.basename(r.dir) === which || lower(r.dir) === lower(which))
    if (!hit) throw new Error(`no rig run ${which}`)
    return hit.dir
  }
  const ready = runs.filter(r => r.run?.status === 'ready').sort((a, b) => String(b.run.created).localeCompare(String(a.run.created)))
  if (!ready.length) throw new Error('no rig run is up: `node tools/rig/rig.mjs up`')
  const mine = ready.filter(r => r.run.by === me())
  if (!mine.length) {
    throw new Error(`none of the live rig runs is yours (${me()}); name one with --run: `
      + ready.map(r => `${path.basename(r.dir)} (${r.run.by ?? '?'})`).join(', '))
  }
  return mine[0].dir
}

/** A run folder whose start never wrote run.json (it failed, or an older
 * rig's cleanup took part of it): `down --run <id>` removes it. Only a folder
 * named like a run, directly in the runs folder, qualifies. */
export function halfMadeRun(which, home = rigHome()) {
  if (!which || !/^([a-z0-9-]+-)?\d{8}-\d{6}-[0-9a-f]{4}$/i.test(path.basename(which))) return null
  const dir = path.join(runsDir(home), path.basename(which))
  if (lower(path.dirname(dir)) !== lower(runsDir(home)) || !fs.existsSync(dir) || fs.existsSync(path.join(dir, 'run.json'))) return null
  return dir
}

export function newRunId(name) {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  return `${name ? name.replace(/[^a-z0-9-]/gi, '').slice(0, 24) + '-' : ''}${t}-${crypto.randomBytes(2).toString('hex')}`
}

// ------------------------------------------------------------ the rig handle

export class Rig {
  constructor(dir) {
    this.dir = dir
    this.run = readRun(dir)
    if (!this.run) throw new Error(`${dir} is not a rig run`)
  }

  static attach(which) { return new Rig(pickRun(which)) }

  get url() { return this.run.url }
  get token() { return this.run.token }
  get org() { return this.run.org }
  get data() { return path.join(this.dir, 'data') }
  get fakeDir() { return path.join(this.dir, 'fakecli') }
  /** The mail hub this run hosts (`up --hub`), on loopback. */
  get hubUrl() { return this.run.hubPort ? `http://127.0.0.1:${this.run.hubPort}` : null }

  refresh() { this.run = readRun(this.dir); return this.run }

  async api(method, route, body) {
    touch(this.dir)
    const res = await fetch(this.url + route, {
      method, headers: { [TOKEN_HEADER]: this.token, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error(`${method} ${route} → ${res.status}: ${json?.detail ?? text.slice(0, 300)}`)
      err.status = res.status
      err.body = json ?? text
      throw err
    }
    return json ?? text
  }

  /** Any orgtree_* tool as a live agent (the engine's test-only route). */
  async tool(agent, tool, args = {}, { org = this.org, toolUseId } = {}) {
    return this.api('POST', '/api/rig/tool', { org, agent, tool, args, tool_use_id: toolUseId })
  }

  /** The user writes to an agent's desk (a waking message unless notice). */
  async userMail(agent, text, { notice = false, org = this.org } = {}) {
    return this.api('POST', `/api/orgs/${org}/nodes/${encodeURIComponent(agent)}/message`, { text, notice })
  }

  async op(body, { org = this.org } = {}) {
    return this.api('POST', `/api/orgs/${org}/ops`, body)
  }

  pgConn() {
    const cluster = path.join(this.data, 'pg', 'cluster')
    const attach = JSON.parse(fs.readFileSync(path.join(cluster, 'pg-attach.json'), 'utf8'))
    const creds = JSON.parse(fs.readFileSync(path.join(cluster, 'secrets', 'credentials.json'), 'utf8'))
    return { port: attach.port, password: creds.orgtree_admin }
  }

  /** Rows of a query against the scratch cluster's engine database. */
  sql(query, { db = 'orgtree_engine' } = {}) {
    touch(this.dir)
    const { port, password } = this.pgConn()
    const wrapped = `SELECT coalesce(json_agg(t), '[]'::json) FROM (${query.trim().replace(/;\s*$/, '')}) t`
    const r = spawnSync(path.join(this.run.pgBin, 'psql.exe'),
      ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'orgtree_admin', '-d', db, '-c', wrapped],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    if (r.status !== 0) throw new Error(`sql failed: ${(r.stderr || r.error || '').toString().trim()}\n${query}`)
    return JSON.parse(r.stdout.trim() || '[]')
  }

  one(query) { return this.sql(query)[0] ?? null }

  /** Run statements (DDL, writes) against a database of the run's cluster. */
  exec(statements, { db = 'orgtree_engine' } = {}) {
    touch(this.dir)
    const { port, password } = this.pgConn()
    const r = spawnSync(path.join(this.run.pgBin, 'psql.exe'),
      ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port), '-U', 'orgtree_admin', '-d', db, '-c', statements],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '10' } })
    if (r.status !== 0) throw new Error(`sql failed: ${(r.stderr || r.error || '').toString().trim()}\n${statements}`)
  }

  /** Stop the engine and start it again on the same data (a new keeper);
   * `{ hub }` swaps the hosted hub's binary while it is down. */
  async restart(opts) {
    await restartRun(this.dir, opts)
    return this.refresh()
  }

  /** Kill the engine at once, as an install or a crash does (its job takes
   * PostgreSQL and the CLIs with it); the keeper notes it and exits.
   * `restart()` brings the run back on the same data. */
  async crash({ timeout = 30000 } = {}) {
    // a restart follows: until it does, other agents' cleanup must not take the run
    writeRun(this.dir, { busy: new Date().toISOString() })
    const run = this.refresh()
    killTree(run.enginePid)
    await this.waitFor(() => !alive(run.keeperPid), { what: 'the keeper to see the engine die', timeout })
    return this.refresh()
  }

  /** Poll until fn() returns a truthy value (an empty array counts as
   * nothing yet); that value is returned. */
  async waitFor(fn, { timeout = 60000, every = 500, what = 'condition' } = {}) {
    const end = Date.now() + timeout
    let last
    while (Date.now() < end) {
      try { last = await fn(); if (last && !(Array.isArray(last) && last.length === 0)) return last } catch (e) { last = e }
      await sleep(every)
    }
    throw new Error(`timed out after ${timeout} ms waiting for ${what}${last instanceof Error ? ': ' + last.message : ''}`)
  }

  agentRow(name) {
    return this.one(`SELECT id, name, state, parent_id, halt, frozen, last_error, extra, session_id
                       FROM ot.agents WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${this.org}' AND state = 'active') AND name = '${name.replace(/'/g, "''")}'`)
  }

  turns(name) {
    return this.sql(`SELECT t.id, t.started_at, t.ended_at, t.killed, t.error, t.cost_usd FROM ot.turns t JOIN ot.agents a ON a.id = t.agent_id
                      JOIN ot.orgs o ON o.id = a.org_id WHERE o.slug = '${this.org}' AND a.name = '${name.replace(/'/g, "''")}' ORDER BY t.id`)
  }

  /** Wait until `name` has finished `count` turns and runs none. */
  async waitTurns(name, count, opts = {}) {
    return this.waitFor(() => {
      const t = this.turns(name)
      return t.filter(x => x.ended_at).length >= count && !t.some(x => !x.ended_at) ? t : null
    }, { what: `${name} to finish ${count} turn(s)`, timeout: 90000, ...opts })
  }

  /** The fake CLI's scenario for this run (read at every turn start). */
  scenario(obj) {
    fs.mkdirSync(this.fakeDir, { recursive: true })
    fs.writeFileSync(path.join(this.fakeDir, 'scenario.json'), JSON.stringify(obj, null, 2))
  }

  /** Every line the fake CLI logged for an agent. */
  fakeLog(agent) {
    const f = path.join(this.fakeDir, 'log', `${agent}.jsonl`)
    if (!fs.existsSync(f)) return []
    return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return { kind: 'unparsed', line: l } } })
  }

  /** The engine's own session logs (`YYYY-MM-DD_HH-MM-SS.log`, trace.rs), oldest
   *  first. Only those: other logs in the folder (codex-kills.log) sort after
   *  them and grow at the same time, so including one shifts every
   *  `engineLog().slice(offset)` a proof takes and cuts the start of its window. */
  engineLogFiles() {
    const d = path.join(this.data, 'diagnostics', 'logs')
    return fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.log$/.test(f)).map(f => path.join(d, f)).sort() : []
  }

  engineLog() { return this.engineLogFiles().map(f => fs.readFileSync(f, 'utf8')).join('\n') }

  /** Ask the keeper to stop the engine and remove the run. */
  async down({ keep = false, timeout = 90000 } = {}) {
    return stopRun(this.dir, { keep, timeout })
  }
}

// ------------------------------------------------------------ up / down

export function fakeHome(data) {
  const home = path.join(data, 'rig-home')
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  // signed in, as far as discovery can tell; no token, so no usage call can be made
  fs.writeFileSync(path.join(home, '.claude', '.credentials.json'), '{}')
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'rig@example.invalid' } }))
  // the Codex login, as discovery reads it: a ChatGPT sign-in with an unsigned id token naming the email
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url')
  const idToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'rig@example.invalid' })}.rig`
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: idToken } }))
  return home
}

/** Start a run: data root, keeper, engine (SAFE_START + rig mode). Resolves when ready. */
export async function startRun(opts = {}) {
  const home = rigHome()
  fs.mkdirSync(runsDir(home), { recursive: true })
  const engine = engineExe(opts.engine)
  const fake = fakeCliExe(opts.fakecli)
  const pg = pgBin(home)
  const ui = uiDir(opts.ui)
  const id = newRunId(opts.name)
  const dir = path.join(runsDir(home), id)
  const data = path.join(dir, 'data')
  assertSafeRoot(data)
  // run.json first: every `up` cleans up runs that look dead, and a folder
  // without one looks dead while its cluster is copied and its hook runs.
  // `busy` keeps the run live until its engine is ready.
  fs.mkdirSync(dir, { recursive: true })
  writeRun(dir, { id, created: new Date().toISOString(), status: 'starting', dir, by: me(), busy: new Date().toISOString() })
  try {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
    fs.mkdirSync(data, { recursive: true })
    fs.writeFileSync(path.join(data, '.orgtree-rig-root'), JSON.stringify({ rig: 1, created: new Date().toISOString(), run: id }))
    fakeHome(data)
    if (opts.legacy) fs.cpSync(opts.legacy, data, { recursive: true })
    // --initdb: let the engine create the cluster itself (its own first-start path)
    if (!opts.initdb && !fs.existsSync(path.join(data, 'pg', 'cluster'))) fs.cpSync(pgTemplate(home, pg), path.join(data, 'pg', 'cluster'), { recursive: true })
    // A rig cluster runs without fsync (coordinator 2026-10-10; never the app's
    // own cluster): surviving an OS crash is not under test, and with fsync on
    // a busy disk a stop's checkpoint outlasts the engine's wait, so the next
    // start fsyncs the whole cluster for minutes. `fsync: true` keeps it, for a
    // run that measures stops. (An --initdb run's cluster is made by the engine
    // at its first start and keeps the default.)
    const conf = path.join(data, 'pg', 'cluster', 'data', 'postgresql.conf')
    if (fs.existsSync(conf)) fs.appendFileSync(conf, `\n# orgtree test rig\nfsync = ${opts.fsync ? 'on' : 'off'}\n`)
    // a script's hook on the run's own cluster before the engine's first start (e.g. a legacy 3.x store)
    if (opts.prepare) await opts.prepare({ dir, data, pgBin: pg })
    // copies: a running engine never locks the developer's cargo output
    fs.copyFileSync(engine, path.join(dir, 'bin', 'orgtree-engine.exe'))
    // --real-cli: the installed harnesses, copied (a running copy never locks
    // the user's own install); their home is the run's fake one (keeper.mjs)
    if (opts.realCli) {
      const real = realCliBins()
      fs.copyFileSync(real.claude, path.join(dir, 'bin', 'claude.exe'))
      const codexDir = path.dirname(real.codex)
      for (const f of fs.readdirSync(codexDir).filter(f => f.toLowerCase().endsWith('.exe'))) {
        fs.copyFileSync(path.join(codexDir, f), path.join(dir, 'bin', f))
      }
    } else {
      fs.copyFileSync(fake, path.join(dir, 'bin', 'claude.exe'))
      fs.copyFileSync(fake, path.join(dir, 'bin', 'codex.exe'))
    }
    fs.copyFileSync(fake, path.join(dir, 'bin', 'agy.exe'))
    fs.copyFileSync(fake, path.join(dir, 'bin', 'opencode.exe'))
    fs.copyFileSync(fake, path.join(dir, 'bin', 'muse-bin-9.9.9-R0.exe'))
    // --real-muse <muse-bin-*.exe>: the Muse lane runs the installed Muse Code
    // binary (copied, so a running copy never locks the user's install, and
    // its command lines name this run). Only Muse: the other lanes keep their
    // fakes. Muse reads its own sign-in from the user's own Muse roots (the
    // user-authorized synthetic subscription tests, 2026-10-12 20:21Z); the
    // engine passes --contributor-mode off and never an API key.
    let realMuse = null
    if (opts.realMuse) {
      const src = path.resolve(opts.realMuse)
      if (!/^muse-bin-[\w.-]+\.exe$/i.test(path.basename(src)) || !fs.existsSync(src)) {
        throw new Error(`--real-muse: ${src} is not a Muse Code binary (muse-bin-<version>.exe, never its updater launcher)`)
      }
      realMuse = path.join(dir, 'bin', path.basename(src))
      fs.copyFileSync(src, realMuse)
    }
    // the fake Tailscale CLI (ORGTREE_TAILSCALE_BIN), scripted through rig-home\rig-tailscale
    fs.copyFileSync(path.join(RIG_DIR, 'fake-tailscale.cmd'), path.join(dir, 'bin', 'tailscale.cmd'))
    // --hub: the engine hosts this mail hub inside the run (its own role and
    // database in the run's cluster, a free loopback port) and the run's
    // network mail reaches it and nothing else
    let hub = null, hubPort = null
    if (opts.hub) {
      hub = path.join(dir, 'bin', 'orgtree-mailhub.exe')
      fs.copyFileSync(hubExe(opts.hub), hub)
      hubPort = await freePort()
      fs.writeFileSync(path.join(data, 'mailhub-hosting.json'), JSON.stringify({ version: 2, port: hubPort, bind: '127.0.0.1', name: 'rig hub',
        retention_days: null, public_listener: false, max_attachment_bytes: opts.hubMaxBytes ?? 1073741824 }, null, 2))
    }
    fs.mkdirSync(path.join(dir, 'fakecli', 'log'), { recursive: true })
    if (!fs.existsSync(path.join(dir, 'fakecli', 'scenario.json'))) {
      fs.writeFileSync(path.join(dir, 'fakecli', 'scenario.json'), JSON.stringify({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } }, null, 2))
    }
    writeRun(dir, {
      id, created: new Date().toISOString(), status: 'starting', dir, data, pgBin: pg, ui, engineSource: engine,
      token: crypto.randomBytes(32).toString('hex'), ttlMin: opts.ttlMin ?? 20, maxMin: opts.maxMin ?? 120, by: me(),
      // the engine's restart path (closing turns, waking agents) runs at every start
      recover: !!opts.recover,
      // the automatic wakes a safe start holds back, swept every N seconds (true: 5)
      reminders: opts.reminders || null,
      reminderPauseMs: opts.reminderPauseMs || null,
      hub, hubPort,
      // the agents' CLIs are the installed Claude Code and Codex (`up --real-cli`)
      realCli: !!opts.realCli,
      // the Muse lane's binary is the installed Muse Code, copied (`up --real-muse`)
      realMuse,
      // the engine logs no verbose call lines (`up --quiet-log`), as a release build by default
      quietLog: !!opts.quietLog,
      // the engine believes it runs under the boot task's S4U logon (`up --boot-isolated`)
      bootIsolated: !!opts.bootIsolated,
      // the engine's Session 0 answer, forced ('1' | '0'); null: measured
      session0: opts.session0 ?? null,
      // the "still unread" notice's threshold in seconds (the engine's is 10 min)
      steerLateS: opts.steerLateS || null,
      // the cap on idle CLI processes (the engine's is 64)
      maxParked: opts.maxParked || null,
    })
    touch(dir)
    await launchKeeper(dir, opts.timeout)
    return new Rig(dir)
  } catch (e) {
    // a start that failed is an ordinary dead run again: the next cleanup removes it
    try {
      const cur = readRun(dir)
      writeRun(dir, { busy: null, ...(cur?.status === 'starting' ? { status: 'failed', error: cur.error ?? e.message } : {}) })
    } catch { /* the folder is gone */ }
    throw e
  }
}

/** Start the run's keeper (which starts the engine) and wait until the
 * engine is ready. */
async function launchKeeper(dir, timeout = 240000) {
  const id = path.basename(dir)
  const log = fs.openSync(path.join(dir, 'keeper.log'), 'a')
  const keeper = spawn(process.execPath, [path.join(RIG_DIR, 'keeper.mjs'), dir], { detached: true, stdio: ['ignore', log, log], windowsHide: true, env: cleanEnv() })
  keeper.unref()
  fs.closeSync(log)
  writeRun(dir, { keeperPid: keeper.pid })
  const end = Date.now() + timeout
  try {
    for (;;) {
      const run = readRun(dir)
      if (run?.status === 'ready') break
      if (run?.status === 'failed' || run?.status === 'stopped') throw new Error(`rig run ${id} failed to start: ${run.error ?? run.status}\n(see ${path.join(dir, 'keeper.log')})`)
      if (!alive(keeper.pid) && run?.status !== 'ready') throw new Error(`rig keeper exited during start; see ${path.join(dir, 'keeper.log')}`)
      if (Date.now() > end) { await stopRun(dir, { keep: true }); throw new Error(`rig run ${id} did not become ready in time; kept for inspection at ${dir}`) }
      await sleep(300)
    }
  } finally {
    // ready, or failed (a kept run is an ordinary dead one): the busy window ends
    try { writeRun(dir, { busy: null }) } catch { /* the folder is gone */ }
  }
}

/** Stop a run's engine gracefully and start it again on the same data root
 * and cluster (what quitting and reopening the app does to the engine).
 * `hub`: while the engine is down, the run's hosted hub binary is replaced
 * with that one (named as for `up --hub`), as installing another Orgtree
 * replaces the bundled hub. */
export async function restartRun(dir, { timeout = 240000, hub } = {}) {
  const nextHub = hub ? hubExe(hub) : null
  if (nextHub && !readRun(dir)?.hub) throw new Error('this run hosts no mail hub (start it with up --hub)')
  // the run is down on purpose until its new keeper is up: other agents' cleanup must not take it
  writeRun(dir, { busy: new Date().toISOString() })
  await stopRun(dir, { keep: true })
  if (nextHub) {
    // the old hub's file can stay locked a moment after its process is gone
    for (let i = 0; ; i++) {
      try { fs.copyFileSync(nextHub, readRun(dir).hub); break } catch (e) { if (i >= 20) throw e; await sleep(500) }
    }
  }
  fs.rmSync(path.join(dir, 'stop'), { force: true })
  writeRun(dir, { status: 'starting', restarts: (readRun(dir)?.restarts ?? 0) + 1, error: null })
  touch(dir)
  await launchKeeper(dir, timeout)
  return new Rig(dir)
}

/** The environment a rig engine inherits: none of the host agent's
 * Orgtree, Claude, Codex or credential variables. */
export function cleanEnv() {
  const drop = /^(ORGTREE_|CLAUDE|ANTHROPIC_|CODEX_|OPENAI_|OPENROUTER_|GH_|GITHUB_|GIT_ASKPASS|SSH_ASKPASS|ELECTRON_RUN_AS_NODE|NODE_OPTIONS)/i
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!drop.test(k)) env[k] = v
  for (const k of ['ORGTREE_RIG_HOME']) if (process.env[k]) env[k] = process.env[k]
  return env
}

export async function stopRun(dir, { keep = false, timeout = 90000 } = {}) {
  const run = readRun(dir)
  if (run?.keeperPid && alive(run.keeperPid)) {
    fs.writeFileSync(path.join(dir, 'stop'), JSON.stringify({ keep, at: new Date().toISOString() }))
    const end = Date.now() + timeout
    while (alive(run.keeperPid) && Date.now() < end) await sleep(300)
  }
  const left = reap(dir)
  if (!keep) removeDir(dir)
  return { dir, kept: keep, reaped: left }
}

/** Kill whatever of a run still lives (engine copy, its postgres, fake CLIs, keeper). */
export function reap(dir, { keeper = true } = {}) {
  const run = readRun(dir)
  const killed = []
  if (keeper && run?.keeperPid && run.keeperPid !== process.pid && alive(run.keeperPid)) {
    const k = processes(`$_.ProcessId -eq ${Number(run.keeperPid)}`)[0]
    if (k && /keeper\.mjs/i.test(k.CommandLine || '') && (k.CommandLine || '').toLowerCase().includes(lower(dir))) { killTree(run.keeperPid); killed.push(run.keeperPid) }
  }
  for (const p of processesUnder(dir)) { killTree(p.ProcessId); killed.push(p.ProcessId) }
  // a desktop smoke's electron.exe runs where it is installed: found by its recorded pid
  const ePid = (() => { try { return Number(fs.readFileSync(path.join(dir, 'electron.pid'), 'utf8')) } catch { return 0 } })()
  if (ePid && alive(ePid)) {
    const e = processes(`$_.ProcessId -eq ${ePid}`)[0]
    if (e && /^electron\.exe$/i.test(e.Name || '')) { killTree(ePid); killed.push(ePid) }
  }
  // postgres runs from the shared binary cache, not the run: find it by its data folder
  const pidFile = path.join(dir, 'data', 'pg', 'cluster', 'data', 'postmaster.pid')
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').split(/\r?\n/)[0])
    const p = pid && processes(`$_.ProcessId -eq ${pid}`)[0]
    if (p && /postgres\.exe$/i.test(p.ExecutablePath || '') && (p.CommandLine || '').toLowerCase().includes(lower(path.join(dir, 'data')))) { killTree(pid); killed.push(pid) }
  }
  return killed
}

function removeDir(dir) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true } catch { spawnSync('cmd.exe', ['/c', 'timeout', '/t', '1', '/nobreak'], { windowsHide: true }) }
  }
  return !fs.existsSync(dir)
}

const me = () => process.env.ORGTREE_AGENT || os.userInfo().username

/** How long a busy mark keeps a down run safe from cleanup: longer than a
 * slow start or restart (240 s by default), short enough that a run whose
 * driver died is tidied soon after. */
export const BUSY_MS = 15 * 60 * 1000

/** Stop and delete every run whose keeper is gone; with mine=true also this
 * agent's live runs, with everyone=true every live run (other agents' too). */
export async function cleanup({ mine = false, everyone = false, dryRun = false } = {}) {
  const out = []
  const live = []
  for (const { dir, run } of listRuns()) {
    // a run.json that exists but cannot be read now (held open for a moment)
    // says nothing about the run: leave it alone
    if (!run && !everyone && fs.existsSync(path.join(dir, 'run.json'))) { live.push(dir); out.push({ dir, kept: 'run.json unreadable' }); continue }
    // a run another agent is still creating has no keeper yet (it copies its
    // cluster first): a young `starting` run is live, not an orphan
    const young = run?.status === 'starting' && Date.now() - Date.parse(run.created ?? 0) < 5 * 60 * 1000
    // so is a run that is down on purpose (being created, restarting, crashed
    // before a restart) while its busy mark is fresh
    const busy = run?.busy && Date.now() - Date.parse(run.busy) < BUSY_MS
    const up = young || busy || (run?.keeperPid && alive(run.keeperPid) && ['ready', 'starting'].includes(run.status))
    const stop = !up || everyone || (mine && run?.by === me())
    if (!stop) { live.push(dir); out.push({ dir, kept: `live (${run?.by ?? '?'})` }); continue }
    out.push(dryRun ? { dir, wouldStop: true } : await stopRun(dir, { keep: false, timeout: 30000 }))
  }
  // Anything still running from the rig's own folders that no live run owns
  // (a crashed run's postgres runs from the shared binary cache). Only runs
  // and pg: another agent's rig home may sit inside this one (for example
  // D:\orgtree-work\rig\<agent>), and its processes are not ours. Ownership
  // follows the process tree: a postgres backend's command line names no data
  // folder, only its postmaster's does, so a live run's backends must be
  // recognised through their parents or they would be killed.
  const home = rigHome()
  const procs = processesUnder(path.join(home, 'runs'), path.join(home, 'pg'))
  const byPid = new Map(procs.map(p => [p.ProcessId, p]))
  const mentions = p => { const t = `${p.ExecutablePath ?? ''} ${p.CommandLine ?? ''}`.toLowerCase(); return live.some(d => t.includes(lower(d))) }
  const owned = p => {
    for (let q = p, hops = 0; q && hops < 16; q = byPid.get(q.ParentProcessId), hops++) if (mentions(q)) return true
    return false
  }
  // only the roots of stray trees: killing a root takes its children
  const strays = procs.filter(p => !owned(p) && !byPid.has(p.ParentProcessId))
  if (!dryRun) for (const p of strays) killTree(p.ProcessId)
  return { runs: out, strays: strays.map(p => ({ pid: p.ProcessId, exe: p.ExecutablePath, cmd: (p.CommandLine ?? '').slice(0, 200) })) }
}
