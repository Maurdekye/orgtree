// Proof: turn recovery through the real engine path (parity P34/P35).
//   carol: the CLI dies mid-answer → connection freeze → the freeze timer
//          retries with the retry banner → the retry completes, runs cleared.
//   bob:   the result carries api_error_status 401 → parked with no reset
//          time ("credential rejected") → its superior alice is told once.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/turn-recovery.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('turn-recovery')
  rig.scenario({
    agents: {
      carol: { turns: [
        { name: 'retry', match: 'being retried', steps: [{ text: 'Recovered: checked the disk, continuing.' }] },
        { name: 'die-mid-turn', match: 'PROOF-EXIT', once: true, steps: [
          { text: 'Starting the work.' },
          { tool: 'Bash', args: { command: 'echo half-done' }, result: 'half-done' },
          { exit: 1 },
        ] },
      ] },
      bob: { turns: [
        { name: 'rejected', match: 'PROOF-401', once: true, steps: [
          { text: 'Trying.' },
          { result: { is_error: true, api_error_status: 401,
                      text: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' } },
        ] },
      ] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  // alice's docket assignment from the fixture may still be running: let it settle
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })

  // ---------------------------------------------------------------- carol: exit mid-turn
  const t0 = Date.now()
  await rig.userMail('carol', 'PROOF-EXIT: please start the work.')
  const frozen = await rig.waitFor(() => {
    const a = rig.agentRow('carol')
    return a?.frozen ? a : null
  }, { what: 'carol to be frozen after the CLI died', timeout: 60000 })
  p.check('carol: died mid-turn → connection freeze', frozen.frozen.connection === true && frozen.frozen.attempt === 1, frozen.frozen)
  p.check('carol: freeze names the cause', /died mid-response/.test(frozen.frozen.label ?? ''), frozen.frozen.label)
  p.check('carol: freeze is ~30 s (first backoff)', (() => {
    const s = (Date.parse(frozen.frozen.until) - Date.parse(frozen.frozen.at)) / 1000
    return s >= 25 && s <= 35
  })(), { at: frozen.frozen.at, until: frozen.frozen.until })
  p.check('carol: run counter net_fail_run = 1', Number(frozen.extra?.net_fail_run) === 1, frozen.extra)
  const firstTurn = rig.turns('carol')[0]
  p.check('carol: the dead turn is recorded with its exit', firstTurn?.ended_at && /exited during the turn/.test(firstTurn.error ?? ''), firstTurn)

  const done = await rig.waitFor(() => {
    const t = rig.turns('carol')
    return t.length >= 2 && t.every(x => x.ended_at) ? t : null
  }, { what: 'carol\'s retry turn to finish', timeout: 120000, every: 1000 })
  const retryAfter = (Date.parse(done[1].started_at) - Date.parse(firstTurn.ended_at)) / 1000
  p.check('carol: retried by the freeze timer after ~30 s', retryAfter >= 25 && retryAfter <= 50, { retryAfterS: retryAfter })
  p.check('carol: the retry completed without error', !done[1].error, done[1])
  const after = rig.agentRow('carol')
  p.check('carol: freeze cleared', !after.frozen, after.frozen)
  p.check('carol: run counters cleared by the completed turn', after.extra?.net_fail_run === undefined, after.extra)
  const log = rig.fakeLog('carol')
  const turns = log.filter(l => l.kind === 'turn')
  const retryPrompt = turns.find(l => l.script === 'retry')?.prompt ?? ''
  p.check('carol: the retry prompt carries the retry banner', /being retried — attempt 1 of 4/.test(retryPrompt) && /DO NOT TRUST YOUR OWN LAST MESSAGE/.test(retryPrompt))
  const starts = log.filter(l => l.kind === 'start')
  p.check('carol: a second CLI process ran the retry', starts.length >= 2 && new Set(starts.map(s => s.pid)).size >= 2, starts.map(s => ({ pid: s.pid, resumed: s.resumed })))
  p.check('carol: the retry resumed the same session', starts.at(-1)?.resumed === true && starts.at(-1)?.session === starts[0]?.session,
    { first: starts[0]?.session, last: starts.at(-1)?.session, resumed: starts.at(-1)?.resumed })
  const convo = rig.sql(`SELECT c.seq, c.body->>'role' AS role, c.body->>'kind' AS kind, left(c.body->>'text', 160) AS text
                           FROM ot.convo c JOIN ot.agents a ON a.id = c.agent_id WHERE a.name = 'carol' ORDER BY c.seq`)
  p.file('carol-desk-rows.json', convo)
  p.check('carol: desk shows the error row', convo.some(r => r.kind === 'error' && /exited during the turn/.test(r.text ?? '')))
  p.note(`carol cycle took ${((Date.now() - t0) / 1000).toFixed(1)} s`)

  // ---------------------------------------------------------------- bob: 401
  await rig.userMail('bob', 'PROOF-401: please try the request.')
  const parked = await rig.waitFor(() => {
    const a = rig.agentRow('bob')
    return a?.frozen ? a : null
  }, { what: 'bob to be parked after the 401', timeout: 60000 })
  p.check('bob: 401 → parked (cause auth, no reset time)', parked.frozen.cause === 'auth' && parked.frozen.parked === true && parked.frozen.until === null, parked.frozen)
  p.check('bob: label tells the operator what to do', /credential rejected/.test(parked.frozen.label ?? ''), parked.frozen.label)
  const told = await rig.waitFor(() => rig.sql(`SELECT m.uid, m.body, m.ev FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                                                  WHERE a.name = 'alice' AND m.body LIKE 'bob had its credential REJECTED%'`), { what: 'alice to be told bob is parked', timeout: 30000 })
  p.check('bob: superior alice told once ("credential REJECTED")', told.length === 1, told.map(m => m.body.slice(0, 120)))
  p.check('bob: parked_run = 1 (one announcement per episode)', Number(rig.agentRow('bob').extra?.parked_run) === 1, rig.agentRow('bob').extra)
  await new Promise(r => setTimeout(r, 35000))
  const still = rig.agentRow('bob')
  p.check('bob: still parked 35 s later (no timer wakes an auth park)', still.frozen?.cause === 'auth' && rig.turns('bob').length === 1, { frozen: still.frozen, turns: rig.turns('bob').length })

  p.keep(rig, { agents: ['carol', 'bob', 'alice'], grep: /carol|bob|freeze|frozen|retry|parked|401/i })
  return p.summary()
}
