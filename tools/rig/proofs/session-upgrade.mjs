// Proof: agents move between Session 0 and the operator's signed-in session at
// their next turn (docket option-to-run-the-background-engine-in-the-user-s; the
// user 2026-10-16 09:37Z: "agents always start at boot, and then automatically
// get upgraded when signed in"). While the sign-in helper hosts, the boot engine
// starts every harness's CLI through it; without the helper it starts them
// itself, in Session 0. The engine reports the boot task's Session 0
// (`--session0 1`), its CLIs are the rig's fake ones, and the helper
// (orgtree-credential-broker.exe) starts through the same temporary interactive
// task as credential-broker.mjs, deleted afterwards.
//   0. before the helper: a Claude seat (ann) and an Antigravity seat (flo) run
//      in CLIs the engine starts; no turn says anything about sessions;
//   1. the helper comes up: each seat's next turn runs in a new CLI, a child of
//      the helper in a non-zero session, and carries the upgrade notice; the CLI
//      the engine started kept running until that turn began;
//   2. a further turn in the signed-in session carries no notice;
//   3. the helper dies during ann's turn (as at sign-out): her hosted CLI ends,
//      the turn stops as "the user's Windows session ended" with no error left
//      on the agent, the mail it held is handed to her next turn, and that turn
//      runs in Session 0 with the downgrade notice and the "continue" message;
//   4. an engine restart: ann comes back in Session 0, which is no move, so no
//      notice, and her restart notice says "Session access at start: Session
//      0."; flo last ran in the signed-in session, so her first turn waits for
//      the helper (until 15 s after the engine's start, logged once) and then
//      moves down to Session 0, and is told so.
// Run with a rig home the descriptor's trust check accepts (no other user may
// write it; see credential-broker.mjs):
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/session-upgrade.mjs

import fs from 'node:fs'
import path from 'node:path'

import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe, brokerPid, ps, sessionLauncher } from './credential-broker.mjs'

export async function setup() {
  return { name: 'session-upgrade', 'boot-isolated': true, session0: '1', fixture: 'none' }
}

const sessionOf = pid => { const o = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).SessionId`); return o === '' ? null : Number(o) }
const parentOf = pid => Number(ps(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`) || 0)
const alive = pid => !!pid && sessionOf(pid) !== null
const kill = pid => { if (pid) try { process.kill(pid) } catch {} }
const done = summary => ({ tool: 'orgtree_status', args: { status: 'done', summary } })
const NOTICE = '[ORGTREE SESSION NOTICE]'
const UP = "You now run in the user's signed-in Windows session"
const DOWN = 'You now run in Windows Session 0'
const CONTINUE = 'Windows session ended while you were working'
const SEATS = ['ann', 'flo']

