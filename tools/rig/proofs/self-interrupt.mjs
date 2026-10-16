// Proof: an agent ends its own turn with orgtree_interrupt, and with
// restart: true one new turn starts at once (docket
// let-agents-query-machine-sign-in-state-and-which; the user, 2026-10-16
// 12:05Z: "allow agents to point the interrupt tool at themselves with an
// option to re-trigger a new turn immediately").
//   1. ann (Claude, below boss) ends her turn with restart: the turn stops at
//      once (not after its 60 s sleep), one new turn starts by itself within
//      10 s with the restart message, no further turn follows, and both ends
//      are logged;
//   2. without restart the turn stops at once and no turn follows;
//   3. it is refused while her CLI runs background work, and the turn goes on;
//   4. cal, with every Orgtree tool group off, may still restart itself, but
//      may not interrupt anyone else;
//   5. boss (runtime group on) may interrupt ann, but not restart her.
//   node tools/rig/rig.mjs run tools/rig/proofs/self-interrupt.mjs

import { seed } from '../fixture.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { name: 'self-interrupt', fixture: 'none' }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const RESTARTED = 'You ended your previous turn yourself'
const OFF = Object.fromEntries(['docket', 'team', 'messaging', 'inspection', 'watchdogs', 'runtime', 'user', 'logo'].map(g => [g, false]))
const interrupt = (node, restart) => ({ tool: 'orgtree_interrupt', args: restart === undefined ? { node } : { node, restart } })

