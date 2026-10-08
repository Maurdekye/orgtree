// Proof: what happens after a turn fails (3.x parity).
//   kim:   a Codex turn stopped by a usage limit is frozen with its request
//          kept; the automatic wake at the reset gives the request again.
//   hana:  the same, released by hand (orgtree_unstick).
//   ivy:   (Codex) consecutive failed turns are reported to the superior
//          once; a completed turn makes the next failure news again. (A
//          turn that failed before any output gives its mail back, so the
//          next turn carries it too: the plain turn is told not to fail.)
//   carol: (Claude) the same rule on the Claude lane.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/turn-failures.mjs

import { Proof } from '../proof.mjs'

const LIMIT = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again later."
const limited = (match, resetAt) => ({ name: 'limited', match, once: true, steps: [
  { rate_limit: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
                  secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: resetAt + 86400 } } },
  { error: { message: LIMIT, codexErrorInfo: 'usageLimitExceeded' } },
] })

export default async function (rig) {
  const p = new Proof('turn-failures')
  const scenario = resetSoon => ({
    agents: {
      kim: { turns: [limited('PROOF-SOON', resetSoon)] },
      hana: { turns: [limited('PROOF-LIMIT', Math.floor(Date.now() / 1000) + 7200)] },
      ivy: { turns: [{ name: 'refused', match: 'PROOF-FAIL', unless: 'PLAIN', steps: [
        { error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', codexErrorInfo: 'unauthorized' } },
      ] }] },
      carol: { turns: [{ name: 'failed', match: 'PROOF-FAIL', steps: [
        { text: 'Trying.' },
        { result: { is_error: true, text: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' } },
      ] }] },
    },
    default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] },
  })
  rig.scenario(scenario(Math.floor(Date.now() / 1000) + 7200))
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  for (const name of ['kim', 'hana', 'ivy']) await rig.op({ op: 'hire', name, parent: 'boss', tier: 'luna', title: 'Codex rig agent' })
  const log = (agent, kind) => rig.fakeLog(agent).filter(l => !kind || l.kind === kind)
  const boss = rig.agentRow('boss').id
  const reports = who => rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id = ${boss} AND sender = '@system'
    AND body LIKE '${who}''s turn ended with an error%' ORDER BY id`).length

  // ---------------------------------------------------------------- kim: the automatic wake
  const resetSoon = Math.floor(Date.now() / 1000) + 10
  rig.scenario(scenario(resetSoon))
  await rig.userMail('kim', 'PROOF-SOON: please do the soon thing.')
  const kf = await rig.waitFor(() => rig.agentRow('kim')?.frozen, { what: 'kim to be frozen' })
  p.check('kim: limit freeze until the reset the turn named', kf.limit === true && Math.abs(Date.parse(kf.until) / 1000 - resetSoon) <= 5, kf.until)
  const kept = (kf.resume_texts ?? []).join('\n')
  p.check('kim: the freeze keeps the request it stopped (its mail, not the old notices)', /PROOF-SOON: please do the soon thing/.test(kept)
    && !/ORG NOTICES/.test(kept), { resume_texts: (kf.resume_texts ?? []).map(t => t.slice(0, 160)) })

  // ---------------------------------------------------------------- hana: released by hand
  await rig.userMail('hana', 'PROOF-LIMIT: please do the held thing.')
  await rig.waitFor(() => rig.agentRow('hana')?.frozen, { what: 'hana to be frozen' })
  const un = await rig.tool('boss', 'orgtree_unstick', { node: 'hana' })
  const hr = await rig.waitFor(() => log('hana', 'turn')[1], { what: 'hana\'s turn after the unstick', timeout: 30000 })
  p.check('hana: after orgtree_unstick the turn is given the held request again', un.ok && /Your hold was released/.test(hr.prompt)
    && /PROOF-LIMIT: please do the held thing/.test(hr.prompt.split('Your hold was released')[1] ?? ''), String(hr.prompt).slice(-500))
  await rig.waitTurns('hana', 2)

  // ---------------------------------------------------------------- ivy (Codex): told once per run
  for (const n of [1, 2]) {
    await rig.userMail('ivy', `PROOF-FAIL ${n}: please try.`)
    await rig.waitTurns('ivy', n)
  }
  await new Promise(r => setTimeout(r, 1500))
  const ivyTold = reports('ivy')
  p.check('ivy: two failed turns in a row, her superior is told once', ivyTold === 1 && rig.turns('ivy').every(t => t.error), { reports: ivyTold })
  await rig.userMail('ivy', 'PLAIN question: are you there?')
  const it3 = await rig.waitTurns('ivy', 3)
  p.check('ivy: a completed turn clears the run', !it3[2].error && rig.agentRow('ivy').extra?.hard_fail_run === undefined, rig.agentRow('ivy').extra)
  await rig.userMail('ivy', 'PROOF-FAIL 3: please try again.')
  await rig.waitTurns('ivy', 4)
  await new Promise(r => setTimeout(r, 1500))
  p.check('ivy: the next failure is news again (told a second time)', reports('ivy') === 2, { reports: reports('ivy') })

  // ---------------------------------------------------------------- carol (Claude): the same rule
  for (const n of [1, 2]) {
    await rig.userMail('carol', `PROOF-FAIL ${n}: please try.`)
    await rig.waitTurns('carol', n)
  }
  await new Promise(r => setTimeout(r, 1500))
  const ct = rig.turns('carol')
  p.check('carol (Claude lane): two failed turns in a row, her superior is told once', reports('carol') === 1 && ct.every(t => t.error),
    { reports: reports('carol'), errors: ct.map(t => String(t.error).slice(0, 60)) })

  // ---------------------------------------------------------------- kim: the wake
  const kr = await rig.waitFor(() => log('kim', 'turn')[1], { what: 'kim\'s automatic wake', timeout: 150000, every: 1000 })
  const woke = (Date.now() / 1000) - resetSoon
  p.check('kim: woken automatically after the reset, given the request again', /Your usage limit has reset/.test(kr.prompt)
    && /PROOF-SOON: please do the soon thing/.test(kr.prompt.split('Your usage limit has reset')[1] ?? ''),
    { after_reset_s: Math.round(woke), prompt: String(kr.prompt).slice(-500) })
  const kt = await rig.waitTurns('kim', 2)
  p.check('kim: the replayed turn completed and the freeze is gone', !kt[1].error && !rig.agentRow('kim').frozen, kt[1].error)

  p.keep(rig, { agents: ['kim', 'hana', 'ivy', 'carol'], grep: /freeze|thaw|wake|hard_fail/ })
  return p.summary()
}
