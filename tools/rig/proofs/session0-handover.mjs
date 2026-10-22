// Proof: a restart or update while the operator is signed in starts the
// engine in their session, not Session 0 (docket after-an-update-or-engine-
// restart-while-the-user; user and coordinator rulings 2026-10-21). Measured
// on a real `orgtree-engine host` (the boot task's supervisor, standing for
// Session 0 with ORGTREE_RIG_SESSION0=1) over a rig run's data, with stand-ins
// for Windows only where a proof may not act:
//   - the "Orgtree User Session Engine" task: the boot host and the proof run
//     its command, `orgtree-engine session-launch signin`, through the rig's
//     own task file (<data>\rig-user-session-task.json); the boot task's run
//     for the rollback likewise (<data>\rig-boot-task.json);
//   - sign-out: <data>\core-rig-signed-out (core_state::sessions), and the
//     user-session engine's processes ended as Windows ends a session's;
//   - the installer's stop request: the run's own HKCU key.
// Every process runs in the proof's real session, which is the console
// session; no real task, UAC prompt, registry key of an installation or
// live data is touched.
//   A  signed out: the boot host runs the engine itself (Session 0).
//   B  signing in alone moves nothing (Run as admin off: decision 84).
//   C0 the attempt record cannot be written (held open without delete
//      sharing): the launcher ends without asking the Session 0 engine for
//      admission or stopping it.
//   C  a restart while signed in (the desktop's ask, then the task): the
//      launcher takes the handover lock and native admission, the Session 0
//      engine stops gracefully (its agent's CLI ended by the engine), the new
//      engine runs in the user's session with the launcher as its host, its
//      restart notices say so, the agent's interrupted turn resumes there
//      with the move notice, and the boot host stays, waiting.
//   D  sign-out: Windows ends the session's engine; after three empty readings
//      the boot host starts the Session 0 engine again, never before.
//   E  the Session 0 engine dies while signed in, with no desktop: the boot
//      host leaves it to the desktop for 120 s, then claims the recovery and
//      runs the task itself; the engine comes back in the user's session.
//   F  a replacement that fails after the stop: exactly one rollback into
//      Session 0, recorded, and reported in that engine's restart notices.
//   G  the rollback fails too: the boot host ends, a retried boot host stays
//      out for that sign-in, and the user's Start engine brings it back.
//   H  the installer's stop request ends a waiting boot host and the
//      user-session engine with it.
// A `recover` run: a safe-start engine otherwise holds back its restart path.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/session0-handover.mjs
// SESSION0_PROOF_PART=1 runs A B C0 C D F G, =2 runs A B E H (each fits a
// 10-minute command limit; E waits out the real 120 s backstop); unset, all,
// in one boot host (about 5 minutes). Only that run has E's loss follow D's
// and F's rollback start more than 2 minutes into the host: run it for a
// hand-in (both broke there until 2026-10-22).

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { TOKEN_HEADER, alive, cleanEnv, stopRun, writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { name: 'session0-handover', recover: true }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const within = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms) })]).finally(() => clearTimeout(timer))
}
const AGENT = 'ada'
const BACKSTOP_MS = 120000
const PART = process.env.SESSION0_PROOF_PART || 'all'
const ONE = PART !== '2', TWO = PART !== '1'

