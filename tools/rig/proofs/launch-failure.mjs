// Proof: a turn that fails before its provider runs is told once, as 3.x's
//   terminal belt told it (supervisor.py `_turn_abandoned`, SH-4: user ruling
//   2026-09-12), and nothing retries it.
//   lu (luna, Codex, under boss): its app-server refuses `turn/start`. The
//   mail goes back to its mailbox, its last error carries the refusal, it
//   gets its own copy (runtime.turn_failed_terminal, a notice that does not
//   wake it) and boss is told (runtime.report_stalled, cause terminal). A
//   second refusal in the same run tells nobody again. A completed turn
//   delivers the waiting mail and ends the run, so the next refusal is told.
//   solo (luna, top level): the user is told.
//   ag (agy-sonnet, under boss) with Claude through Antigravity turned off:
//   its launch is refused before any process starts, and that is told too.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/launch-failure.mjs

import { Proof } from '../proof.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
// a refused start returns only once its app-server is closed (up to 5 s)
const SETTLE = 7000

export default async function (rig) {
  const p = new Proof('launch-failure')
  rig.scenario({
    agents: {
      lu: { turns: [
        { name: 'refuse', match: 'REFUSE', times: 2, steps: [{ start_error: 'the model is overloaded' }] },
        { name: 'deny', match: 'DENY', once: true, steps: [{ start_error: 'the model is overloaded again' }] },
      ] },
      solo: { turns: [{ name: 'refuse', match: 'REFUSE', once: true, steps: [{ start_error: 'the model is overloaded' }] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  await rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.api('PUT', '/api/app-settings/runtime', { antigravity_claude_enabled: true })
  await rig.op({ op: 'hire', name: 'lu', parent: 'boss', tier: 'luna', title: 'Codex subject' })
  await rig.op({ op: 'hire', name: 'solo', tier: 'luna', title: 'Top-level Codex subject', grant: 1 })
  await rig.op({ op: 'hire', name: 'ag', parent: 'boss', tier: 'agy-sonnet', title: 'Antigravity subject', account: 'primary' })

  const id = name => rig.agentRow(name).id
  const ORG = `(SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active')`
  const toAgent = (name, variant) => rig.sql(`SELECT m.notice, m.state, m.ev FROM ot.mail m WHERE m.org_id = ${ORG}
      AND m.recipient_agent_id = ${id(name)} AND m.ev->>'variant' = '${variant}' ORDER BY m.id`)
  const toUser = variant => rig.sql(`SELECT m.ev FROM ot.mail m WHERE m.org_id = ${ORG} AND m.recipient_kind = 'user'
      AND m.ev->>'variant' = '${variant}' ORDER BY m.id`)
  const stalled = (rows, report) => rows.filter(r => r.ev?.report === report)
  const pending = name => rig.sql(`SELECT m.body FROM ot.mail m WHERE m.recipient_agent_id = ${id(name)} AND m.state = 'pending' AND NOT m.notice`)
  const refusals = name => rig.fakeLog(name).filter(l => l.kind === 'turn_refused').length
  const runOf = name => rig.one(`SELECT (extra->>'hard_fail_run')::int AS run, last_error FROM ot.agents WHERE id = ${id(name)}`)

  // ---- lu: a refused turn/start
  await rig.userMail('lu', 'REFUSE one: please work.')
  await rig.waitFor(() => refusals('lu') >= 1 && /overloaded/.test(runOf('lu')?.last_error ?? ''), { what: 'lu\'s first refusal' })
  await rig.waitFor(() => stalled(toAgent('boss', 'runtime.report_stalled'), 'lu').length >= 1, { what: 'the first announcement', timeout: 20000 }).catch(() => null)
  const r1 = runOf('lu')
  p.check('lu: its last error carries the refusal', /did not accept the turn: .*overloaded/.test(r1?.last_error ?? ''), r1?.last_error)
  p.check('lu: the mail is back in its mailbox, waiting', pending('lu').length === 1, pending('lu'))
  const own1 = toAgent('lu', 'runtime.turn_failed_terminal')
  p.check('lu: it got its own copy once, a notice that does not wake it, naming how it died and the error',
    own1.length === 1 && own1[0].notice === true && /could not start/.test(own1[0].ev?.door ?? '') && /overloaded/.test(own1[0].ev?.err ?? ''),
    own1.map(r => ({ notice: r.notice, door: r.ev?.door, err: r.ev?.err })))
  const sup1 = stalled(toAgent('boss', 'runtime.report_stalled'), 'lu')
  p.check('boss: told once that lu stalled (cause terminal, how and why)',
    sup1.length === 1 && sup1[0].ev?.cause === 'terminal' && /could not start/.test(sup1[0].ev?.door ?? '') && /overloaded/.test(sup1[0].ev?.err ?? ''),
    sup1.map(r => ({ cause: r.ev?.cause, door: r.ev?.door, err: r.ev?.err, audience: r.ev?.audience })))
  const turnsAfter1 = rig.turns('lu').length
  await sleep(SETTLE)
  p.check('lu: nothing retried it, its own copy included (no new start, no turn)', refusals('lu') === 1 && rig.turns('lu').length === turnsAfter1,
    { refusals: refusals('lu'), turns: rig.turns('lu').length })

  await rig.userMail('lu', 'REFUSE two: please work.')
  await rig.waitFor(() => refusals('lu') >= 2, { what: 'lu\'s second refusal' })
  await sleep(SETTLE)
  p.check('lu: a second refusal in the same run tells nobody again',
    toAgent('lu', 'runtime.turn_failed_terminal').length === 1 && stalled(toAgent('boss', 'runtime.report_stalled'), 'lu').length === 1
      && runOf('lu')?.run === 2, { run: runOf('lu')?.run })

  const before = rig.turns('lu').length
  await rig.userMail('lu', 'Now please work.')
  await rig.waitTurns('lu', before + 1)
  p.check('lu: a completed turn delivers the waiting mail and ends the run', pending('lu').length === 0 && runOf('lu')?.run == null,
    { pending: pending('lu'), run: runOf('lu')?.run })
  await rig.userMail('lu', 'DENY three: please work.')
  await rig.waitFor(() => refusals('lu') >= 3, { what: 'lu\'s third refusal' })
  await rig.waitFor(() => stalled(toAgent('boss', 'runtime.report_stalled'), 'lu').length >= 2, { what: 'the next announcement', timeout: 20000 }).catch(() => null)
  p.check('lu: the next refusal starts a new run and is told again',
    toAgent('lu', 'runtime.turn_failed_terminal').length === 2 && stalled(toAgent('boss', 'runtime.report_stalled'), 'lu').length === 2,
    { own: toAgent('lu', 'runtime.turn_failed_terminal').length, boss: stalled(toAgent('boss', 'runtime.report_stalled'), 'lu').length })

  // ---- solo: no superior, so the user is told
  await rig.userMail('solo', 'REFUSE: please work.')
  await rig.waitFor(() => refusals('solo') >= 1, { what: 'solo\'s refusal' })
  await rig.waitFor(() => stalled(toUser('runtime.report_stalled'), 'solo').length >= 1, { what: 'the user\'s announcement', timeout: 20000 }).catch(() => null)
  const user = stalled(toUser('runtime.report_stalled'), 'solo')
  p.check('solo (top level): the user is told', user.length === 1 && user[0].ev?.audience === 'user' && /overloaded/.test(user[0].ev?.err ?? ''),
    user.map(r => ({ audience: r.ev?.audience, door: r.ev?.door, err: r.ev?.err })))

  // ---- ag: a launch refused before any process starts
  await rig.api('PUT', '/api/app-settings/runtime', { antigravity_claude_enabled: false })
  await rig.userMail('ag', 'Please work.')
  await rig.waitFor(() => /turned off/.test(runOf('ag')?.last_error ?? ''), { what: 'ag\'s refused launch' })
  await rig.waitFor(() => stalled(toAgent('boss', 'runtime.report_stalled'), 'ag').length >= 1, { what: 'ag\'s announcement', timeout: 20000 }).catch(() => null)
  await sleep(SETTLE)
  const ag = stalled(toAgent('boss', 'runtime.report_stalled'), 'ag')
  p.check('ag: a launch refused before its process started is told to boss once',
    ag.length === 1 && /turned off/.test(ag[0].ev?.err ?? '') && toAgent('ag', 'runtime.turn_failed_terminal').length === 1,
    ag.map(r => ({ door: r.ev?.door, err: r.ev?.err })))
  await rig.api('PUT', '/api/app-settings/runtime', { antigravity_claude_enabled: true })

  p.keep(rig, { agents: ['lu', 'solo'], grep: /could not start|did not accept|launch/i })
  return p.summary()
}
