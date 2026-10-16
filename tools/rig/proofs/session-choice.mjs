// Proof: sign-in and sign-out notices, the sign-in watchdog event and early
// checkup, the helper keepalive, and the choice among the user's sessions
// (docket let-agents-query-machine-sign-in-state-and-which; the user,
// 2026-10-16 12:07Z, 12:12Z and 12:13Z). Set up as session-upgrade.mjs (fake
// CLIs, --session0 1, sign-in helpers through temporary interactive tasks):
// helper A stands for the user's session, helper B (ORGTREE_RIG_HELPER_SESSION
// =7) for a second, synthetic one, both described in <data>\rig-sessions.json;
// the user's sign-in comes from the core monitor's debug-rig stand-in.
//   1. sign-in (helper A comes up): ann's running Session 0 turn takes the
//      [ORGTREE SIGN-IN NOTICE] at its next tool boundary; idle flo gets it
//      passively, no turn; dee (prefers Session 0) is told she stays; eve,
//      who picked Session 0 for her next turn (`use` 0), is told that, and
//      her watchdog on session.signed_in fires a turn that runs there; cal
//      (working, no docket work, idle) gets its checkup at once, and it runs
//      in A's session;
//   2. keepalive: A killed while the user stays signed in; the engine starts
//      A's task after 30 s (the task the proof names), and A hosts again;
//   3. two sessions: orgtree_session lists Session 0, A's session and 7;
//      ann prefers "remote" and restarts: her new turn runs under helper B;
//      she picks Session 0 on demand and restarts: the engine starts it; dee
//      stays in Session 0 throughout;
//   4. one of two sessions ends (rig-sol-b's finding on 0bc97a4): ann
//      prefers "remote,console"; helper B dies during her turn in session 7
//      while A stays: the turn stops as "the user's Windows session ended",
//      ONE new turn starts by itself within seconds, under A (placed as
//      usual), with one codex-session-ended line and no sign-out notice; with
//      B back, a turn ann ends herself as B dies again is not resumed;
//   5. sign-out (stand-in signed out, helpers killed): idle flo gets the
//      [ORGTREE SIGN-OUT NOTICE] passively.
// A `recover` run: a safe-start rig engine otherwise delivers every watchdog
// fire as a passive notice, so eve's dog could not wake her in step 1.
// Run it like session-upgrade.mjs (a rig home the descriptor's trust check
// accepts):
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/session-choice.mjs

import fs from 'node:fs'
import path from 'node:path'

import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe, ps, sessionLauncher } from './credential-broker.mjs'

export async function setup() {
  return { name: 'session-choice', 'boot-isolated': true, session0: '1', fixture: 'none', recover: true }
}