export default async function (rig) {
  const p = new Proof('session0-handover')
  rig.scenario({
    agents: { [AGENT]: { turns: [{ name: 'hang', match: 'HANDOVER-HANG', steps: [{ text: 'On it.' }, { hang: true }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: AGENT, parent: 'boss', tier: 'opus', title: 'Claude subject' })

  // The run's own engine stops; its data becomes the boot host's.
  const run = rig.run
  writeRun(rig.dir, { busy: new Date().toISOString() })
  await stopRun(rig.dir, { keep: true })

  const data = rig.data
  const exe = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
  const stopKey = `Software\\OrgtreeRigStop-${path.basename(rig.dir)}`
  const ui = path.join(rig.dir, 'host-ui')
  const brokenUi = path.join(rig.dir, 'host-ui-broken')
  fs.mkdirSync(ui, { recursive: true })
  fs.mkdirSync(brokenUi, { recursive: true })
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>rig</title>')
  const env = {
    ...cleanEnv(),
    ORGTREE_V2_DATA: data,
    ORGTREE_V2_UI_DIR: ui,
    ORGTREE_P03_PG_BIN: run.pgBin,
    ORGTREE_ENGINE_SAFE_START: '1',
    ORGTREE_ENGINE_RIG: '1',
    ORGTREE_ENGINE_ALLOW_INITDB: '1',
    ORGTREE_NET_OFFLINE: '1',
    ORGTREE_LOG_VERBOSE: '1',
    ORGTREE_RIG_RECOVER: '1',
    ORGTREE_CLAUDE_BIN: path.join(rig.dir, 'bin', 'claude.exe'),
    ORGTREE_CODEX_BIN: path.join(rig.dir, 'bin', 'codex.exe'),
    ORGTREE_AGY_BIN: path.join(rig.dir, 'bin', 'agy.exe'),
    ORGTREE_TAILSCALE_BIN: path.join(rig.dir, 'bin', 'tailscale.cmd'),
    ORGTREE_FAKECLI_DIR: rig.fakeDir,
    ORGTREE_FAKECLI_HOME: path.join(data, 'rig-home'),
    ORGTREE_RIG_STOP_KEY: stopKey,
  }
  // The boot host stands for Session 0; what the tasks start does not.
  const hostEnv = { ...env, ORGTREE_RIG_SESSION0: '1' }
  const sessionEnv = { ...env, ORGTREE_RIG_SESSION0: '0' }
  fs.writeFileSync(path.join(data, 'rig-user-session-task.json'), JSON.stringify({ exe, args: ['session-launch', 'signin'], env: { ORGTREE_RIG_SESSION0: '0' } }))
  fs.writeFileSync(path.join(data, 'rig-boot-task.json'), JSON.stringify({ exe, args: ['host'], env: { ORGTREE_RIG_SESSION0: '1' } }))

  const descriptor = path.join(data, 'engine-attach.json')
  const marker = path.join(data, 'core-rig-signed-out')
  const bootLogFile = path.join(data, 'diagnostics', 'boot-host.log')
  const size = f => (fs.existsSync(f) ? fs.statSync(f).size : 0)
  const after = (f, from) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(from).toString('utf8') : '')
  const record = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'core-handover.json'), 'utf8')) } catch { return null } }
  const readDescriptor = () => { try { return JSON.parse(fs.readFileSync(descriptor, 'utf8')) } catch { return null } }
  const identity = async d => {
    try {
      const r = await fetch(`http://127.0.0.1:${d.port}/api/desktop/identity`, { headers: { [TOKEN_HEADER]: d.token }, signal: AbortSignal.timeout(5000) })
      return r.ok ? await r.json() : null
    } catch { return null }
  }
  /** The engine serving the root now: its descriptor and identity, once it answers. */
  const serving = async () => {
    const d = readDescriptor()
    if (!d || !alive(d.enginePid)) return null
    const id = await identity(d)
    return id && id.pid === d.enginePid ? { ...d, identity: id } : null
  }
  const waitServing = (what, test = () => true, timeout = 180000) =>
    rig.waitFor(async () => { const s = await serving(); return s && test(s) ? s : null }, { what, timeout, every: 1000 })
  /** The rig's API helpers, pointed at an engine. */
  const at = s => { const v = Object.create(rig); v.run = { ...rig.run, url: `http://127.0.0.1:${s.port}`, token: s.token }; return v }
  const procs = []
  const track = (child, label) => {
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += chunk })
    const exited = new Promise(resolve => child.once('exit', code => resolve({ code, at: Date.now() })))
    procs.push({ child, label })
    return { child, pid: child.pid, exited, stderr: () => stderr }
  }
  const startHost = label => track(spawn(exe, ['host'], { cwd: rig.dir, env: hostEnv, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), label)
  /** The desktop's ask and the task's command, as the task would start it. */
  const ask = restart => fs.writeFileSync(path.join(data, 'session-launch-request.json'), JSON.stringify({ by: 'desktop', restart, atMs: Date.now() }))
  const startLauncher = (label, extra = {}) => track(spawn(exe, ['session-launch', 'signin'], { cwd: rig.dir, env: { ...sessionEnv, ...extra }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), label)
  const restartNotices = from => rig.sql(`SELECT id, body FROM ot.mail WHERE id > ${from} AND body LIKE '[ORGTREE RESTART NOTICE]%' ORDER BY id`)
  const lastMail = () => rig.one('SELECT coalesce(max(id), 0) AS id FROM ot.mail').id
  const kill = (pid, tree = false) => spawnSync('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { encoding: 'utf8', windowsHide: true })
  const reg = args => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })

  let host
  try {
    // ------------------------------------------------------------ A: signed out
    fs.writeFileSync(marker, 'proof')
    let logFrom = size(bootLogFile)
    host = startHost('host-A')
    const a = await waitServing('the boot host to start its engine', s => s.hostPid === host.pid)
    p.check('A: signed out, the boot host runs the engine itself, in Session 0', a.identity.session === 0, { enginePid: a.enginePid, session: a.identity.session, hostPid: a.hostPid })
    p.check('A: it said so in its log', /starting the engine in Session 0/.test(after(bootLogFile, logFrom)))

    // ------------------------------------------------------------ B: sign-in alone
    fs.rmSync(marker, { force: true })
    await sleep(10000)
    const b = await serving()
    p.check('B: signing in moves nothing by itself (Run as admin off: decision 84)', b?.enginePid === a.enginePid && !record(), { enginePid: b?.enginePid })

    let e = null
    if (ONE) {
    // ------------------------------------------------------------ C0: no record, no handover
    // core-handover.json held open without delete sharing, as a reader may
    // hold it: the launcher cannot record its attempt, so it must neither ask
    // the Session 0 engine for admission nor stop it
    const recordFile = path.join(data, 'core-handover.json')
    fs.writeFileSync(recordFile, '{}')
    const quoted = recordFile.replace(/'/g, "''")
    const holder = track(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$f = [System.IO.File]::Open('${quoted}', 'Open', 'Read', 'Read'); [Console]::Out.WriteLine('held'); [Console]::In.ReadLine() | Out-Null; $f.Close()`],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), 'record-holder')
    const held = await within(new Promise(resolve => holder.child.stdout.on('data', chunk => { if (String(chunk).includes('held')) resolve(true) })), 30000)
    logFrom = size(bootLogFile)
    const engineFrom = rig.engineLog().length
    ask(true)
    const l0 = startLauncher('launcher-C0')
    const exitL0 = await within(l0.exited, 60000)
    const still = await serving()
    holder.child.stdin.end()
    await within(holder.exited, 10000)
    fs.rmSync(recordFile, { force: true })
    const logC0 = after(bootLogFile, logFrom)
    p.check('C0: the record held open (no delete sharing)', held === true)
    p.check('C0: unable to record its attempt, the launcher ends without a handover', !!exitL0 && exitL0.code !== 0 && /could not record the attempt/.test(logC0), { exit: exitL0, log: logC0.slice(-400) })
    p.check('C0: the Session 0 engine still serves: no admission, no stop', still?.enginePid === a.enginePid && alive(a.enginePid)
      && !/handing over the engine/.test(logC0) && !/shutdown requested by the desktop/.test(rig.engineLog().slice(engineFrom)), { enginePid: still?.enginePid })

    // ------------------------------------------------------------ C: restart while signed in
    const s0 = at(a)
    const turnsBefore = rig.turns(AGENT).length
    const fakeFrom = rig.fakeLog(AGENT).length
    await s0.userMail(AGENT, 'HANDOVER-HANG while the user is signed in')
    await rig.waitFor(() => rig.fakeLog(AGENT).slice(fakeFrom).some(e => e.kind === 'hang'), { what: `${AGENT} mid-turn`, timeout: 90000 })
    const mailFrom = lastMail()
    logFrom = size(bootLogFile)
    ask(true)
    const t0 = Date.now()
    const l1 = startLauncher('launcher-C')
    const c = await waitServing('the engine in the user\'s session', s => s.enginePid !== a.enginePid && s.hostPid === l1.pid)
    const seconds = Number(((Date.now() - t0) / 1000).toFixed(1))
    p.check('C: the new engine runs in the user\'s session, hosted by the launcher', c.identity.session !== 0 && c.hostPid === l1.pid, { session: c.identity.session, hostPid: c.hostPid, seconds })
    p.check('C: the Session 0 engine is gone', !alive(a.enginePid))
    const rc = record()
    p.check('C: the attempt is recorded ready, after a stop, by the desktop', rc?.phase === 'ready' && rc?.stopped_old === true && rc?.by === 'desktop' && rc?.owner?.pid === l1.pid, rc)
    const logC = after(bootLogFile, logFrom)
    p.check('C: the launcher took the handover and the boot host waited instead of ending',
      /session launch \(desktop\): handing over the engine/.test(logC) && /waiting: (a start in the signed-in session is running|another engine holds the data root)/.test(logC) && alive(host.pid))
    const textC = rig.engineLog()
    p.check('C: the old engine admitted the handover and ran its own shutdown', /shutdown requested by the desktop/.test(textC) && /engine stopping/.test(textC))
    p.check('C: the old engine ended the agent\'s CLI itself', new RegExp(`agent:\\d+/${AGENT} \\S+ runtime\\.actor\\.Actor\\.kill_proc`).test(textC))
    const noticesC = await rig.waitFor(() => restartNotices(mailFrom), { what: 'restart notices from the new engine', timeout: 90000 }).catch(() => [])
    p.check('C: its restart notices name the engine\'s own session', noticesC.length > 0 && noticesC.every(n => /Engine session at start: Windows session \d+\./.test(n.body) && !/Session 0/.test(n.body)),
      noticesC.map(n => n.body.split('\n').slice(2, 3)[0]))
    const resumed = await rig.waitFor(() => rig.turns(AGENT).length > turnsBefore + 1 ? rig.turns(AGENT) : null, { what: `${AGENT}'s turn to resume`, timeout: 120000 }).catch(() => null)
    p.check('C: the agent\'s interrupted turn resumes in the new engine', !!resumed, { turns: resumed?.length })
    const moved = rig.sql(`SELECT body FROM ot.mail WHERE id > ${mailFrom} AND body LIKE '[ORGTREE SESSION NOTICE]%'`)
    p.note('C: session move notices delivered with the resumed turn', { count: moved.length, first: moved[0]?.body?.slice(0, 160) })

    // ------------------------------------------------------------ D: sign-out
    logFrom = size(bootLogFile)
    fs.writeFileSync(marker, 'proof')
    const signedOutAt = Date.now()
    kill(l1.pid, true)
    await rig.waitFor(() => !alive(c.enginePid), { what: 'the session engine to end with the session', timeout: 60000 })
    // the log's own times are whole seconds: watch it closely instead
    const decidedAt = await rig.waitFor(() => /starting the engine in Session 0/.test(after(bootLogFile, logFrom)) ? Date.now() : null,
      { what: 'the boot host to decide on the sign-out', timeout: 60000, every: 100 })
    const d = await waitServing('the boot host to fall back to Session 0', s => s.hostPid === host.pid)
    p.check('D: after sign-out the boot host runs the engine in Session 0 again', d.identity.session === 0, { enginePid: d.enginePid })
    p.check('D: not before three empty readings, 2 s apart', decidedAt - signedOutAt >= 3900, { afterMs: decidedAt - signedOutAt })
    p.check('D: until then it waited instead of starting in Session 0', /waiting: the desktop may recover the lost engine first/.test(after(bootLogFile, logFrom)))
    }

    if (TWO) {
    // ------------------------------------------------------------ E: lost while signed in
    fs.rmSync(marker, { force: true })
    await sleep(8000)
    const d = await serving()
    logFrom = size(bootLogFile)
    const lostAt = Date.now()
    kill(d.enginePid)
    await rig.waitFor(() => !alive(d.enginePid), { what: 'the Session 0 engine to die', timeout: 30000 })
    const quiet = await within(waitServing('anything before the backstop', () => true, BACKSTOP_MS - 15000).catch(() => null), BACKSTOP_MS - 10000)
    p.check('E: for the backstop no engine starts (the desktop would recover it)', !quiet, { started: quiet?.enginePid })
    e = await waitServing('the boot host to run the user-session task', s => s.identity.session !== 0, BACKSTOP_MS + 120000)
    const re = record()
    p.check('E: after the backstop the boot host ran the task; the engine is back in the user\'s session',
      e.identity.session !== 0 && re?.by === 'boot-host' && re?.phase === 'ready' && Date.now() - lostAt >= BACKSTOP_MS, { by: re?.by, afterMs: Date.now() - lostAt })
    p.check('E: the boot host claimed the one recovery and said so', /the engine was lost while the operator is signed in: running the user-session engine task/.test(after(bootLogFile, logFrom)))
    }

    if (ONE) {
    // ------------------------------------------------------------ F: one rollback
    // signed in again; the engine that runs now (Session 0) is handed over
    fs.rmSync(marker, { force: true })
    await sleep(8000)
    const before = await serving()
    logFrom = size(bootLogFile)
    const mailF = lastMail()
    ask(true)
    const l3 = startLauncher('launcher-F', { ORGTREE_V2_UI_DIR: brokenUi })
    const f = await waitServing('the one rollback into Session 0', s => s.hostPid === host.pid && s.enginePid !== before.enginePid)
    const rf = record()
    p.check('F: a replacement that failed after the stop gets exactly one rollback into Session 0',
      f.identity.session === 0 && rf?.phase === 'failed' && rf?.stopped_old === true && rf?.rollback === 'done', rf)
    const exitL3 = await within(l3.exited, 30000)
    p.check('F: the failed launcher ended', !!exitL3 && exitL3.code !== 0, exitL3)
    const logF = after(bootLogFile, logFrom)
    p.check('F: the extra boot host the rollback started left the running one in charge', /another boot host already runs for this data root; leaving/.test(logF))
    const noticesF = await rig.waitFor(() => restartNotices(mailF), { what: 'restart notices from the rollback engine', timeout: 90000 }).catch(() => [])
    p.check('F: its restart notices report the failed move and the rollback',
      noticesF.some(n => /could not start the engine in the signed-in session \(the engine in the signed-in session did not become ready\), so it started the engine in Session 0 instead\./.test(n.body)), noticesF.map(n => n.body.slice(0, 400)))
    await sleep(8000)
    p.check('F: no second attempt follows the rollback', (await serving())?.enginePid === f.enginePid && record()?.id === rf.id)

    // ------------------------------------------------------------ G: the rollback fails too
    logFrom = size(bootLogFile)
    fs.rmSync(path.join(ui, 'index.html'))
    ask(true)
    const l4 = startLauncher('launcher-G', { ORGTREE_V2_UI_DIR: brokenUi })
    const hostExit = await within(host.exited, 180000)
    const rg = record()
    p.check('G: the rollback failed as well: the boot host ends and records it', !!hostExit && rg?.rollback === 'failed' && rg?.phase === 'failed', { exit: hostExit, record: rg })
    fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>rig</title>')
    await within(l4.exited, 30000)
    const retried = startHost('host-G-retry')
    const retryExit = await within(retried.exited, 30000)
    p.check('G: a retried boot host stays out for this sign-in: the engine stays stopped', retryExit?.code === 0 && !(await serving()), retryExit)
    p.check('G: and says why', /stays stopped until it is started again/.test(after(bootLogFile, logFrom)))
    // the user's Start engine: the desktop asks and runs the task
    ask(true)
    const l5 = startLauncher('launcher-G-start')
    const g = await waitServing('Start engine to bring the engine back in the user\'s session', s => s.hostPid === l5.pid)
    p.check('G: Start engine brings it back in the user\'s session', g.identity.session !== 0 && record()?.phase === 'ready')
    }

    if (TWO) {
    // ------------------------------------------------------------ H: the installer's stop
    const g = await serving()
    if (!alive(host.pid)) host = startHost('host-H')
    await sleep(6000)
    p.check('H: a boot host beside the user-session engine waits', alive(host.pid) && g && g.identity.session !== 0 && (await serving())?.enginePid === g.enginePid)
    const recorded = reg(['add', `HKCU\\${stopKey}`, '/v', 'StopRequested', '/t', 'REG_QWORD', '/d', String(Date.now()), '/f'])
    p.check('H: the installer\'s stop request is recorded', recorded.status === 0)
    const hostEnd = await within(host.exited, 60000)
    await rig.waitFor(() => !alive(g.enginePid) && !alive(g.hostPid), { what: 'the user-session engine and its launcher to stop', timeout: 120000 }).catch(() => null)
    p.check('H: the waiting boot host ends for the install (exit 0)', hostEnd?.code === 0, hostEnd)
    p.check('H: the user-session engine and its launcher stop too', !alive(g.enginePid) && !alive(g.hostPid))
    }
  } catch (error) {
    p.check(`no step stopped the proof early (${error.message})`, false)
  } finally {
    reg(['delete', `HKCU\\${stopKey}`, '/f'])
    for (const { child } of procs) if (child.pid && alive(child.pid)) kill(child.pid, true)
    for (const name of ['core-rig-signed-out', 'rig-user-session-task.json', 'rig-boot-task.json', 'session-launch-request.json']) fs.rmSync(path.join(data, name), { force: true })
    p.file('boot-host.log', fs.existsSync(bootLogFile) ? fs.readFileSync(bootLogFile, 'utf8') : '')
    p.file('core-handover.json', record() ?? {})
    for (const { child, label } of procs) p.note(`${label} pid ${child.pid} exit ${child.exitCode}`)
    const left = readDescriptor()
    if (left && alive(left.enginePid)) await fetch(`http://127.0.0.1:${left.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: left.token } }).catch(() => null)
    fs.rmSync(descriptor, { force: true })
  }
  await rig.restart()
  p.keep(rig, { agents: [AGENT], grep: /session launch|handover|boot host|shutdown|stopping|restart notice|failed move|Session 0/i })
  return p.summary()
}
