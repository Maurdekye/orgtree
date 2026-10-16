// Proof: agents can ask where their turns run (orgtree_session), and a turn
// the user's sign-out cut off continues at once in Session 0, exactly once
// (docket let-agents-query-machine-sign-in-state-and-which; the user,
// 2026-10-16 11:01Z and 11:03Z). The same engine, sign-in helper and temporary
// interactive task as session-upgrade.mjs. Whether the user is signed in comes
// from the core monitor's debug-rig stand-in (`<data>\core-rig-signed-out`
// present = signed out); the sign-in helper's death plays the sign-out.
//   1. not signed in, no helper: ann (Claude) and flo (Antigravity) each ask in
//      a turn: signed_in false, this and the next turn in Session 0, no move;
//   2. signed in: ann asks at the start of a turn (no helper yet: Session 0,
//      no move, the helper reported missing); the helper comes up while that
//      turn waits for mail; asked again in the same turn: this turn is still in
//      Session 0, the next one moves to the signed-in session;
//   3. fully upgraded: ann's and flo's next turns run in the signed-in session
//      and say so, with no move ahead;
//   4. sign-out during ann's hosted turn (stand-in signed out, helper killed):
//      the turn stops, ONE new turn starts by itself within seconds, in
//      Session 0, though this proof sends no mail; it asks and gets signed_in
//      false, Session 0, no move; no further turn follows; the kill record has
//      one codex-session-ended line for her CLI; flo, idle when her hosted CLI
//      ended, gets no turn.
// Run it like session-upgrade.mjs, with a rig home the descriptor's trust check
// accepts (no other user may write it; see credential-broker.mjs):
//   set ORGTREE_RIG_HOME=%LOCALAPPDATA%\orgtree-rig-broker
//   node tools/rig/rig.mjs run tools/rig/proofs/session-query.mjs

import fs from 'node:fs'
import path from 'node:path'

import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'
import { brokerExe, brokerPid, ps, sessionLauncher } from './credential-broker.mjs'

export async function setup() {
  return { name: 'session-query', 'boot-isolated': true, session0: '1', fixture: 'none' }
}

