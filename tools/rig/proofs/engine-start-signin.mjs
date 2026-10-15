// Proof: the sign-in engine task's windowless launcher (docket
// option-to-run-the-background-engine-in-the-user-s, user 2026-10-15). With
// "At sign-in, in my session" chosen, the "Orgtree Sign-in Engine" task runs
// resources\engine\orgtree-engine-host.exe at the operator's sign-in. The
// launcher starts `orgtree-engine host` beside it, without a window, and waits
// for it. Measured here over a rig run's data, set up as boot-host-stop.mjs:
//   A  the launcher starts exactly the boot task's host (its own child,
//      command line `host`), the host publishes its attach descriptor, and
//      the engine answers as that data folder's engine;
//   B  exactly one engine: while it runs, a desktop-style engine (`serve` on
//      the same data) is refused as root-owned, a second launcher's host
//      leaves at once (exit 75), and the first engine keeps serving under the
//      same descriptor;
//   C  ending the task ends the launcher alone: the host notices, asks its
//      engine to stop with its own token, the engine runs its own shutdown
//      (PostgreSQL cleanly), and the host leaves and removes its descriptor.
// What the rig cannot show: a real sign-in (the task's logon trigger, the
// operator's interactive token, session 1), and that no console window
// appears. Agents run in Session 0, where no window is visible anyway.
// Run with a debug build of the engine and its launcher in CARGO_TARGET_DIR:
//   node tools/rig/rig.mjs run tools/rig/proofs/engine-start-signin.mjs
// ORGTREE_RIG_ENGINE_HOST names the launcher when ORGTREE_RIG_ENGINE names the
// engine (it is otherwise taken from beside that engine).

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { TOKEN_HEADER, alive, cleanEnv, engineExe, processes, stopRun, writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

// `promise`'s value, or null after `ms`; the timer goes once either settles, so
// a finished proof does not wait out the limit.
const within = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms) })]).finally(() => clearTimeout(timer))
}
const STOP_WAIT_MS = 200000

