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
  ORGTREE_LOG_VERBOSE: '1',
  ORGTREE_CLAUDE_BIN: path.join(dir, 'bin', 'claude.exe'),
  ORGTREE_CODEX_BIN: path.join(dir, 'bin', 'codex.exe'),
  ORGTREE_AGY_BIN: path.join(dir, 'bin', 'agy.exe'),
  ORGTREE_FAKECLI_DIR: path.join(dir, 'fakecli'),
  ORGTREE_FAKECLI_HOME: path.join(data, 'rig-home'),
}
if (run.ui) env.ORGTREE_V2_UI_DIR = run.ui
if (run.recover) env.ORGTREE_RIG_RECOVER = '1'
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
  if (cur?.url) {
    try {
      await fetch(cur.url + '/api/desktop/shutdown', { method: 'POST', headers: { [TOKEN_HEADER]: run.token }, signal: AbortSignal.timeout(5000) })
    } catch (e) { log('shutdown request failed:', e.message) }
  } else killTree(engine.pid)
  // the engine stops PostgreSQL itself (pg_ctl -m fast, up to 30 s)
  setTimeout(() => { if (alive(engine.pid)) { log('engine did not stop in time; killing'); killTree(engine.pid) } }, 45000).unref()
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
