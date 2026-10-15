// Proof: the two ways the installer stops the background engine, measured on a
// real `orgtree-engine host` (the supervisor the "Orgtree Background Engine"
// task runs) over a rig run's data (docket
// installer-can-t-replace-a-running-orgtree-an-ins).
//   A  asked: POST /api/desktop/shutdown with the token from the host's
//      engine-attach.json, as the installer's close helper and its boot step
//      now do first. The engine ends its agents' CLIs itself (each logs a clean
//      exit), stops PostgreSQL cleanly, and the host removes the descriptor and
//      exits 0, so the task's restart-on-failure would not start it again.
//   B  the installer's fallback when it cannot ask (another administrator):
//      it records a stop request in its own record, then Task Scheduler's End
//      terminates the host process alone. Since the core-lifecycle recovery
//      (2026-10-12) the engine outlives its host; it reads the request (in a
//      rig run from its own HKCU key, ORGTREE_RIG_STOP_KEY) and stops the same
//      way by itself (docket installer-s-end-task-fallback-no-longer-stops-th).
//   C  a bare host exit, with no request: the engine keeps running (the
//      recovery rule), and B's request, older than this engine, stops nothing.
//   Both with a Claude agent (ada) and a Codex agent (lu) mid-turn. Either
//   way the engine runs its OWN shutdown and stops each agent itself; nothing
//   kills the engine. How gently that shutdown ends each CLI is the engine's
//   (measured 2026-10-10: it terminates them, "termination requested", exit
//   code 1, no interrupt and no stdin close; docket
//   urgent-orgtree-s-hard-killing-of-codex-processes), so it is recorded as a
//   note: a CLI that logged an exit was ended cleanly, one that did not was
//   terminated.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/boot-host-stop.mjs

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { TOKEN_HEADER, alive, cleanEnv, stopRun, writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// `promise`'s value, or null after `ms`; the timer goes once either settles, so
// a finished proof does not wait out the limit.
const within = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms) })]).finally(() => clearTimeout(timer))
}
const AGENTS = ['ada', 'lu']
const STOP_WAIT_MS = 200000