export default async function (rig) {
  // evidence may go to a D: rig home while the run state needs the profile one (credential-bridge.md)
  const stateHome = process.env.ORGTREE_RIG_HOME
  if (process.env.ORGTREE_RIG_EVIDENCE_HOME) process.env.ORGTREE_RIG_HOME = process.env.ORGTREE_RIG_EVIDENCE_HOME
  const p = new Proof('session-upgrade')
  if (stateHome === undefined) delete process.env.ORGTREE_RIG_HOME
  else process.env.ORGTREE_RIG_HOME = stateHome
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  rig.scenario({
    agents: {
      ann: { turns: [
        { name: 'cut', match: ['PROOF-A-CUT'], once: true, steps: [{ sleep_ms: 120000 }] },
        { name: 'resume', match: ['PROOF-A-CUT', DOWN], steps: [done('PROOF-A-CUT-DONE')] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const prompts = name => rig.fakeLog(name).filter(l => l.kind === 'turn').map(l => l.prompt ?? '')
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const of = (name, re) => lines(re).filter(l => l.includes(`/${name} `))
  const started = name => of(name, /CLI started/).at(-1) ?? ''
  const pidIn = l => Number((l.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  const lastPid = name => pidIn(started(name))
  const hosted = l => / hosted=true/.test(l)
  const placement = name => rig.agentRow(name)?.extra?.session ?? null
  const summary = name => rig.one(`SELECT last_status->>'summary' AS s FROM ot.agents WHERE name = '${name}'`)?.s ?? null
  const quiet = (what, timeout = 60000) => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout })
  async function turn(name, token, timeout = 90000) {
    const before = rig.turns(name).length
    await rig.userMail(name, `${token}: one turn, please.`)
    await rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t : null },
      { what: `${name}'s ${token} turn`, timeout })
    return prompts(name).at(-1) ?? ''
  }

  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const taskName = `OrgtreeRigProof-${path.basename(rig.dir)}`
  const session = sessionLauncher(rig.dir, taskName)
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  let broker = 0
  try {
    const engine = (await rig.api('GET', '/api/desktop/identity')).pid
    p.note('sessions: this proof script, the rig engine', { proof: sessionOf(process.pid), engine: sessionOf(engine) })
    await seed(rig, { org: { name: 'Session Upgrade Org' }, agents: [
      { name: 'ann', tier: 'haiku', charter: 'You prove a Claude seat moves between sessions.' },
      { name: 'flo', tier: 'flash', charter: 'You prove an Antigravity seat moves between sessions.' },
    ] })
    await quiet('seeding to settle')

    // ---- 0. before the helper: the engine starts the CLIs, in Session 0
    const pids = {}
    for (const name of SEATS) {
      await turn(name, `PROOF-${name}-0`)
      pids[name] = lastPid(name)
      p.check(`0 ${name}: the engine started its CLI itself, and no turn mentioned sessions`, pids[name] > 0 && !hosted(started(name))
        && parentOf(pids[name]) === engine && !prompts(name).some(x => x.includes(NOTICE)) && placement(name) === 'session0',
        { pid: pids[name], parent: parentOf(pids[name]), engine, line: started(name), placement: placement(name) })
    }

    // ---- 1. the helper comes up: each seat moves at its next turn
    const identity = await rig.api('GET', '/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))
    fs.copyFileSync(exe, bin)
    await session.start({ ORGTREE_V2_DATA: rig.data }, `"${bin}"`)
    await rig.waitFor(() => brokerPid(bin) > 0, { timeout: 15000, what: 'helper process' })
    broker = brokerPid(bin)
    const helperLog = () => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8') } catch { return '' } }
    await rig.waitFor(() => /holding the Codex host slot/.test(helperLog()), { timeout: 30000, what: 'the helper to take the host slot' })
    p.check('1 the helper runs in an interactive session', sessionOf(broker) > 0, { pid: broker, session: sessionOf(broker) })
    for (const name of SEATS) {
      const warm = pids[name]
      p.check(`1 ${name}: the CLI the engine started still runs when the helper comes up`, alive(warm), { pid: warm })
      const prompt = await turn(name, `PROOF-${name}-1`)
      pids[name] = lastPid(name)
      p.check(`1 ${name}: its next turn ran in a new CLI, a child of the helper in a non-zero session, and the old one ended`,
        pids[name] !== warm && hosted(started(name)) && parentOf(pids[name]) === broker && sessionOf(pids[name]) > 0 && !alive(warm),
        { old: warm, oldAlive: alive(warm), pid: pids[name], parent: parentOf(pids[name]), helper: broker, session: sessionOf(pids[name]), line: started(name) })
      p.check(`1 ${name}: that turn was told it now runs in the signed-in session`, prompt.includes(NOTICE) && prompt.includes(UP)
        && placement(name) === 'signed-in', { placement: placement(name), prompt: prompt.slice(-700) })
    }

    // ---- 2. no move, no notice
    const again = await turn('flo', 'PROOF-flo-2')
    p.check('2 flo: a further turn in the signed-in session keeps its CLI and carries no notice',
      !again.includes(NOTICE) && lastPid('flo') === pids.flo, { pid: lastPid('flo'), was: pids.flo, prompt: again.slice(-500) })

    // ---- 3. the helper dies during ann's turn, as at sign-out
    const annTurns = rig.turns('ann').length
    await rig.userMail('ann', 'PROOF-A-CUT: the long job, please.')
    await rig.waitFor(() => rig.fakeLog('ann').some(l => l.kind === 'step' && l.step?.sleep_ms), { what: 'ann to be mid-turn', timeout: 60000 })
    kill(broker)
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'helper exit' })
    broker = 0
    const gone = await rig.waitFor(() => !alive(pids.ann) || null, { timeout: 15000, what: "ann's hosted CLI to end" }).then(() => true, () => false)
    p.check("3 ann's hosted CLI ends with the helper", gone, { pid: pids.ann })
    const cut = await rig.waitFor(() => { const t = rig.turns('ann')[annTurns]; return t?.ended_at ? t : null }, { what: "ann's cut turn to end", timeout: 30000 })
    p.check('3 the turn stopped as "the user\'s Windows session ended", logged once, with no error left on the agent',
      cut.error === "the user's Windows session ended" && of('ann', /Windows session ended during the turn/).length === 1 && !rig.agentRow('ann')?.last_error,
      { turn: cut, lines: of('ann', /session ended/), last_error: rig.agentRow('ann')?.last_error })
    await rig.waitFor(() => { const t = rig.turns('ann'); return t.length > annTurns + 1 && t.every(x => x.ended_at) ? t : null },
      { what: "ann's next turn", timeout: 90000 })
    const resumed = prompts('ann').at(-1) ?? ''
    p.check('3 her next turn ran in Session 0, in a CLI the engine started', !hosted(started('ann')) && lastPid('ann') !== pids.ann
      && parentOf(lastPid('ann')) === engine && placement('ann') === 'session0', { pid: lastPid('ann'), parent: parentOf(lastPid('ann')), line: started('ann') })
    p.check('3 it was told it now runs in Session 0, and why its turn stopped', resumed.includes(NOTICE) && resumed.includes(DOWN)
      && resumed.includes(CONTINUE), resumed.slice(-1200))
    const held = rig.sql(`SELECT m.state FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id WHERE a.name = 'ann' AND m.body LIKE 'PROOF-A-CUT%'`)
    p.check('3 no mail was lost: the mail the cut turn held reached the next turn, once, and is delivered',
      resumed.includes('PROOF-A-CUT') && held.length === 1 && held[0].state === 'delivered' && summary('ann') === 'PROOF-A-CUT-DONE',
      { held, summary: summary('ann') })

    // ---- 4. an engine restart
    await quiet('turns to end before the restart')
    await rig.restart()
    const after = await turn('ann', 'PROOF-A-AFTER')
    p.check('4 ann: back in Session 0 after the restart, no move, so no session notice', !after.includes(NOTICE) && !hosted(started('ann'))
      && placement('ann') === 'session0', after.slice(-700))
    p.check('4 ann: her restart notice says where she runs', /\[ORGTREE RESTART NOTICE\][\s\S]*Session access at start: Session 0\./.test(after), after.slice(-700))
    const stored = rig.one(`SELECT m.body FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
      WHERE a.name = 'ann' AND m.body LIKE '[ORGTREE RESTART NOTICE]%' ORDER BY m.id DESC LIMIT 1`)
    p.check('4 ann: the stored restart notice says it too', /\nSession access at start: Session 0\.$/.test(stored?.body ?? ''), stored)
    const down = await turn('flo', 'PROOF-flo-AFTER', 120000)
    p.check('4 flo: last in the signed-in session, her first turn after the restart moved down to Session 0 and was told so',
      down.includes(NOTICE) && down.includes(DOWN) && /Session access at start: Session 0\./.test(down) && !hosted(started('flo'))
      && placement('flo') === 'session0', { placement: placement('flo'), prompt: down.slice(-900) })
    p.check('4 the wait for the helper ran out once, logged', lines(/did not register again after the engine's start/).length === 1,
      lines(/did not register again/))
  } finally {
    kill(broker)
    p.check(`the temporary task ${taskName} is deleted`, session.remove())
    p.keep(rig, { agents: SEATS, grep: /CLI started|CLI exit|session|sign-in helper|[Cc]redential broker/ })
  }
  return p.summary()
}