const sessionOf = pid => { const o = ps(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).SessionId`); return o === '' ? null : Number(o) }
const alive = pid => !!pid && sessionOf(pid) !== null
const kill = pid => { if (pid) try { process.kill(pid) } catch {} }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const ASK = { tool: 'orgtree_session', args: {} }
const CONTINUE = 'Windows session ended while you were working'
const SEATS = ['ann', 'flo']

export default async function (rig) {
  // evidence may go to a D: rig home while the run state needs the profile one (credential-bridge.md)
  const stateHome = process.env.ORGTREE_RIG_HOME
  if (process.env.ORGTREE_RIG_EVIDENCE_HOME) process.env.ORGTREE_RIG_HOME = process.env.ORGTREE_RIG_EVIDENCE_HOME
  const p = new Proof('session-query')
  if (stateHome === undefined) delete process.env.ORGTREE_RIG_HOME
  else process.env.ORGTREE_RIG_HOME = stateHome
  const exe = brokerExe()
  if (!fs.existsSync(exe)) throw Error(`no broker at ${exe}: cargo build -p orgtree-engine --bins`)
  rig.scenario({
    agents: {
      ann: { turns: [
        { name: 'resume', match: [CONTINUE], steps: [ASK, { text: 'OK.' }] },
        { name: 'wait', match: ['PROOF-WAIT'], once: true, steps: [ASK, { poll_mail: { every_ms: 1000, timeout_ms: 120000 } }, ASK, { text: 'OK.' }] },
        { name: 'cut', match: ['PROOF-CUT'], once: true, steps: [{ sleep_ms: 120000 }] },
        { name: 'ask', match: ['PROOF-ASK'], steps: [ASK, { text: 'OK.' }] },
      ] },
      flo: { turns: [{ name: 'ask', match: ['PROOF-ASK'], steps: [ASK, { text: 'OK.' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const answers = name => rig.fakeLog(name).filter(l => l.tool === 'orgtree_session' && typeof l.text === 'string')
    .map(l => { try { return JSON.parse(l.text) } catch { return { unparsed: l.text, is_error: l.is_error } } })
  const same = (a, want) => !!a && JSON.stringify([a.signed_in, a.this_turn, a.next_turn, a.next_turn_moves]) === JSON.stringify(want)
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const of = (name, re) => lines(re).filter(l => l.includes(`/${name} `))
  // the harness's own launch line (`runtime.claude: CLI started agent=1 pid=22100 ... hosted=false`); a bare
  // /CLI started/ also matches the logged prompt text ("as it was when your CLI started"), which has no pid
  const LAUNCH = / runtime\.(?:claude|agy|codex|muse|opencode|acp): CLI started agent=\d+ pid=[1-9]\d* /
  const started = name => of(name, LAUNCH).at(-1) ?? ''
  const pidIn = l => Number((l.match(/ pid=(\d+)/) ?? [])[1] ?? 0)
  const hosted = l => / hosted=true/.test(l)
  const placement = name => rig.agentRow(name)?.extra?.session ?? null
  const signedOut = path.join(rig.data, 'core-rig-signed-out')
  const signOut = () => fs.writeFileSync(signedOut, 'debug rig WTS input only')
  const signIn = () => fs.rmSync(signedOut, { force: true })
  const killRecord = () => { try { return fs.readFileSync(path.join(rig.data, 'diagnostics', 'logs', 'codex-kills.log'), 'utf8') } catch { return '' } }
  const wakes = name => rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = '${name}' AND m.body LIKE '%${CONTINUE}%'`).length
  const quiet = (what, timeout = 60000) => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout })
  async function turn(name, token, timeout = 90000) {
    const before = rig.turns(name).length
    const asked = answers(name).length
    await rig.userMail(name, `${token}: one turn, please.`)
    await rig.waitFor(() => { const t = rig.turns(name); return t.length > before && t.every(x => x.ended_at) ? t : null },
      { what: `${name}'s ${token} turn`, timeout })
    return answers(name).slice(asked)
  }

  const run = rig.refresh()
  const port = Number(new URL(rig.url).port)
  const taskName = `OrgtreeRigProof-${path.basename(rig.dir)}`
  const session = sessionLauncher(rig.dir, taskName)
  const bin = path.join(rig.dir, 'bin', 'orgtree-credential-broker.exe')
  let broker = 0
  try {
    await seed(rig, { org: { name: 'Session Query Org' }, agents: [
      { name: 'ann', tier: 'haiku', charter: 'You prove a Claude seat can ask where it runs.' },
      { name: 'flo', tier: 'flash', charter: 'You prove an Antigravity seat can ask where it runs.' },
    ] })
    await quiet('seeding to settle')

    // ---- 1. not signed in, no helper
    signOut()
    for (const name of SEATS) {
      const got = await turn(name, `PROOF-ASK-${name}-1`)
      p.check(`1 ${name}: not signed in: signed_in false, this and the next turn in Session 0, no move`,
        got.length === 1 && same(got[0], [false, 'session0', 'session0', false]) && got[0].sign_in_helper === false, got)
    }

    // ---- 2. signed in; the helper comes up during ann's turn
    signIn()
    const asked = answers('ann').length
    const annBefore = rig.turns('ann').length
    await rig.userMail('ann', 'PROOF-WAIT: ask, wait for mail, ask again.')
    await rig.waitFor(() => answers('ann').length > asked || null, { what: "ann's first question in the waiting turn", timeout: 60000 })
    const first = answers('ann')[asked]
    p.check('2 signed in, no helper yet: signed_in true, this and the next turn in Session 0, the helper reported missing',
      same(first, [true, 'session0', 'session0', false]) && first.sign_in_helper === false && /sign-in helper is not connected/.test(first.summary ?? ''), first)
    const identity = await rig.api('GET', '/api/desktop/identity')
    fs.writeFileSync(path.join(rig.data, 'engine-attach.json'), JSON.stringify({ type: 'attach', protocol: 1, port, enginePid: identity.pid,
      hostPid: run.keeperPid, dataRootId: identity.dataRootId, token: rig.token, startedAt: new Date().toISOString() }))
    fs.copyFileSync(exe, bin)
    await session.start({ ORGTREE_V2_DATA: rig.data }, `"${bin}"`)
    await rig.waitFor(() => brokerPid(bin) > 0, { timeout: 15000, what: 'helper process' })
    broker = brokerPid(bin)
    const helperLog = () => { try { return fs.readFileSync(path.join(rig.data, 'credential-broker.log'), 'utf8') } catch { return '' } }
    await rig.waitFor(() => /holding the Codex host slot/.test(helperLog()), { timeout: 30000, what: 'the helper to take the host slot' })
    p.check('2 the helper runs in an interactive session', sessionOf(broker) > 0, { pid: broker, session: sessionOf(broker) })
    await rig.userMail('ann', 'PROOF-GO: the helper is up, ask again.')
    await rig.waitFor(() => { const t = rig.turns('ann'); return t.length > annBefore && t.every(x => x.ended_at) ? t : null },
      { what: "ann's waiting turn to end", timeout: 150000 })
    const second = answers('ann')[asked + 1]
    p.check('2 the same turn, helper up: this turn still in Session 0, the next one moves to the signed-in session',
      same(second, [true, 'session0', 'signed-in', true]) && second.sign_in_helper === true
      && /Your next turn moves to the user's signed-in session\./.test(second.summary ?? ''),
      { second, turnsSince: rig.turns('ann').length - annBefore })

    // ---- 3. fully upgraded
    for (const name of SEATS) {
      const got = await turn(name, `PROOF-ASK-${name}-3`)
      p.check(`3 ${name}: upgraded: signed_in true, this and the next turn in the signed-in session, no move`,
        got.length === 1 && same(got[0], [true, 'signed-in', 'signed-in', false]) && got[0].sign_in_helper === true
        && hosted(started(name)) && placement(name) === 'signed-in', { got, line: started(name), placement: placement(name) })
    }

    // ---- 4. sign-out during ann's hosted turn
    const annTurns = rig.turns('ann').length
    const floTurns = rig.turns('flo').length
    const annWakes = wakes('ann')
    const logAt = rig.fakeLog('ann').length
    await rig.userMail('ann', 'PROOF-CUT: the long job, please.')
    await rig.waitFor(() => rig.fakeLog('ann').slice(logAt).some(l => l.kind === 'step' && l.step?.sleep_ms), { what: 'ann to be mid-turn', timeout: 60000 })
    const cutPid = pidIn(started('ann'))
    signOut()
    kill(broker)
    await rig.waitFor(() => brokerPid(bin) === 0, { timeout: 10000, what: 'helper exit' })
    broker = 0
    const cut = await rig.waitFor(() => { const t = rig.turns('ann')[annTurns]; return t?.ended_at ? t : null }, { what: "ann's cut turn to end", timeout: 30000 })
    const resumed = await rig.waitFor(() => { const t = rig.turns('ann')[annTurns + 1]; return t?.ended_at ? t : null }, { what: "ann's resumed turn", timeout: 60000 })
    const gap = Date.parse(resumed.started_at) - Date.parse(cut.ended_at)
    p.check('4 the cut turn stopped as "the user\'s Windows session ended"; a new turn started by itself within 15 s, woken once',
      cut.error === "the user's Windows session ended" && gap >= 0 && gap < 15000 && wakes('ann') === annWakes + 1,
      { cut, resumed, gapMs: gap, wakes: wakes('ann') - annWakes })
    const got = answers('ann').at(-1)
    p.check('4 the resumed turn ran in Session 0, in a CLI the engine started, and its answer says so',
      cutPid > 0 && pidIn(started('ann')) > 0 && !hosted(started('ann')) && pidIn(started('ann')) !== cutPid && placement('ann') === 'session0'
      && same(got, [false, 'session0', 'session0', false]), { got, line: started('ann'), placement: placement('ann') })
    await sleep(10000)
    p.check('4 exactly once: no further turn for ann, and flo (idle when her CLI ended) got none',
      rig.turns('ann').length === annTurns + 2 && rig.turns('flo').length === floTurns && wakes('flo') === 0,
      { ann: rig.turns('ann').length - annTurns, flo: rig.turns('flo').length - floTurns, floWakes: wakes('flo') })
    const record = killRecord().split(/\r?\n/).filter(l => l.includes('codex-session-ended'))
    p.check('4 the kill record has one codex-session-ended line, for her hosted CLI, and the engine log says it once',
      record.length === 1 && record[0].includes(`pid=${cutPid} `) && record[0].includes('who="ann"')
      && of('ann', /Windows session ended during the turn/).length === 1, { record, lines: of('ann', /session ended/) })
  } finally {
    kill(broker)
    signIn()
    p.check(`the temporary task ${taskName} is deleted`, session.remove())
    p.keep(rig, { agents: SEATS, grep: /CLI started|CLI exit|session|sign-in helper|[Cc]redential broker/ })
  }
  return p.summary()
}
