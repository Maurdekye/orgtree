// tools/rig/keeper.mjs <run dir>: keeps one rig run's engine alive, then
// stops it. Started detached by `rig up`; the engine gets this process as
// its parent (ORGTREE_V2_PARENT_PID), so if the keeper dies the engine shuts
// down too, and the engine's own kill-on-close job takes PostgreSQL and every
// fake CLI with it. Stops on `rig down` (the run's `stop` file), after
// ttlMin minutes without a rig command touching the run, after maxMin
// minutes in all, or when the engine exits by itself.

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { TOKEN_HEADER, alive, cleanEnv, killTree, readRun, reap, writeRun } from './lib.mjs'

const dir = path.resolve(process.argv[2] || '')
const run = readRun(dir)
if (!run) { console.error('keeper: not a rig run:', dir); process.exit(2) }
const data = path.join(dir, 'data')
const log = (...a) => console.log(new Date().toISOString(), ...a)
const started = Date.now()

const env = {
  ...cleanEnv(),
  ORGTREE_DATA: data,
  ORGTREE_V2_TOKEN: run.token,
  ORGTREE_V2_PARENT_PID: String(process.pid),
  ORGTREE_P03_PG_BIN: run.pgBin,
  ORGTREE_ENGINE_SAFE_START: '1',
  ORGTREE_ENGINE_RIG: '1',
  ORGTREE_ENGINE_ALLOW_INITDB: '1',
  ORGTREE_NET_OFFLINE: '1',
  // verbose call logging, unless the run asked for none (`up --quiet-log`)
  ORGTREE_LOG_VERBOSE: run.quietLog ? '0' : '1',
  ORGTREE_CLAUDE_BIN: path.join(dir, 'bin', 'claude.exe'),
  ORGTREE_CODEX_BIN: path.join(dir, 'bin', 'codex.exe'),
  ORGTREE_AGY_BIN: path.join(dir, 'bin', 'agy.exe'),
  ORGTREE_OPENCODE_BIN: path.join(dir, 'bin', 'opencode.exe'),
  // the fake `muse serve` (the engine runs Muse's binary, never its updater launcher),
  // or with `up --real-muse` the installed one's copy
  ORGTREE_MUSE_BIN: run.realMuse || path.join(dir, 'bin', 'muse-bin-9.9.9-R0.exe'),
  ORGTREE_TAILSCALE_BIN: path.join(dir, 'bin', 'tailscale.cmd'),
  ORGTREE_FAKECLI_DIR: path.join(dir, 'fakecli'),
  ORGTREE_FAKECLI_HOME: path.join(data, 'rig-home'),
}
if (run.ui) env.ORGTREE_V2_UI_DIR = run.ui
if (run.streamProbe) env.ORGTREE_RIG_STREAM_PROBE = '1'
// `up --real-cli`: the installed Claude Code and Codex are the agents' CLIs,
// so every child's home is the run's fake one. A CLI the engine launches
// without its own config folder then finds the fake profile (an empty
// login), never the user's real ~/.claude. Their temp folders are the run's
// too: Claude Code keeps a folder per working folder under %TEMP%\claude,
// which would otherwise outlive the run on C:.
if (run.realCli) {
  env.USERPROFILE = path.join(data, 'rig-home')
  env.HOME = env.USERPROFILE
  env.TEMP = path.join(dir, 'tmp')
  env.TMP = env.TEMP
  fs.mkdirSync(env.TEMP, { recursive: true })
}
// `up --hub`: the engine hosts the run's own mail hub, and network mail
// reaches that loopback hub and no other (src/rig.rs `hub`)
if (run.hub) {
  env.ORGTREE_RIG_HUB = '1'
  env.ORGTREE_HUB_BIN = run.hub
  delete env.ORGTREE_NET_OFFLINE
}
if (run.recover) env.ORGTREE_RIG_RECOVER = '1'
// `up --boot-isolated`: the credential context reports the boot task's
// isolation, so CLIs get the credential bridge adapters (src/rig.rs)
if (run.bootIsolated) env.ORGTREE_RIG_BOOT_ISOLATED = '1'
// whether the engine counts as running in Windows Session 0, where Codex's
// sandbox cannot start (src/runtime/codex.rs `session0`): '1' or '0' forces it
if (run.session0 != null) env.ORGTREE_RIG_SESSION0 = String(run.session0)
// a shortened "still unread" threshold (src/runtime/recovery.rs `steer_late_after`)
if (run.steerLateS) env.ORGTREE_RIG_STEER_LATE_S = String(run.steerLateS)
// a smaller cap on idle CLI processes (src/runtime/sched.rs `max_parked`)
if (run.maxParked) env.ORGTREE_RIG_MAX_PARKED = String(run.maxParked)
// the automatic wakes (checkups, idle docket reminders), swept every `reminders` seconds (true: 5)
if (run.reminders) {
  env.ORGTREE_RIG_REMINDERS = '1'
  env.ORGTREE_RIG_REMINDER_SWEEP_S = String(run.reminders === true ? 5 : run.reminders)
  // a pause between a wake's reservation and its mail, for a proof of the lost idle race
  if (run.reminderPauseMs) env.ORGTREE_RIG_REMINDER_PAUSE_MS = String(run.reminderPauseMs)
}