export default async function (rig) {
  const p = new Proof('self-interrupt')
  rig.scenario({
    agents: {
      ann: { turns: [
        { name: 'restarted', match: [RESTARTED], steps: [{ text: 'OK, going on.' }] },
        { name: 'restart', match: ['PROOF-RESTART'], once: true, steps: [interrupt('ann', true), { sleep_ms: 60000 }, { text: 'NOT-REACHED' }] },
        { name: 'plain', match: ['PROOF-PLAIN'], once: true, steps: [interrupt('ann'), { sleep_ms: 60000 }, { text: 'NOT-REACHED' }] },
        { name: 'bg', match: ['PROOF-BG'], once: true, steps: [
          { bg: { task: 'b1', id: 'toolu_b1', command: 'npm test', finish_ms: 4000, status: 'completed', exit_code: 0, output: 'ok' } },
          { ...interrupt('ann', true), expect_error: true },
          { text: 'OK.' },
        ] },
      ] },
      cal: { turns: [
        { name: 'restarted', match: [RESTARTED], steps: [{ text: 'OK.' }] },
        { name: 'restart', match: ['PROOF-CAL'], once: true, steps: [interrupt('boss'), interrupt('cal', true), { sleep_ms: 60000 }, { text: 'NOT-REACHED' }] },
      ] },
      boss: { turns: [
        { name: 'other', match: ['PROOF-BOSS'], once: true, steps: [interrupt('ann', true), interrupt('ann'), { text: 'OK.' }] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  const results = name => rig.fakeLog(name).filter(l => l.kind === 'tool_result' && l.tool === 'orgtree_interrupt')
  const reached = name => rig.fakeLog(name).some(l => l.kind === 'step' && l.step?.text === 'NOT-REACHED')
  const wakes = name => rig.sql(`SELECT m.id FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.name = '${name}' AND m.body LIKE '${RESTARTED}%'`).length
  const lines = re => rig.engineLog().split(/\r?\n/).filter(l => re.test(l))
  const quiet = (what, timeout = 60000) => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what, timeout })
  const secs = t => (Date.parse(t.ended_at) - Date.parse(t.started_at)) / 1000
  const ended = (name, i, what, timeout = 30000) => rig.waitFor(() => { const t = rig.turns(name)[i]; return t?.ended_at ? t : null }, { what, timeout })

  await seed(rig, { org: { name: 'Self Interrupt Org' }, agents: [
    { name: 'boss', tier: 'haiku', charter: 'You lead.' },
    { name: 'ann', tier: 'haiku', parent: 'boss', charter: 'You end your own turns.' },
    { name: 'cal', tier: 'haiku', charter: 'You have no Orgtree tool groups.' },
  ] })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/cal/scope`, { tools: { orgtree: OFF } })
  await quiet('seeding to settle')

  // ---- 1. restart
  let before = rig.turns('ann').length
  await rig.userMail('ann', 'PROOF-RESTART: end your turn and start a new one.')
  const cut = await ended('ann', before, "ann's turn to end")
  const next = await ended('ann', before + 1, "ann's new turn")
  const gap = (Date.parse(next.started_at) - Date.parse(cut.ended_at)) / 1000
  const r1 = results('ann').at(-1)
  p.check('1 restart: the call succeeded and the turn stopped at once, not after its 60 s sleep',
    !!r1 && !r1.is_error && secs(cut) < 20 && !reached('ann'), { r1, cut })
  p.check('1 restart: one new turn started by itself within 10 s, with the restart message, woken once',
    gap >= 0 && gap < 10 && wakes('ann') === 1 && rig.fakeLog('ann').some(l => l.kind === 'turn' && (l.prompt ?? '').includes(RESTARTED)),
    { gap, wakes: wakes('ann') })
  await sleep(8000)
  p.check('1 restart: exactly once, no further turn', rig.turns('ann').length === before + 2, { turns: rig.turns('ann').length - before })
  p.check('1 restart: both ends are logged once',
    lines(/the agent ended its own turn/).length === 1 && lines(/a new turn starts at once, as the agent asked/).length === 1,
    lines(/own turn|starts at once/))

  // ---- 2. without restart
  before = rig.turns('ann').length
  await rig.userMail('ann', 'PROOF-PLAIN: end your turn.')
  const plain = await ended('ann', before, "ann's plain turn to end")
  await sleep(8000)
  p.check('2 without restart: the turn stopped at once and no turn followed',
    secs(plain) < 20 && !reached('ann') && rig.turns('ann').length === before + 1 && wakes('ann') === 1 && !results('ann').at(-1)?.is_error,
    { plain, turns: rig.turns('ann').length - before })

  // ---- 3. refused while background work runs
  before = rig.turns('ann').length
  await rig.userMail('ann', 'PROOF-BG: start background work, then try to restart.')
  await ended('ann', before, "ann's background turn to end")
  const r3 = results('ann').at(-1)
  p.check('3 refused while background work runs; the turn went on', !!r3?.is_error && /background work/.test(r3.text ?? '') && wakes('ann') === 1, r3)
  await quiet('the background task to settle', 90000)

  // ---- 4. every tool group off
  before = rig.turns('cal').length
  await rig.userMail('cal', 'PROOF-CAL: try boss, then restart yourself.')
  const calCut = await ended('cal', before, "cal's turn to end")
  const calNext = await ended('cal', before + 1, "cal's new turn")
  const [other, own] = results('cal').slice(-2)
  p.check('4 cal (all groups off): interrupting boss is refused by the tool group scope', !!other?.is_error && /tool group scope/.test(other.text ?? ''), other)
  p.check('4 cal (all groups off): ending its own turn with restart works, one new turn at once',
    !!own && !own.is_error && secs(calCut) < 20 && !reached('cal') && wakes('cal') === 1, { own, calCut, calNext })

  // ---- 5. another agent
  await quiet('turns to end')
  before = rig.turns('boss').length
  await rig.userMail('boss', 'PROOF-BOSS: try ann.')
  await ended('boss', before, "boss's turn")
  const [restartAnn, plainAnn] = results('boss').slice(-2)
  p.check('5 boss: restarting another agent is refused; a plain interrupt of a report is allowed (ann runs no turn)',
    !!restartAnn?.is_error && /own turn only/.test(restartAnn.text ?? '') && !!plainAnn && !plainAnn.is_error && /no turn is running/.test(plainAnn.text ?? ''),
    { restartAnn, plainAnn })
  p.keep(rig, { agents: ['ann', 'cal', 'boss'], grep: /own turn|starts at once|interrupt/ })
  return p.summary()
}
