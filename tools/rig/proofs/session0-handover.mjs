// Proof: the engine always runs in Session 0, and the sign-in helper hosts the
// user's signed-in session (decision 94; docket
// 4-4-0-restarts-and-updates-go-back-into-session-0, the user's strict
// invariants 2026-10-22 07:30:14Z, numbered below). Measured on a real
// `orgtree-engine host` (the boot task's host, standing for Session 0 with
// ORGTREE_RIG_SESSION0=1) over a rig run's data, with real sign-in helpers
// (`orgtree-credential-broker.exe`) as the proof's own children in its
// session, and stand-ins for Windows only where a proof may not act:
//   - the boot task's run (the desktop's restart, an update's last step, a
//     recovery): the proof starts `orgtree-engine host`, the task's action;
//   - sign-out: <data>\core-rig-signed-out, and the helper ended as Windows
//     ends a session's processes;
//   - the installer's stop request: the run's own HKCU key;
//   - a helper with other administrator rights: ORGTREE_RIG_HELPER_ELEVATED.
// No real task, UAC prompt, credential, installation registry key or live
// data is touched. It never writes <data>\rig-helper-task.txt, so the engine's
// helper keepalive never runs a task.
//   A  at boot, signed out: the boot host runs the engine in Session 0 (1);
//      the retired handover command starts nothing (1).
//   B  sign-in within the engine's first 60 s: the helper hosts, with no
//      sign-in notice (part of the engine's start, 6); a turn runs signed in (2, 3).
//   C  the helper alone stops and comes back while the engine runs: one
//      helper-stopped notice and one sign-in notice; a turn sent in between
//      waits for the helper and runs signed in, not in Session 0 (3, 6).
//   D  a restart (graceful stop, then the boot task): the engine is back in
//      Session 0, the helper attaches again by itself (gap measured), a turn
//      sent at once runs signed in, no sign-in/out notice, and the restart
//      notice names Session 0 and the shared rights (1, 5, 6, 7).
//   E  an update (the installer's stop, the helper restarted, the boot task
//      last): as D (1, 5, 6).
//   F  a crash recovery (the engine killed, the boot task again): as D (1, 5, 6).
//   G  a helper with other administrator rights is refused (412) and leaves;
//      one with the engine's rights hosts (7).
//   H  an agent that prefers Session 0 runs there; the tree's
//      session_placement says why (`preference`) (10).
//   I  sign-out mid-turn: the turn is cut and resumes in Session 0 at once;
//      the sign-out notice says the user signed out; session_placement
//      `signed-out` (4, 6, 10).
//   J  signed in with no helper, the first turn after the 60 s grace: it
//      starts at once in Session 0, and the fallback is logged once (3).
// Credentials (9) are credential_bridge's unit tests: the rig has no
// synthetic signed-in broker. A `recover` run: a safe-start engine otherwise
// holds back its restart path. It needs a rig home the helper's descriptor
// trust check accepts (no folder above the data folder that others may
// replace), for example ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-<agent>.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/session0-handover.mjs

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { TOKEN_HEADER, alive, cleanEnv, stopRun, writeRun } from '../lib.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe } from './credential-broker.mjs'

export async function setup() {
  return { name: 'session0-handover', recover: true }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const within = (promise, ms) => {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(null), ms) })]).finally(() => clearTimeout(timer))
}
const AGENT = 'ada'
const PREFERS = 'zed'
const SIGN_IN = '[ORGTREE SIGN-IN NOTICE]'
const SIGN_OUT = '[ORGTREE SIGN-OUT NOTICE]'
const RIGHTS = /Administrator rights: (on|off), for the engine in Session 0 and the sign-in helper alike\./