log('keeper', process.pid, 'starting engine for', dir)
const engine = spawn(path.join(dir, 'bin', 'orgtree-engine.exe'), ['serve'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
writeRun(dir, { enginePid: engine.pid, keeperPid: process.pid })
let ready = false
let stopping = null

readline.createInterface({ input: engine.stdout }).on('line', line => {
  let v
  try { v = JSON.parse(line) } catch { log('engine stdout:', line); return }
  if (v.type === 'startup-progress') log('progress', v.phase)
  else if (v.type === 'ready') {
    ready = true
    writeRun(dir, { status: 'ready', port: v.port, url: `http://127.0.0.1:${v.port}`, enginePid: engine.pid, readyMs: Date.now() - started })
    log('ready on port', v.port, 'after', Date.now() - started, 'ms')
  } else if (v.type === 'refused') {
    writeRun(dir, { status: 'failed', error: `engine refused: ${v.reason}` })
    log('refused', v.reason)
  } else log('engine:', line)
})
readline.createInterface({ input: engine.stderr }).on('line', line => log('engine stderr:', line))

engine.on('exit', (code, signal) => {
  log('engine exited', code, signal ?? '')
  const killed = reap(dir, { keeper: false })
  if (killed.length) log('reaped', killed.join(','))
  const cur = readRun(dir)
  if (stopping) writeRun(dir, { status: 'stopped', reason: stopping, stoppedAt: new Date().toISOString(), engineExit: code })
  else writeRun(dir, { status: ready ? 'exited' : 'failed', error: cur?.error ?? `the engine exited with ${code ?? signal} ${ready ? 'while running' : 'before it was ready'}`, engineExit: code })
  process.exit(0)
})

async function shutdown(reason) {
  if (stopping) return
  stopping = reason
  log('stopping:', reason)
  writeRun(dir, { status: 'stopping', reason })
  const cur = readRun(dir)
  // The keeper is the engine's caller: it kills the engine tree (PostgreSQL
  // with it) this long after asking it to stop, as the desktop and the
  // background host do after their own budgets. run.json `stopKillMs` sets
  // it (pg-stop.mjs measures a stop under each caller's budget).
  const killMs = Number(cur?.stopKillMs) || 45000
  const asked = Date.now()
  if (cur?.url) {
    try {
      await fetch(cur.url + '/api/desktop/shutdown', { method: 'POST', headers: { [TOKEN_HEADER]: run.token }, signal: AbortSignal.timeout(5000) })
    } catch (e) { log('shutdown request failed:', e.message) }
  } else killTree(engine.pid)
  setTimeout(() => {
    if (alive(engine.pid)) { log(`engine did not stop in ${killMs} ms; killing`); killTree(engine.pid) }
  }, Math.max(0, asked + killMs - Date.now())).unref()
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) process.on(sig, () => shutdown(`signal ${sig}`))

setInterval(() => {
  if (stopping) return
  const stopFile = path.join(dir, 'stop')
  if (fs.existsSync(stopFile)) return shutdown('rig down')
  const cur = readRun(dir)
  const beat = (() => { try { return fs.statSync(path.join(dir, 'heartbeat')).mtimeMs } catch { return started } })()
  if (Date.now() - beat > (cur?.ttlMin ?? 20) * 60000) return shutdown(`idle for ${cur?.ttlMin ?? 20} min (ttl)`)
  if (Date.now() - started > (cur?.maxMin ?? 120) * 60000) return shutdown(`ran ${cur?.maxMin ?? 120} min (max lifetime)`)
}, 2000)