export default async function (rig) {
  const p = new Proof('boot-host-stop')
  rig.scenario({
    agents: Object.fromEntries(AGENTS.map(name => [name, { turns: [{ name: 'hang', match: 'HOST-HANG', steps: [{ text: 'On it.' }, { hang: true }] }] }])),
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'ada', parent: 'boss', tier: 'opus', title: 'Claude subject' })
  await rig.op({ op: 'hire', name: 'lu', parent: 'boss', tier: 'luna', title: 'Codex subject' })

  // The run's own engine stops (its keeper asks it, as `rig down` does) and the
  // run stays: its data is the background engine's below. `busy` keeps other
  // cleanups off it until the keeper is back.
  const run = rig.run
  writeRun(rig.dir, { busy: new Date().toISOString() })
  await stopRun(rig.dir, { keep: true })

  // where this run's engines read the installer's stop request (rig mode only)
  const stopKey = `Software\\OrgtreeRigStop-${path.basename(rig.dir)}`
  const ui = path.join(rig.dir, 'host-ui')
  fs.mkdirSync(ui, { recursive: true })
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>rig</title>')
  // The keeper's environment for its engine, with the host's own data folder
  // variable instead: the host derives the engine's data, token and parent.
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
    ORGTREE_RIG_STOP_KEY: stopKey,
  }
  const descriptor = path.join(rig.data, 'engine-attach.json')
  const pgLog = path.join(rig.data, 'pg', 'cluster', 'log', 'postgres.log')
  const size = f => (fs.existsSync(f) ? fs.statSync(f).size : 0)
  const after = (f, from) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(from).toString('utf8') : '')

  async function startHost() {
    const host = spawn(path.join(rig.dir, 'bin', 'orgtree-engine.exe'), ['host'], { cwd: rig.dir, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    host.stderr.on('data', chunk => { stderr += chunk })
    const exited = new Promise(resolve => host.once('exit', code => resolve({ code, at: Date.now() })))
    const attach = await rig.waitFor(() => {
      const a = JSON.parse(fs.readFileSync(descriptor, 'utf8'))
      return a.hostPid === host.pid ? a : null
    }, { what: 'the host to publish its attach descriptor', timeout: 180000 })
    // The rig's API helpers, pointed at the host's engine.
    const view = Object.create(rig)
    view.run = { ...rig.run, url: `http://127.0.0.1:${attach.port}`, token: attach.token }
    return { host, exited, attach, view, stderr: () => stderr }
  }

  async function agentsMidTurn(view, label) {
    const before = Object.fromEntries(AGENTS.map(name => [name, rig.fakeLog(name).length]))
    for (const name of AGENTS) await view.userMail(name, `HOST-HANG ${label}`)
    await rig.waitFor(() => AGENTS.every(name => rig.fakeLog(name).slice(before[name]).some(e => e.kind === 'hang')),
      { what: `${AGENTS.join(' and ')} mid-turn`, timeout: 90000 })
    return before
  }

  // How each agent's CLI ended after the stop: a logged exit is a CLI that was
  // ended by the engine (stdin closed, or an interrupt first); no exit line is
  // a CLI that was killed.
  const ends = before => Object.fromEntries(AGENTS.map(name => {
    const lines = rig.fakeLog(name).slice(before[name])
    const exit = lines.filter(e => e.kind === 'exit').pop()
    return [name, { exit: exit ? (exit.why ?? exit.code ?? 'exit') : null, interrupted: lines.some(e => e.kind === 'interrupt') }]
  }))
  const cleanShutdown = from => /database system is shut down/.test(after(pgLog, from))
  const engineText = () => rig.engineLog()
  // The engine stopped each agent itself: its own shutdown reached the agent's
  // actor (a killed engine writes no such line).
  const stoppedByEngine = text => Object.fromEntries(AGENTS.map(name => [name,
    new RegExp(`agent:\\d+/${name} \\S+ runtime\\.actor\\.Actor\\.kill_proc`).test(text)]))

  // ------------------------------------------------------------ A: asked
  {
    const a = await startHost()
    p.check('A: the host publishes its attach descriptor and its engine answers', alive(a.attach.enginePid), { port: a.attach.port, enginePid: a.attach.enginePid, hostPid: a.host.pid })
    const before = await agentsMidTurn(a.view, 'A')
    const pgFrom = size(pgLog), logFrom = engineText().length
    const t0 = Date.now()
    const res = await fetch(`http://127.0.0.1:${a.attach.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: a.attach.token } })
    p.check('A: the engine takes the shutdown request', res.ok, { status: res.status })
    const exit = await within(a.exited, STOP_WAIT_MS)
    const seconds = exit ? Number(((exit.at - t0) / 1000).toFixed(1)) : null
    p.check('A: the host exits 0 once its engine has gone (restart-on-failure leaves it stopped)', exit?.code === 0 && !alive(a.attach.enginePid), { code: exit?.code, seconds })
    p.check('A: the host removed the attach descriptor', !fs.existsSync(descriptor))
    const textA = engineText().slice(logFrom)
    p.check('A: the engine ran its own shutdown on the request', /shutdown requested by the desktop/.test(textA) && /engine stopping/.test(textA))
    const byEngineA = stoppedByEngine(textA)
    p.check('A: the engine stopped each agent itself', AGENTS.every(name => byEngineA[name]), byEngineA)
    p.note('A: how each agent\'s CLI ended (an exit line: ended cleanly; none: terminated)', ends(before))
    p.check('A: PostgreSQL shut down cleanly', cleanShutdown(pgFrom))
    p.file('host-A.stderr.txt', a.stderr())
  }

  // ------------------------------------------------------------ B: the installer's fallback
  const reg = args => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })
  try {
  {
    const b = await startHost()
    const before = await agentsMidTurn(b.view, 'B')
    const pgFrom = size(pgLog), logFrom = engineText().length
    const t0 = Date.now()
    // The installer's own record (here the run's HKCU key): the request's time in Unix ms.
    const recorded = reg(['add', `HKCU\\${stopKey}`, '/v', 'StopRequested', '/t', 'REG_QWORD', '/d', String(Date.now()), '/f'])
    p.check('B: the stop request is recorded', recorded.status === 0, { out: (recorded.stdout || recorded.stderr || '').trim() })
    // Task Scheduler's End: the host process alone is terminated (no tree kill).
    const killed = spawnSync('taskkill', ['/PID', String(b.host.pid), '/F'], { encoding: 'utf8', windowsHide: true })
    p.check('B: the host process alone is terminated', killed.status === 0, { out: (killed.stdout || killed.stderr || '').trim() })
    const gone = await rig.waitFor(() => !alive(b.attach.enginePid) ? Date.now() : null, { what: 'the engine to stop after its host', timeout: STOP_WAIT_MS }).catch(() => null)
    const seconds = gone ? Number(((gone - t0) / 1000).toFixed(1)) : null
    p.check('B: the engine stops by itself once its host is gone and the request is recorded', !!gone, { seconds })
    const textB = engineText().slice(logFrom)
    p.check('B: the engine read the installer\'s request and ran its own shutdown', /stop requested by the installer's record/.test(textB) && /engine stopping/.test(textB))
    const byEngineB = stoppedByEngine(textB)
    p.check('B: the engine stopped each agent itself', AGENTS.every(name => byEngineB[name]), byEngineB)
    p.note('B: how each agent\'s CLI ended (an exit line: ended cleanly; none: terminated)', ends(before))
    p.check('B: PostgreSQL shut down cleanly', cleanShutdown(pgFrom))
    p.note('B: the attach descriptor the terminated host could not remove', { left: fs.existsSync(descriptor) })
    p.file('host-B.stderr.txt', b.stderr())
    if (!gone && alive(b.attach.enginePid)) {
      // still running (an engine from before the request existed): stop it the asked way
      await fetch(`http://127.0.0.1:${b.attach.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: b.attach.token } }).catch(() => null)
      await rig.waitFor(() => !alive(b.attach.enginePid), { what: 'the engine B left running to stop', timeout: STOP_WAIT_MS }).catch(() => null)
    }
    fs.rmSync(descriptor, { force: true })
  }

  // ------------------------------------------------------------ C: a bare host exit
  {
    const c = await startHost()
    const logFrom = engineText().length
    const killed = spawnSync('taskkill', ['/PID', String(c.host.pid), '/F'], { encoding: 'utf8', windowsHide: true })
    p.check('C: the host process alone is terminated, with no request', killed.status === 0, { out: (killed.stdout || killed.stderr || '').trim() })
    await sleep(10000)
    const answer = await fetch(`http://127.0.0.1:${c.attach.port}/api/desktop/identity`, { headers: { [TOKEN_HEADER]: c.attach.token } }).then(r => r.ok ? r.json() : null).catch(() => null)
    p.check('C: the engine keeps running and answering after its host exits (the recovery rule)', alive(c.attach.enginePid) && answer?.pid === c.attach.enginePid)
    const textC = engineText().slice(logFrom)
    p.check('C: B\'s request, older than this engine, stopped nothing', !/stop requested by the installer's record/.test(textC))
    p.note('C: what the engine said about the older request', { stale: /a stop request from before this engine started is ignored/.test(textC) })
    // stopped the asked way, so the run's own engine can start again
    await fetch(`http://127.0.0.1:${c.attach.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: c.attach.token } }).catch(() => null)
    const stopped = await rig.waitFor(() => !alive(c.attach.enginePid) ? true : null, { what: 'the engine C left running to stop when asked', timeout: STOP_WAIT_MS }).catch(() => null)
    p.check('C: asked through its descriptor, that engine then stops', !!stopped)
    p.file('host-C.stderr.txt', c.stderr())
  }
  } finally {
    reg(['delete', `HKCU\\${stopKey}`, '/f'])
  }

  // The run's own engine again, so `rig down` ends it the usual way.
  fs.rmSync(descriptor, { force: true })
  await rig.restart()
  p.keep(rig, { agents: AGENTS, grep: /shutdown|stopping|parent process|stopped|agent/i })
  return p.summary()
}