export default async function (rig) {
  const p = new Proof('session0-handover')
  rig.scenario({
    agents: { [AGENT]: { turns: [{ name: 'hang', match: 'SIGNOUT-HANG', steps: [{ text: 'On it.' }, { hang: true }] }] } },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: AGENT, parent: 'boss', tier: 'opus', title: 'Claude subject' })
  await rig.op({ op: 'hire', name: PREFERS, parent: 'boss', tier: 'opus', title: 'Prefers Session 0' })

  // The run's own engine stops; its data becomes the boot host's.
  const run = rig.run
  writeRun(rig.dir, { busy: new Date().toISOString() })
  await stopRun(rig.dir, { keep: true })

  const data = rig.data
  const exe = path.join(rig.dir, 'bin', 'orgtree-engine.exe')
  const helperBin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  fs.copyFileSync(brokerExe(), helperBin)
  const stopKey = `Software\\OrgtreeRigStop-${path.basename(rig.dir)}`
  const ui = path.join(rig.dir, 'host-ui')
  fs.mkdirSync(ui, { recursive: true })
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
  // The boot host stands for Session 0.
  const hostEnv = { ...env, ORGTREE_RIG_SESSION0: '1' }

  const descriptor = path.join(data, 'engine-attach.json')
  const marker = path.join(data, 'core-rig-signed-out')
  const helperLogFile = path.join(data, 'credential-broker.log')
  const size = f => (fs.existsSync(f) ? fs.statSync(f).size : 0)
  const after = (f, from) => (fs.existsSync(f) ? fs.readFileSync(f).subarray(from).toString('utf8') : '')
  const placement = () => { try { return JSON.parse(fs.readFileSync(path.join(data, 'session-placement.json'), 'utf8')).placement } catch { return null } }
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
    rig.waitFor(async () => { const s = await serving(); return s && test(s) ? s : null }, { what, timeout, every: 250 })
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
  const startHelper = (label, extra = {}) => track(spawn(helperBin, [], { cwd: rig.dir, env: { ...env, ...extra }, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }), label)
  const kill = (pid, tree = false) => spawnSync('taskkill', ['/PID', String(pid), ...(tree ? ['/T'] : []), '/F'], { encoding: 'utf8', windowsHide: true })
  const reg = args => spawnSync('reg', args, { encoding: 'utf8', windowsHide: true })
  const lastMail = () => Number(rig.one('SELECT coalesce(max(id), 0) AS id FROM ot.mail').id)
  const notices = (from, name, prefix) => rig.sql(`SELECT m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE m.id > ${from} AND a.name = '${name}' AND m.body LIKE '${prefix}%' ORDER BY m.id`).map(m => m.body)
  const restartNotices = from => rig.sql(`SELECT body FROM ot.mail WHERE id > ${from} AND body LIKE '[ORGTREE RESTART NOTICE]%' ORDER BY id`).map(m => m.body)
  const logFrom = () => rig.engineLog().length
  const logSince = from => rig.engineLog().slice(from)
  /** The engine admitted this helper as a host (logged once per engine and helper). */
  const hosts = (from, pid) => new RegExp(`Sign-in helper took the Codex host slot pid=${pid}\\b`).test(logSince(from))
  const waitHosts = (from, helper, what) => rig.waitFor(() => hosts(from, helper.pid) ? Date.now() : null, { what, timeout: 60000, every: 100 })
  const placed = name => { const x = rig.agentRow(name)?.extra ?? {}; return { session: x.session ?? null, reason: x.session_reason ?? null, at: x.session_at ?? null } }
  /** A turn for `name`, sent to engine `s`, run to its end. */
  const turn = async (s, name, token, timeout = 150000) => {
    const before = rig.turns(name).length
    await at(s).userMail(name, token)
    return rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t.at(-1) : null }, { what: `${name}'s ${token} turn`, timeout })
  }
  /** The last CLI the engine started for `name` since `from`, and whether a helper hosts it. */
  const launched = (from, name) => {
    const id = rig.agentRow(name)?.id
    const line = logSince(from).split(/\r?\n/).filter(l => l.includes(`CLI started agent=${id} `)).at(-1) ?? ''
    return { line: line.slice(0, 220), hosted: / hosted=true\b/.test(line) }
  }
  const waited = (from, name) => (logSince(from).match(new RegExp(`the turn waited for the sign-in helper, which connected.*agent=${name}\\b.*?waited_ms=(\\d+)|agent=${name}\\b.*?waited_ms=(\\d+).*the turn waited for the sign-in helper, which connected`)) ?? [])
    .slice(1).find(Boolean)
  const treeNode = async (s, name) => {
    const find = v => {
      if (!v || typeof v !== 'object') return null
      // a tree record's id is the agent's name
      if ((v.id === name || v.name === name) && 'session_placement' in v) return v
      for (const x of Object.values(v)) { const r = find(x); if (r) return r }
      return null
    }
    return find(await at(s).api('GET', `/api/orgs/${rig.org}`))
  }
  const gaps = {}

  let host, helper
  try {
    // ------------------------------------------------------------ A: boot, signed out
    fs.writeFileSync(marker, 'proof')
    host = startHost('host-A')
    const a = await waitServing('the boot host to start its engine', s => s.hostPid === host.pid)
    p.check('A (1): at boot the boot host runs the engine in Session 0', a.identity.session === 0, { enginePid: a.enginePid, session: a.identity.session })
    const retired = spawnSync(exe, ['session-launch', 'signin'], { cwd: rig.dir, env: hostEnv, encoding: 'utf8', windowsHide: true, timeout: 30000 })
    p.check('A (1): the retired handover command starts nothing', retired.status !== 0 && /unknown command/.test(retired.stderr)
      && (await serving())?.enginePid === a.enginePid, { status: retired.status, stderr: retired.stderr.trim().slice(0, 160) })
    const elevated = a.identity.elevated === true

    // ------------------------------------------------------------ B: sign-in during the engine's start
    let mark = lastMail()
    let from = logFrom()
    fs.rmSync(marker, { force: true })
    helper = startHelper('helper-B')
    await waitHosts(from, helper, 'the helper to host')
    await rig.waitFor(() => placement() === 'signed-in' || null, { what: 'signed-in placement', timeout: 20000 })
    p.check('B (2): the sign-in helper, in the user\'s session, hosts the engine\'s agents', alive(helper.pid) && hosts(from, helper.pid))
    const tb = await turn(a, AGENT, 'B-TURN')
    p.check('B (3): a turn runs in the signed-in session', placed(AGENT).session === 'signed-in' && launched(from, AGENT).hosted && !tb.error,
      { placed: placed(AGENT), launch: launched(from, AGENT).line })
    p.check('B (6): a sign-in within the engine\'s first 60 s is part of its start: no sign-in notice', notices(mark, AGENT, SIGN_IN).length === 0,
      notices(mark, AGENT, SIGN_IN))

    // ------------------------------------------------------------ C: the helper alone, down and up
    mark = lastMail()
    from = logFrom()
    kill(helper.pid, true)
    await within(helper.exited, 10000)
    await rig.waitFor(() => placement() === 'session0' || null, { what: 'the debounced helper loss', timeout: 20000 })
    const sent = Date.now()
    const turnC = turn(a, AGENT, 'C-TURN')
    await sleep(10000)
    const gapLaunch = launched(from, AGENT)
    p.check('C (3): with the user signed in, a turn sent after the loss waits for the helper: no CLI in Session 0 after 10 s',
      gapLaunch.line === '' && placed(AGENT).session === 'signed-in', { launch: gapLaunch.line, placed: placed(AGENT) })
    const fromC = logFrom()
    helper = startHelper('helper-C')
    await waitHosts(fromC, helper, 'the new helper to host')
    const tc = await turnC
    const waitedC = Number(waited(from, AGENT) ?? -1)
    p.check('C (3): it ran in the signed-in session once the helper came back, never in Session 0',
      placed(AGENT).session === 'signed-in' && launched(from, AGENT).hosted && !tc.error && waitedC >= 9000,
      { placed: placed(AGENT), waitedMs: waitedC, afterSendMs: Date.now() - sent })
    await rig.waitFor(() => placement() === 'signed-in' || null, { what: 'signed-in placement again', timeout: 20000 })
    await rig.waitFor(() => notices(mark, AGENT, SIGN_IN).length > 0 || null, { what: 'the sign-in notice', timeout: 30000 }).catch(() => null)
    const downC = notices(mark, AGENT, SIGN_OUT), upC = notices(mark, AGENT, SIGN_IN)
    p.check('C (6): one notice each way while the engine kept running; the down one says the user is still signed in',
      downC.length === 1 && upC.length === 1 && downC[0].startsWith(`${SIGN_OUT} Orgtree's sign-in helper stopped while the user is still signed in`)
      && upC[0].startsWith(`${SIGN_IN} Orgtree's sign-in helper connected`), { down: downC.map(n => n.slice(0, 140)), up: upC.map(n => n.slice(0, 140)) })
    p.check('C: no session move notice: the agent never ran in Session 0', notices(mark, AGENT, '[ORGTREE SESSION NOTICE]').length === 0)

    // ------------------------------------------------------------ D, E, F: the engine cycles
    /** The engine is back in Session 0, the helper hosts again, a turn sent at once runs signed in, and no sign-in/out notice. */
    const cycled = async (step, s, started, mailMark, from) => {
      const served = Date.now()
      const sentTurn = turn(s, AGENT, `${step}-TURN`)
      const connected = await waitHosts(from, helper, `${step}: the helper to host the new engine`)
      const t = await sentTurn
      gaps[step] = { bootTaskToServingMs: served - started, servingToHelperMs: connected - served, bootTaskToHelperMs: connected - started }
      p.check(`${step} (1): the engine is back in Session 0`, s.identity.session === 0, { enginePid: s.enginePid, session: s.identity.session })
      p.check(`${step} (5): the helper hosts again by itself; restart → helper connected measured`, alive(helper.pid) && connected >= served, gaps[step])
      p.check(`${step} (5): a turn sent as the engine served ran in the signed-in session, not Session 0`,
        placed(AGENT).session === 'signed-in' && launched(from, AGENT).hosted && !t.error,
        { placed: placed(AGENT), launch: launched(from, AGENT).line, waitedMs: waited(from, AGENT) ?? null })
      await sleep(8000)
      p.check(`${step} (6): engine and helper cycled together: no sign-in or sign-out notice`,
        notices(mailMark, AGENT, '[ORGTREE SIGN-').length === 0 && notices(mailMark, AGENT, '[ORGTREE SESSION NOTICE]').length === 0,
        notices(mailMark, AGENT, '[ORGTREE SIGN-'))
      const restarts = await rig.waitFor(() => { const r = restartNotices(mailMark); return r.length ? r : null }, { what: `${step}: restart notices`, timeout: 60000 }).catch(() => [])
      p.check(`${step} (1, 7): the restart notice names Session 0 and the rights the engine and the helper share`,
        restarts.length > 0 && restarts.every(b => b.includes('Engine session at start: Session 0.') && (b.match(RIGHTS)?.[1] === (elevated ? 'on' : 'off'))),
        restarts.map(b => b.split('\n').slice(2, 4)))
    }
    // D: the desktop's restart: a graceful stop, then the boot task
    let before = await serving()
    mark = lastMail()
    from = logFrom()
    await fetch(`http://127.0.0.1:${before.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: before.token } })
    p.check('D: the boot host ends with its engine after the graceful stop', !!(await within(host.exited, 120000)))
    let started = Date.now()
    host = startHost('host-D')
    let s = await waitServing('D: the engine started by the boot task', x => x.hostPid === host.pid && x.enginePid !== before.enginePid)
    await cycled('D', s, started, mark, from)

    // E: an update: the installer stops the boot tree and the helper, runs the helper task, then the boot task
    before = s
    mark = lastMail()
    from = logFrom()
    p.check('E: the installer\'s stop request is recorded', reg(['add', `HKCU\\${stopKey}`, '/v', 'StopRequested', '/t', 'REG_QWORD', '/d', String(Date.now()), '/f']).status === 0)
    const hostEnd = await within(host.exited, 120000)
    await rig.waitFor(() => !alive(before.enginePid) || null, { what: 'E: the engine to stop for the install', timeout: 120000 })
    p.check('E: the boot host and its engine stop for the install', !!hostEnd && !alive(before.enginePid), hostEnd)
    reg(['delete', `HKCU\\${stopKey}`, '/f'])
    kill(helper.pid, true)
    await within(helper.exited, 10000)
    started = Date.now()
    helper = startHelper('helper-E')
    host = startHost('host-E')
    s = await waitServing('E: the updated engine', x => x.hostPid === host.pid)
    await cycled('E', s, started, mark, from)

    // F: a crash recovery: the engine killed, the boot task run again
    before = s
    mark = lastMail()
    from = logFrom()
    kill(before.enginePid)
    await rig.waitFor(() => !alive(before.enginePid) || null, { what: 'F: the engine to die', timeout: 30000 })
    await within(host.exited, 60000)
    started = Date.now()
    host = startHost('host-F')
    s = await waitServing('F: the recovered engine', x => x.hostPid === host.pid && x.enginePid !== before.enginePid)
    await cycled('F', s, started, mark, from)
    p.note('restart → helper connected gaps (ms)', gaps)

    // ------------------------------------------------------------ G: rights
    from = logFrom()
    const brokerFrom = size(helperLogFile)
    const other = startHelper('helper-G-other', { ORGTREE_RIG_HELPER_SESSION: '7', ORGTREE_RIG_HELPER_ELEVATED: elevated ? '0' : '1' })
    const otherExit = await within(other.exited, 30000)
    const brokerLog = after(helperLogFile, brokerFrom)
    p.check('G (7): a helper with other administrator rights is refused and leaves',
      !!otherExit && /Sign-in helper refused: it runs with other administrator rights than the engine/.test(logSince(from))
      && !hosts(from, other.pid) && /refused: the engine runs with other administrator rights/.test(brokerLog) && /leaving: the helper's task starts one/.test(brokerLog),
      { exit: otherExit, broker: brokerLog.split(/\r?\n/).filter(l => l.includes(`pid ${other.pid} `)).slice(-4) })
    const same = startHelper('helper-G-same', { ORGTREE_RIG_HELPER_SESSION: '7', ORGTREE_RIG_HELPER_ELEVATED: elevated ? '1' : '0' })
    await waitHosts(from, same, 'G: the helper with the engine\'s rights to host').catch(() => 0)
    p.check('G (7): a helper with the engine\'s rights hosts', hosts(from, same.pid) && alive(same.pid))
    kill(same.pid, true)
    await within(same.exited, 10000)

    // ------------------------------------------------------------ H: the agent's own preference
    await at(s).api('POST', `/api/orgs/${rig.org}/nodes/${PREFERS}/scope`, { session: 'session0' })
    from = logFrom()
    await turn(s, PREFERS, 'H-TURN')
    const zed = await treeNode(s, PREFERS)
    p.check('H (10): a Session 0 preference runs there while the helper hosts; the tree says why',
      placed(PREFERS).session === 'session0' && placed(PREFERS).reason === 'preference' && !launched(from, PREFERS).hosted
      && zed?.session_placement?.session === 'session0' && zed?.session_placement?.reason === 'preference' && !!zed?.session_placement?.at,
      { placed: placed(PREFERS), tree: zed?.session_placement })
    const adaNode = await treeNode(s, AGENT)
    p.check('H (10): a signed-in placement has no reason', adaNode?.session_placement?.session === 'signed-in' && adaNode?.session_placement?.reason === null,
      adaNode?.session_placement)

    // ------------------------------------------------------------ I: sign-out mid-turn
    mark = lastMail()
    from = logFrom()
    const turnsBefore = rig.turns(AGENT).length
    const fakeFrom = rig.fakeLog(AGENT).length
    await at(s).userMail(AGENT, 'SIGNOUT-HANG while signed in')
    await rig.waitFor(() => rig.fakeLog(AGENT).slice(fakeFrom).some(e => e.kind === 'hang') || null, { what: `${AGENT} mid-turn`, timeout: 90000 })
    // its CLI may be the warm one an earlier turn started: the last launch counts
    p.check('I: the turn runs hosted', placed(AGENT).session === 'signed-in' && launched(0, AGENT).hosted, launched(0, AGENT).line)
    fs.writeFileSync(marker, 'proof')
    const signedOut = Date.now()
    kill(helper.pid, true)
    const resumed = await rig.waitFor(() => { const t = rig.turns(AGENT); return t.length >= turnsBefore + 2 && t.every(x => x.ended_at) ? t : null },
      { what: `${AGENT}'s resumed turn`, timeout: 120000 }).catch(() => null)
    const cut = resumed?.[turnsBefore]
    p.check('I (4): at sign-out the running turn is cut and resumes in Session 0 at once',
      !!cut && cut.error === "the user's Windows session ended" && placed(AGENT).session === 'session0' && placed(AGENT).reason === 'signed-out'
      && !launched(from, AGENT).hosted && Date.now() - signedOut < 60000,
      { cut: cut?.error, placed: placed(AGENT), resumeMs: Date.now() - signedOut })
    await rig.waitFor(() => notices(mark, PREFERS, SIGN_OUT).length > 0 || null, { what: 'the sign-out notice', timeout: 30000 }).catch(() => null)
    const outI = notices(mark, PREFERS, SIGN_OUT)
    p.check('I (6): one sign-out notice, saying the user signed out', outI.length === 1 && outI[0].startsWith(`${SIGN_OUT} The user signed out`), outI.map(n => n.slice(0, 120)))
    const adaOut = await treeNode(s, AGENT)
    p.check('I (10): the tree says Session 0, signed out', adaOut?.session_placement?.session === 'session0' && adaOut?.session_placement?.reason === 'signed-out',
      adaOut?.session_placement)

    // ------------------------------------------------------------ J: the grace ran out before the first turn
    // rig-sol-b's finding on a1f6c43: signed in, no helper, and the stretch's
    // first turn arrives after the 60 s grace: it starts at once in Session 0,
    // and that fallback is logged, once per stretch (3)
    before = s
    fs.rmSync(marker, { force: true })
    await fetch(`http://127.0.0.1:${before.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: before.token } })
    await within(host.exited, 120000)
    from = logFrom()
    mark = lastMail()
    host = startHost('host-J')
    s = await waitServing('J: the engine, signed in, with no helper', x => x.hostPid === host.pid && x.enginePid !== before.enginePid)
    await sleep(65000)
    const fallbacks = () => (logSince(from).match(/the sign-in helper did not connect in time while the user is signed in/g) ?? []).length
    const sentJ = Date.now()
    const tj = await turn(s, AGENT, 'J-LATE-TURN', 60000)
    p.check('J (3): a first turn after the grace ran out starts at once in Session 0, and the fallback is logged',
      Date.now() - sentJ < 20000 && placed(AGENT).session === 'session0' && placed(AGENT).reason === 'helper-unreachable' && fallbacks() === 1 && !tj.error,
      { turnMs: Date.now() - sentJ, placed: placed(AGENT), fallbacks: fallbacks() })
    await turn(s, AGENT, 'J-SECOND-TURN', 60000)
    p.check('J (3): once per stretch: the next turn logs no second fallback', fallbacks() === 1 && placed(AGENT).session === 'session0', { fallbacks: fallbacks() })
    p.check('J (6): the engine cycled alone, with no helper: no sign-in or sign-out notice', notices(mark, AGENT, '[ORGTREE SIGN-').length === 0,
      notices(mark, AGENT, '[ORGTREE SIGN-'))
  } catch (error) {
    p.check(`no step stopped the proof early (${error.message})`, false)
  } finally {
    reg(['delete', `HKCU\\${stopKey}`, '/f'])
    const left = readDescriptor()
    if (left && alive(left.enginePid)) await fetch(`http://127.0.0.1:${left.port}/api/desktop/shutdown`, { method: 'POST', headers: { [TOKEN_HEADER]: left.token } }).catch(() => null)
    if (host) await within(host.exited, 90000)
    for (const { child } of procs) if (child.pid && alive(child.pid)) kill(child.pid, true)
    fs.rmSync(marker, { force: true })
    p.file('credential-broker.log', fs.existsSync(helperLogFile) ? fs.readFileSync(helperLogFile, 'utf8') : '')
    p.file('session-placement.json', placement() ?? {})
    for (const { child, label } of procs) p.note(`${label} pid ${child.pid} exit ${child.exitCode}`)
    fs.rmSync(descriptor, { force: true })
  }
  await rig.restart()
  p.keep(rig, { agents: [AGENT, PREFERS], grep: /sign-in helper|Sign-in helper|session|restart notice|Session 0|shutdown|stopping/i })
  return p.summary()
}