const sessionOf = pid => { const o = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).SessionId`); return o === '' ? null : Number(o) }
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`) || 0)
const alive = pid => !!pid && sessionOf(pid) !== null
const kill = pid => { if (pid) try { process.kill(pid) } catch {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const pidsOf = exe => (ps(`(Get-Process orgtree-credential-broker -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${exe.replace(/'/g, "''")}' }).Id`) || '')
  .split(/\s+/).filter(Boolean).map(Number)
const ASK = { tool: 'orgtree_session', args: {} }
const RESTARTED = 'You ended your previous turn yourself'
const CONTINUE = 'Windows session ended while you were working'
const restart = name => ({ tool: 'orgtree_interrupt', args: { node: name, restart: true } })

export default async function (rig) {
  const stateHome = process.env.ORGTREE_RIG_HOME
  if (process.env.ORGTREE_RIG_EVIDENCE_HOME) process.env.ORGTREE_RIG_HOME = process.env.ORGTREE_RIG_EVIDENCE_HOME
  const p = new Proof('session-choice')
  if (stateHome === undefined) delete process.env.ORGTREE_RIG_HOME
  else process.env.ORGTREE_RIG_HOME = stateHome
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  rig.scenario({
    agents: {
      ann: { turns: [
        { name: 'restarted', match: [RESTARTED], steps: [ASK, { text: 'OK.' }] },
        { name: 'wait', match: ['PROOF-WAIT'], once: true, steps: [{ poll_mail: { every_ms: 1000, timeout_ms: 120000 } }, { text: 'OK.' }] },
        { name: 'remote', match: ['PROOF-REMOTE'], once: true, steps: [{ tool: 'orgtree_session', args: { prefer: 'remote' } }, restart('ann'), { sleep_ms: 60000 }] },
        { name: 'zero', match: ['PROOF-ZERO'], once: true, steps: [{ tool: 'orgtree_session', args: { use: 0 } }, restart('ann'), { sleep_ms: 60000 }] },
        { name: 'order', match: ['PROOF-ORDER'], once: true, steps: [{ tool: 'orgtree_session', args: { prefer: 'remote,console' } }, { text: 'OK.' }] },
        { name: 'long', match: ['PROOF-LONG'], once: true, steps: [{ sleep_ms: 90000 }, { text: 'OK.' }] },
        { name: 'resumed', match: [CONTINUE], steps: [ASK, { text: 'OK.' }] },
        { name: 'quit', match: ['PROOF-QUIT'], once: true, steps: [{ tool: 'orgtree_interrupt', args: { node: 'ann' } }, { sleep_ms: 60000 }, { text: 'OK.' }] },
        { name: 'ask', match: ['PROOF-ASK'], steps: [ASK, { text: 'OK.' }] },
      ] },
      cal: { turns: [
        { name: 'work', match: ['PROOF-WORK'], once: true, steps: [
          { tool: 'orgtree_status', args: { status: 'working', summary: 'Working on the proof.' } },
          { text: 'OK.' }] },
      ] },
      eve: { turns: [
        { name: 'dog', match: ['PROOF-DOG'], once: true, steps: [
          { tool: 'orgtree_watchdog', args: { action: 'create', kind: 'event', target: 'session.signed_in', once: true, name: 'signin' } },
          { tool: 'orgtree_session', args: { use: 0 } }, { text: 'OK.' }] },
      ] },
      dee: { turns: [{ name: 'ask', match: ['PROOF-ASK'], steps: [ASK, { text: 'OK.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const answers = name => rig.fakeLog(name).filter(l => l.tool === 'orgtree_session' && typeof l.text === 'string')
    .map(l => { try { return JSON.parse(l.text) } catch { return { unparsed: l.text } } })
  const results = (name, tool) => rig.fakeLog(name).filter(l => l.kind === 'tool_result' && l.tool === tool)
  const prompts = name => rig.fakeLog(name).filter(l => l.kind === 'turn').map(l => l.prompt ?? '')
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const killRecord = () => { try { return fs.readFileSync(path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log'), 'utf8') } catch { return '' } }
  const wakes = name => rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = '${name}' AND m.body LIKE '%${CONTINUE}%'`).length
  const of = (name, re) => lines(re).filter(l => l.includes(`/${name} `))
  // the harness's own launch line (`runtime.claude: CLI started agent=1 pid=22100 ... hosted=false`); a bare
  // /CLI started/ also matches the logged prompt text ("as it was when your CLI started"), which has no pid
  const LAUNCH = / runtime\.(?:claude|agy|codex|muse|opencode|acp): CLI started agent=\d+ pid=[1-9]\d* /
  const started = name => of(name, LAUNCH).at(-1) ?? ''
  const pidIn = l => Number((l.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  const mail = (name, like) => rig.sql(`SELECT m.state, m.turn_id, m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = '${name}' AND m.body LIKE '${like.replace(/'/g, "''")}' ORDER BY m.id`)
  const quiet = (what, timeout = 90000) => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout })
  async function turn(name, token, timeout = 90000) {
    const before = rig.turns(name).length
    await rig.userMail(name, `${token}: one turn, please.`)
    await rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t : null }, { what: `${name}'s ${token} turn`, timeout })
    return rig.turns(name).at(-1)
  }
  const signedOut = path.join(rig.data, 'core-rig-signed-out')
  const stand = (file, v) => v === null ? fs.rmSync(path.join(rig.data, file), { force: true }) : fs.writeFileSync(path.join(rig.data, file), v)

  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const base = path.basename(rig.dir)
  const helpers = {}
  for (const k of ['a', 'b']) {
    const dir = path.join(rig.dir, `helper-${k}`)
    fs.mkdirSync(dir, { recursive: true })
    const bin = path.join(dir, 'orgtree-credential-broker.exe')
    helpers[k] = { task: `OrgtreeRigProof-${base}-${k}`, bin, launcher: sessionLauncher(dir, `OrgtreeRigProof-${base}-${k}`), pid: 0 }
  }
  const startHelper = async (k, env = {}) => {
    const h = helpers[k]
    fs.copyFileSync(exe, h.bin)
    await h.launcher.start({ ORGTREE_V2_DATA: rig.data, ...env }, `"${h.bin}"`)
    h.pid = await rig.waitFor(() => pidsOf(h.bin)[0] || null, { timeout: 20000, what: `helper ${k}` })
    return h.pid
  }
  // the engine runs before the proof starts: its watcher reads from 15 s on
  const t0 = Date.now()
  try {
    const engine = (await rig.api('GET', '/api/desktop/identity')).pid
    const identity = await rig.api('GET', '/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))
    await seed(rig, { org: { name: 'Session Choice Org' }, agents: [
      { name: 'ann', tier: 'haiku', charter: 'You move between sessions.' },
      { name: 'flo', tier: 'flash', charter: 'You stay idle.' },
      { name: 'cal', tier: 'haiku', charter: 'You keep working.' },
      { name: 'dee', tier: 'haiku', charter: 'You prefer Session 0.' },
      { name: 'eve', tier: 'haiku', charter: 'You wait for the sign-in.' },
    ] })
    await rig.api('POST', `/api/orgs/${rig.org}/nodes/dee/scope`, { session: 'session0' })
    await quiet('seeding to settle')
    // ---- 0. before sign-in, in Session 0
    stand('core-rig-signed-out', 'debug rig WTS input only')
    await turn('cal', 'PROOF-WORK')
    await turn('eve', 'PROOF-DOG')
    await turn('dee', 'PROOF-ASK')
    // the sign-in checkup needs no docket work (the coordinator's correction of 2c, 2026-10-16 13:03Z)
    const calStatus = results('cal', 'orgtree_status').at(-1)
    const calWork = rig.sql(`SELECT w.slug FROM ot.work_items w JOIN ot.agents a ON a.id = w.owner_agent_id WHERE a.name = 'cal'`)
    p.check('0 eve armed a watchdog on session.signed_in and picked Session 0 for her next turn; cal reported working and owns no docket item',
      !results('eve', 'orgtree_watchdog').at(-1)?.is_error && answers('eve').at(-1)?.use === 0 && calStatus && !calStatus.is_error && calWork.length === 0,
      { dog: results('eve', 'orgtree_watchdog').at(-1), eve: answers('eve').at(-1), status: calStatus, work: calWork })
    p.check('0 dee prefers Session 0 (set in Agent settings) and orgtree_session reports it', answers('dee').at(-1)?.preference === 'session0', answers('dee').at(-1))
    // the watcher starts reading 15 s after the engine's start
    await sleep(Math.max(0, 16000 - (Date.now() - t0)))

    // ---- 1. sign-in during ann's turn
    stand('core-rig-signed-out', null)
    const annBefore = rig.turns('ann').length
    const counts = Object.fromEntries(['flo', 'cal', 'dee', 'eve'].map(n => [n, rig.turns(n).length]))
    await rig.userMail('ann', 'PROOF-WAIT: wait for mail.')
    await rig.waitFor(() => rig.turns('ann').length > annBefore && !rig.turns('ann').at(-1).ended_at || null, { what: "ann's turn", timeout: 30000 })
    const annTurn = rig.turns('ann').at(-1)
    await startHelper('a')
    await rig.waitFor(() => lines(/where new turns run changed/).length >= 1 || null, { what: 'the sign-in to be announced', timeout: 30000 })
    const inTurn = await rig.waitFor(() => mail('ann', '[ORGTREE SIGN-IN NOTICE]%').find(m => m.state === 'delivered') || null,
      { what: "ann's notice", timeout: 30000 }).catch(() => null)
    p.check("1 ann's running Session 0 turn took the sign-in notice at its next tool boundary", inTurn?.turn_id === annTurn.id
      && rig.fakeLog('ann').some(l => l.kind === 'poll_mail' && l.delivered), { inTurn, turn: annTurn.id })
    await sleep(8000)
    const floNote = mail('flo', '[ORGTREE SIGN-IN NOTICE]%')
    p.check('1 idle flo got the sign-in notice passively, and no turn', floNote.length === 1 && floNote[0].state === 'pending' && rig.turns('flo').length === counts.flo,
      { floNote, turns: rig.turns('flo').length - counts.flo })
    const deeNote = mail('dee', '[ORGTREE SIGN-IN NOTICE]%')
    p.check('1 dee was told her preference keeps her in Session 0', deeNote.length === 1 && /keeps your next turn in Windows Session 0/.test(deeNote[0].body), deeNote)
    p.check("1 eve's watchdog on session.signed_in woke her", rig.turns('eve').length > counts.eve && prompts('eve').at(-1)?.includes('signin'),
      { turns: rig.turns('eve').length - counts.eve, prompt: prompts('eve').at(-1)?.slice(-400) })
    const eveNote = mail('eve', '[ORGTREE SIGN-IN NOTICE]%')
    p.check('1 eve, who picked Session 0 for her next turn, was told so, and her woken turn ran in Session 0',
      eveNote.length === 1 && /you picked Windows Session 0 for your next turn/.test(eveNote[0].body) && parentOf(pidIn(started('eve'))) === engine,
      { eveNote, line: started('eve') })
    const checkup = rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.name = 'cal' AND m.ev->>'variant' = 'reminder.working_checkup'`)
    await quiet('the sign-in turns to end')
    p.check('1 working cal, with no docket work, got its checkup at once, and it ran in the signed-in session', checkup.length === 1 && rig.turns('cal').length > counts.cal
      && parentOf(pidIn(started('cal'))) === helpers.a.pid, { checkup, line: started('cal'), helper: helpers.a.pid })
    await rig.userMail('ann', 'PROOF-GO: done waiting.')
    await quiet("ann's waiting turn to end")

    // ---- 2. keepalive
    stand('rig-helper-task.txt', helpers.a.task)
    const oldA = helpers.a.pid
    kill(oldA)
    const back = await rig.waitFor(() => pidsOf(helpers.a.bin).find(x => x !== oldA) || null, { what: "the engine to start A's task", timeout: 90000 }).catch(() => 0)
    helpers.a.pid = back
    p.check("2 keepalive: with the user signed in and no helper, the engine started the helper's task, and A came back",
      back > 0 && lines(/started the helper's task/).some(l => l.includes(helpers.a.task)), { back, lines: lines(/helper's task/) })
    await rig.waitFor(() => lines(/took the Codex host slot/).length >= 2 || null, { what: 'A to host again', timeout: 30000 })

    // ---- 3. two sessions
    const realA = sessionOf(helpers.a.pid)
    stand('rig-sessions.json', JSON.stringify({ [realA]: { kind: 'console', active: true, user: 'rig' }, 7: { kind: 'remote', active: true, user: 'rig' } }))
    await startHelper('b', { ORGTREE_RIG_HELPER_SESSION: '7' })
    await rig.waitFor(() => lines(/took the Codex host slot.*session=7|session=7.*took the Codex host slot/).length >= 1 || null, { what: 'B to host session 7', timeout: 30000 })
    await turn('ann', 'PROOF-ASK')
    const list = answers('ann').at(-1)
    p.check('3 orgtree_session lists Session 0, A\'s session and 7, with kind, state and user',
      JSON.stringify((list?.sessions ?? []).map(s => [s.id, s.kind]).sort()) === JSON.stringify([[0, 'session0'], [realA, 'console'], [7, 'remote']].sort()), list)
    let n = rig.turns('ann').length
    await rig.userMail('ann', 'PROOF-REMOTE: prefer remote, then restart.')
    await rig.waitFor(() => rig.turns('ann').length >= n + 2 && rig.turns('ann').every(t => t.ended_at) || null, { what: "ann's remote restart", timeout: 60000 })
    const remote = answers('ann').at(-1)
    p.check('3 ann prefers remote and restarted: her new turn runs under helper B, in session 7',
      parentOf(pidIn(started('ann'))) === helpers.b.pid && remote?.this_session === 7 && remote?.preference === 'remote', { remote, line: started('ann'), b: helpers.b.pid })
    n = rig.turns('ann').length
    await rig.userMail('ann', 'PROOF-ZERO: Session 0 on demand, then restart.')
    await rig.waitFor(() => rig.turns('ann').length >= n + 2 && rig.turns('ann').every(t => t.ended_at) || null, { what: "ann's Session 0 restart", timeout: 60000 })
    const zero = answers('ann').at(-1)
    p.check('3 ann picked Session 0 on demand and restarted: the engine started her CLI', parentOf(pidIn(started('ann'))) === engine && zero?.this_session === 0,
      { zero, line: started('ann') })
    await turn('dee', 'PROOF-ASK')
    p.check('3 dee stays in Session 0 with both helpers up', parentOf(pidIn(started('dee'))) === engine && answers('dee').at(-1)?.this_session === 0, answers('dee').at(-1))

    // ---- 4. one of two sessions ends during a turn there
    await turn('ann', 'PROOF-ORDER')
    p.check('4 ann prefers remote, then console', JSON.stringify(answers('ann').at(-1)?.preference) === '["remote","console"]', answers('ann').at(-1))
    const annTurns = rig.turns('ann').length
    const annWakes = wakes('ann')
    const outsB = mail('flo', '[ORGTREE SIGN-OUT NOTICE]%').length
    let logAt = rig.fakeLog('ann').length
    await rig.userMail('ann', 'PROOF-LONG: the long job, please.')
    await rig.waitFor(() => rig.fakeLog('ann').slice(logAt).some(l => l.kind === 'step' && l.step?.sleep_ms) || null, { what: 'ann to be mid-turn', timeout: 60000 })
    const cutPid = pidIn(started('ann'))
    p.check("4 ann's long turn runs under helper B, in session 7", parentOf(cutPid) === helpers.b.pid, { line: started('ann'), b: helpers.b.pid })
    kill(helpers.b.pid)
    const cut = await rig.waitFor(() => { const t = rig.turns('ann')[annTurns]; return t?.ended_at ? t : null }, { what: "ann's cut turn to end", timeout: 30000 })
    const resumed = await rig.waitFor(() => { const t = rig.turns('ann')[annTurns + 1]; return t?.ended_at ? t : null }, { what: "ann's resumed turn", timeout: 60000 })
    const gap = Date.parse(resumed.started_at) - Date.parse(cut.ended_at)
    p.check('4 B died while A stays: the cut turn stopped as "the user\'s Windows session ended", and one new turn started by itself within 15 s, woken once',
      cut.error === "the user's Windows session ended" && gap >= 0 && gap < 15000 && wakes('ann') === annWakes + 1, { cut, resumed, gapMs: gap, wakes: wakes('ann') - annWakes })
    p.check("4 the new turn was placed as usual: under helper A (no remote session left, console next), and its answer says so",
      parentOf(pidIn(started('ann'))) === helpers.a.pid && answers('ann').at(-1)?.this_session === realA, { line: started('ann'), a: helpers.a.pid, answer: answers('ann').at(-1) })
    await sleep(10000)
    const cutLines = killRecord().split(/\r?\n/).filter(l => l.includes('codex-session-ended') && l.includes(`pid=${cutPid} `))
    p.check('4 exactly once: no further turn for ann, one codex-session-ended line for her CLI, and no sign-out notice while A hosts',
      rig.turns('ann').length === annTurns + 2 && cutLines.length === 1 && cutLines[0].includes('who="ann"') && mail('flo', '[ORGTREE SIGN-OUT NOTICE]%').length === outsB,
      { turns: rig.turns('ann').length - annTurns, cutLines, signOut: mail('flo', '[ORGTREE SIGN-OUT NOTICE]%').length - outsB })
    // the deliberate-end guard: a turn ann ends herself as B dies is not resumed
    await startHelper('b', { ORGTREE_RIG_HELPER_SESSION: '7' })
    await rig.waitFor(() => lines(/took the Codex host slot.*session=7|session=7.*took the Codex host slot/).length >= 2 || null, { what: 'B to host session 7 again', timeout: 30000 })
    const quitTurns = rig.turns('ann').length
    logAt = rig.fakeLog('ann').length
    await rig.userMail('ann', 'PROOF-QUIT: end your own turn.')
    await rig.waitFor(() => rig.fakeLog('ann').slice(logAt).some(l => l.kind === 'tool_result' && l.tool === 'orgtree_interrupt') || null, { what: "ann's own interrupt", timeout: 60000 })
    const quitPid = pidIn(started('ann'))
    const quitHost = parentOf(quitPid)
    kill(helpers.b.pid)
    await sleep(15000)
    p.check('4 a turn ann ended herself (under B) as B died again was not resumed: no new turn, no codex-session-ended line for that CLI',
      quitHost === helpers.b.pid && rig.turns('ann').length === quitTurns + 1 && rig.turns('ann').every(t => t.ended_at)
      && !killRecord().split(/\r?\n/).some(l => l.includes('codex-session-ended') && l.includes(`pid=${quitPid} `)),
      { quitHost, b: helpers.b.pid, turns: rig.turns('ann').length - quitTurns, line: started('ann') })

    // ---- 5. sign-out
    await quiet('turns to end before the sign-out')
    const floTurns = rig.turns('flo').length
    // the keepalive's helper death (2) already told everyone once
    const outBefore = mail('flo', '[ORGTREE SIGN-OUT NOTICE]%').length
    stand('core-rig-signed-out', 'debug rig WTS input only')
    kill(helpers.a.pid); kill(helpers.b.pid)
    await rig.waitFor(() => mail('flo', '[ORGTREE SIGN-OUT NOTICE]%').length > outBefore || null, { what: "flo's sign-out notice", timeout: 30000 }).catch(() => null)
    await sleep(5000)
    const out = mail('flo', '[ORGTREE SIGN-OUT NOTICE]%')
    p.check('5 idle flo got the sign-out notice passively, and no turn', out.length === outBefore + 1 && out.at(-1).state === 'pending'
      && rig.turns('flo').length === floTurns, { outBefore, out })
  } finally {
    for (const h of Object.values(helpers)) { for (const pid of pidsOf(h.bin)) kill(pid) }
    for (const f of ['core-rig-signed-out', 'rig-helper-task.txt', 'rig-sessions.json']) stand(f, null)
    for (const h of Object.values(helpers)) p.check(`the temporary task ${h.task} is deleted`, h.launcher.remove())
    p.keep(rig, { agents: ['ann', 'flo', 'cal', 'dee', 'eve'], grep: /CLI started|CLI exit|session|sign-in helper|helper's task|new turns run|[Cc]redential broker/ })
  }
  return p.summary()
}