export default async function (rig) {
  const p = new Proof('engine-start-signin')
  const source = process.env.ORGTREE_RIG_ENGINE_HOST || path.join(path.dirname(engineExe()), 'orgtree-engine-host.exe')
  if (!fs.existsSync(source)) throw new Error(`no launcher at ${source}: cargo build -p orgtree-engine --bins`)
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // The run's own engine stops and the run stays: its data is the sign-in
  // engine's below. `busy` keeps other cleanups off it until the keeper is back.
  const run = rig.run
  writeRun(rig.dir, { busy: new Date().toISOString() })
  await stopRun(rig.dir, { keep: true })

  // The launcher starts the engine beside it, as in resources\engine.
  const engine = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
  const launcherExe = path.join(rig.dir, 'bin', 'orgtree-engine-host.exe')
  fs.copyFileSync(source, launcherExe)
  const ui = path.join(rig.dir, 'host-ui')
  fs.mkdirSync(ui, { recursive: true })
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>rig</title>')
  const env = {
    ...cleanEnv(),
    ORGTREE_V2_DATA: rig.data,
    ORGTREE_V2_UI_DIR: ui,
    ORGTREE_P03_PG_BIN: run.pgBin,
    ORGTREE_ENGINE_SAFE_START: '1',
    ORGTREE_ENGINE_RIG: '1',
    ORGTREE_ENGINE_ALLOW_INITDB: '1',
    ORGTREE_NET_OFFLINE: '1',
    ORGTREE_LOG_VERBOSE: '1',
    ORGTREE_CLAUDE_BIN: path.join(rig.dir, 'bin', 'claude.exe'),
    ORGTREE_CODEX_BIN: path.join(rig.dir, 'bin', 'codex.exe'),
    ORGTREE_AGY_BIN: path.join(rig.dir, 'bin', 'agy.exe'),
    ORGTREE_TAILSCALE_BIN: path.join(rig.dir, 'bin', 'tailscale.cmd'),
    ORGTREE_FAKECLI_DIR: rig.fakeDir,
    ORGTREE_FAKECLI_HOME: path.join(rig.data, 'rig-home'),
  }
  const descriptor = path.join(rig.data, 'engine-attach.json')
  const hostLog = path.join(rig.data, 'diagnostics', 'boot-host.log')
  const pgLog = path.join(rig.data, 'pg', 'cluster', 'log', 'postgres.log')
  const size = f => (fs.existsSync(f) ? fs.statSync(f).size : 0)
  const after = (f, from) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(from).toString('utf8') : '')
  const readDescriptor = () => { try { return JSON.parse(fs.readFileSync(descriptor, 'utf8')) } catch { return null } }
  const identity = async attach => {
    try {
      const res = await fetch(`http://127.0.0.1:${attach.port}/api/desktop/identity`, { headers: { [TOKEN_HEADER]: attach.token }, signal: AbortSignal.timeout(4000) })
      return res.ok ? await res.json() : null
    } catch { return null }
  }
  const launch = () => {
    const child = spawn(launcherExe, [], { cwd: rig.dir, env, stdio: 'ignore', windowsHide: true })
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, at: Date.now() })))
    return { child, exited }
  }
  const one = pid => processes(`$_.ProcessId -eq ${Number(pid)}`)[0] ?? null

  // ------------------------------------------------------------ A: the launcher starts the host
  const first = launch()
  const attach = await rig.waitFor(() => {
    const a = readDescriptor()
    return a && a.hostPid !== first.child.pid ? a : null
  }, { what: 'the host to publish its attach descriptor', timeout: 180000 })
  const host = one(attach.hostPid)
  p.check('A: the launcher\'s own child is the host, `orgtree-engine host` beside it',
    host && Number(host.ParentProcessId) === first.child.pid && String(host.ExecutablePath).toLowerCase() === engine.toLowerCase()
      && /\shost\s*$/.test(String(host.CommandLine)), { launcher: first.child.pid, host })
  const engineProcess = one(attach.enginePid)
  p.check('A: the engine is the host\'s child', engineProcess && Number(engineProcess.ParentProcessId) === attach.hostPid, { engine: engineProcess })
  const id = await identity(attach)
  p.check('A: the engine answers as this data folder\'s engine', id?.protocol === 1 && id?.pid === attach.enginePid, { identity: id })
  p.check('A: the launcher waits for its host (the task runs as long as the engine)', alive(first.child.pid))

  // ------------------------------------------------------------ B: exactly one engine
  {
    // what the desktop does when no engine answers: start its own, on the same data
    const desk = spawn(engine, ['serve'], {
      cwd: rig.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, ORGTREE_DATA: rig.data, ORGTREE_V2_TOKEN: randomBytes(32).toString('hex'), ORGTREE_CORE_MODE: 'managed' },
    })
    let out = ''
    desk.stdout.on('data', chunk => { out += chunk })
    const deskExit = await within(new Promise(resolve => desk.once('exit', code => resolve({ code }))), 60000)
    if (!deskExit) desk.kill()
    p.check('B: a desktop-style engine on the same data is refused as root-owned and leaves', !!deskExit && /"type":"refused"/.test(out) && /root-owned/.test(out),
      { exit: deskExit?.code, out: out.slice(0, 600) })
    const second = launch()
    const secondExit = await within(second.exited, 60000)
    if (!secondExit) second.child.kill()
    p.check('B: a second launcher\'s host leaves at once (75: another engine owns the data)', secondExit?.code === 75, { exit: secondExit?.code })
    const still = readDescriptor()
    p.check('B: the first engine keeps serving under the same descriptor', still?.hostPid === attach.hostPid && still?.enginePid === attach.enginePid
      && (await identity(attach))?.pid === attach.enginePid)
  }

  // ------------------------------------------------------------ C: the task ended
  {
    // The host engine's own session log (trace.rs: one file per engine start, its
    // header names the pid). Not a slice of rig.engineLog(): B's refused engine
    // wrote a later file, so this engine's new lines land in the middle of it.
    const engineFile = rig.engineLogFiles().find(f => fs.readFileSync(f, 'utf8').includes(`engine starting pid=${attach.enginePid} `))
    const pgFrom = size(pgLog), hostFrom = size(hostLog), logFrom = engineFile ? size(engineFile) : 0
    const t0 = Date.now()
    // Task Scheduler's End: the launcher process alone is terminated (no tree kill).
    process.kill(first.child.pid)
    await first.exited
    const gone = await rig.waitFor(() => !alive(attach.enginePid) && !alive(attach.hostPid) ? Date.now() : null,
      { what: 'the engine and its host to stop after the launcher', timeout: STOP_WAIT_MS }).catch(() => null)
    const seconds = gone ? Number(((gone - t0) / 1000).toFixed(1)) : null
    p.check('C: the engine and its host stop once the launcher is gone', !!gone, { seconds })
    p.check('C: the host noticed the task ended and asked its engine to stop', /the sign-in engine task ended; stopping the engine/.test(after(hostLog, hostFrom)))
    const text = engineFile ? after(engineFile, logFrom) : ''
    p.check('C: the engine ran its own shutdown on the host\'s request', /shutdown requested by the desktop/.test(text) && /engine stopping/.test(text),
      { log: engineFile ? path.basename(engineFile) : null })
    p.check('C: PostgreSQL shut down cleanly', /database system is shut down/.test(after(pgLog, pgFrom)))
    p.check('C: the host removed its attach descriptor', !fs.existsSync(descriptor))
    p.file('boot-host.log', after(hostLog, 0))
    if (!gone) {
      // What outlived the launcher (a red run, or a failure) is stopped the asked
      // way, with the descriptor's token, before the run's cleanup would kill it.
      const live = readDescriptor() ?? attach
      const asked = await fetch(`http://127.0.0.1:${live.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: live.token }, signal: AbortSignal.timeout(10000) })
        .then(res => res.status).catch(err => String(err))
      const pids = [...new Set([attach.hostPid, attach.enginePid, live.hostPid, live.enginePid])]
      const stopped = await rig.waitFor(() => pids.every(pid => !alive(pid)), { what: 'what C left running to stop when asked', timeout: STOP_WAIT_MS }).catch(() => false)
      const postmaster = (() => { try { return Number(fs.readFileSync(path.join(rig.data, 'pg', 'cluster', 'data', 'postmaster.pid'), 'utf8').split(/\r?\n/)[0]) || null } catch { return null } })()
      p.note('C cleanup: asked to stop through the descriptor; whatever is left, the run\'s cleanup kills', {
        asked, stopped, left: pids.filter(alive), postgres: postmaster && alive(postmaster) ? postmaster : null,
      })
    }
  }

  // The run's own engine again, so `rig down` ends it the usual way.
  fs.rmSync(descriptor, { force: true })
  await rig.restart()
  p.keep(rig, { grep: /shutdown|stopping|refused|root|host|stopped/i })
  return p.summary()
}
