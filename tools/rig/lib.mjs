// tools/rig/lib.mjs: the test rig's shared library (docs/rust-engine/test-rig.md).
//
// A rig run is one throwaway data root under ORGTREE_RIG_HOME (default
// E:\orgtree-rig) holding its own PostgreSQL cluster, a debug engine in rig
// mode (SAFE_START, fake home, fake CLIs, /api/rig/tool) kept alive by a
// small keeper process, the fake CLI's scenario and logs. Nothing here reads
// or writes the live data folder, the live cluster or the user's profile.
// Node built-ins only: no npm install is needed to use the rig.

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const RIG_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(RIG_DIR, '..', '..')
export const TOKEN_HEADER = 'X-Orgtree-Desktop-Token'
export const PG_VERSION = '18.6-4'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const lower = p => path.resolve(p).toLowerCase().replace(/[\\/]+$/, '')
const inside = (child, parent) => lower(child) === lower(parent) || lower(child).startsWith(lower(parent) + '\\')

export function rigHome() {
  const fromEnv = process.env.ORGTREE_RIG_HOME
  const home = fromEnv ? path.resolve(fromEnv) : fs.existsSync('E:\\') ? 'E:\\orgtree-rig' : path.join(os.tmpdir(), 'orgtree-rig')
  assertSafeRoot(home)
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

/** Every process whose executable lives under `dir` (engine copies, postgres, fake CLIs). */
export function processesUnder(dir) {
  return processes(`$_.ExecutablePath -and $_.ExecutablePath.ToLower().StartsWith(${psQuote(lower(dir) + '\\')})`)
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

// ------------------------------------------------------------ binaries

export function cargoTarget() {
  const t = process.env.CARGO_TARGET_DIR
  if (!t) throw new Error('set CARGO_TARGET_DIR to your own folder on E: (team rule), e.g. E:\\cargo-target\\<agent>')
  if (/^c:/i.test(path.resolve(t))) throw new Error(`CARGO_TARGET_DIR is on drive C: (${t}); team rule: keep cargo output on E:`)
  return path.resolve(t)
}

export function engineExe(explicit) {
  const exe = explicit || process.env.ORGTREE_RIG_ENGINE || path.join(cargoTarget(), 'debug', 'orgtree-engine.exe')
  if (!fs.existsSync(exe)) throw new Error(`no engine at ${exe}: run \`node tools/rig/rig.mjs build\` first`)
  const v = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
  if (!/\(dev\)/.test(v.stdout || '')) throw new Error(`${exe} is not a debug (dev) engine build (${(v.stdout || v.stderr || '').trim()}); the rig needs one`)
  return exe
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
    main && path.join(main, '.worktrees', 'rust-engine', 'engine', 'postgresql'),
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
  const candidates = [explicit, process.env.ORGTREE_RIG_UI, path.join(REPO, 'dist', 'renderer'), 'C:\\Program Files\\Orgtree\\resources\\ui', main && path.join(main, '.worktrees', 'rust-engine', 'dist', 'renderer')]
  return candidates.filter(Boolean).find(d => fs.existsSync(path.join(d, 'index.html'))) || null
}

/** Electron, run where it is installed (never linked or copied). */
export function electronExe(explicit) {
  const main = mainRepo()
  const candidates = [explicit, process.env.ORGTREE_RIG_ELECTRON, path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe'),
    main && path.join(main, 'node_modules', 'electron', 'dist', 'electron.exe'),
    main && path.join(main, '.worktrees', 'rust-engine', 'node_modules', 'electron', 'dist', 'electron.exe')]
  const exe = candidates.filter(Boolean).find(p => fs.existsSync(p))
  if (!exe) throw new Error('no electron.exe found; set ORGTREE_RIG_ELECTRON')
  return exe
}

// ------------------------------------------------------------ runs

export function runsDir(home = rigHome()) { return path.join(home, 'runs') }
export function readRun(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8')) } catch { return null }
}
export function writeRun(dir, patch) {
  const cur = readRun(dir) || {}
  const next = { ...cur, ...patch, statusAt: new Date().toISOString() }
  const tmp = path.join(dir, `run.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
  fs.renameSync(tmp, path.join(dir, 'run.json'))
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

/** The run a command means: --run <id|dir>, else the newest live one. */
export function pickRun(which) {
  const runs = listRuns()
  if (which) {
    const hit = runs.find(r => path.basename(r.dir) === which || lower(r.dir) === lower(which))
    if (!hit) throw new Error(`no rig run ${which}`)
    return hit.dir
  }
  const ready = runs.filter(r => r.run?.status === 'ready').sort((a, b) => String(b.run.created).localeCompare(String(a.run.created)))
  if (!ready.length) throw new Error('no rig run is up: `node tools/rig/rig.mjs up`')
  return ready[0].dir
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

  /** Stop the engine and start it again on the same data (a new keeper). */
  async restart(opts) {
    await restartRun(this.dir, opts)
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

  engineLogFiles() {
    const d = path.join(this.data, 'diagnostics', 'logs')
    return fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.log')).map(f => path.join(d, f)).sort() : []
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
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.mkdirSync(data, { recursive: true })
  fs.writeFileSync(path.join(data, '.orgtree-rig-root'), JSON.stringify({ rig: 1, created: new Date().toISOString(), run: id }))
  fakeHome(data)
  if (opts.legacy) fs.cpSync(opts.legacy, data, { recursive: true })
  // --initdb: let the engine create the cluster itself (its own first-start path)
  if (!opts.initdb && !fs.existsSync(path.join(data, 'pg', 'cluster'))) fs.cpSync(pgTemplate(home, pg), path.join(data, 'pg', 'cluster'), { recursive: true })
  // a script's hook on the run's own cluster before the engine's first start (e.g. a legacy 3.x store)
  if (opts.prepare) await opts.prepare({ dir, data, pgBin: pg })
  // copies: a running engine never locks the developer's cargo output
  fs.copyFileSync(engine, path.join(dir, 'bin', 'orgtree-engine.exe'))
  fs.copyFileSync(fake, path.join(dir, 'bin', 'claude.exe'))
  fs.copyFileSync(fake, path.join(dir, 'bin', 'codex.exe'))
  fs.mkdirSync(path.join(dir, 'fakecli', 'log'), { recursive: true })
  if (!fs.existsSync(path.join(dir, 'fakecli', 'scenario.json'))) {
    fs.writeFileSync(path.join(dir, 'fakecli', 'scenario.json'), JSON.stringify({ default: { turns: [{ steps: [{ text: 'OK.' }] }] } }, null, 2))
  }
  writeRun(dir, {
    id, created: new Date().toISOString(), status: 'starting', dir, data, pgBin: pg, ui, engineSource: engine,
    token: crypto.randomBytes(32).toString('hex'), ttlMin: opts.ttlMin ?? 20, maxMin: opts.maxMin ?? 120, by: me(),
  })
  touch(dir)
  await launchKeeper(dir, opts.timeout)
  return new Rig(dir)
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
  for (;;) {
    const run = readRun(dir)
    if (run?.status === 'ready') break
    if (run?.status === 'failed' || run?.status === 'stopped') throw new Error(`rig run ${id} failed to start: ${run.error ?? run.status}\n(see ${path.join(dir, 'keeper.log')})`)
    if (!alive(keeper.pid) && run?.status !== 'ready') throw new Error(`rig keeper exited during start; see ${path.join(dir, 'keeper.log')}`)
    if (Date.now() > end) { await stopRun(dir, { keep: true }); throw new Error(`rig run ${id} did not become ready in time; kept for inspection at ${dir}`) }
    await sleep(300)
  }
}

/** Stop a run's engine gracefully and start it again on the same data root
 * and cluster (what quitting and reopening the app does to the engine). */
export async function restartRun(dir, { timeout = 240000 } = {}) {
  await stopRun(dir, { keep: true })
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

/** Stop and delete every run whose keeper is gone; with mine=true also this
 * agent's live runs, with everyone=true every live run (other agents' too). */
export async function cleanup({ mine = false, everyone = false, dryRun = false } = {}) {
  const out = []
  const live = []
  for (const { dir, run } of listRuns()) {
    const up = run?.keeperPid && alive(run.keeperPid) && ['ready', 'starting'].includes(run.status)
    const stop = !up || everyone || (mine && run?.by === me())
    if (!stop) { live.push(dir); out.push({ dir, kept: `live (${run?.by ?? '?'})` }); continue }
    out.push(dryRun ? { dir, wouldStop: true } : await stopRun(dir, { keep: false, timeout: 30000 }))
  }
  // Anything still running from the rig home that no live run owns (a
  // crashed run's postgres runs from the shared binary cache). Ownership
  // follows the process tree: a postgres backend's command line names no data
  // folder, only its postmaster's does, so a live run's backends must be
  // recognised through their parents or they would be killed.
  const procs = processesUnder(rigHome())
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
