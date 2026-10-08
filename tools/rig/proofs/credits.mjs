// Proof: credit requests (orgtree_request_credits) and the user's decision,
// as the agent is told it (3.x's four outcomes: approved, counter-offered,
// declined, reduced; and denied).
//   tia (top-level, grant 5): asks, amends the figure (one tab), withdraws by
//       asking for what she has; then approved, counter-offered, and given
//       exactly her current grant (declined); a figure past the org's cap is
//       refused by the older route's dry run and its approval; with the cap
//       at her grant she has zero headroom and no request is made; with the
//       cap at 0 (3.x: uncapped) an approval goes through.
//   kim (under boss, holds a user audience, grant 4): asks for more and is
//       given less than she had (reduced); asks again and is denied.
//   boss (top-level with reports): a dry run below what his reports hold is
//       refused, as 3.x's preview did.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/credits.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('credits')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const settings = s => rig.api('POST', `/api/orgs/${rig.org}/settings`, s)
  await settings({ max_top_grant: 50 })
  await rig.op({ op: 'hire', name: 'tia', tier: 'haiku', title: 'Top-level credit agent', grant: 5 })
  await rig.op({ op: 'hire', name: 'kim', parent: 'boss', tier: 'haiku', title: 'Credit agent', grant: 4 })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'kim', reason: 'proof: may ask the user' })
  const id = name => rig.agentRow(name).id
  const grant = name => rig.one(`SELECT grant_credits::float8 AS g FROM ot.agents WHERE id = ${id(name)}`).g
  const row = name => rig.one(`SELECT uid, status, rev, body FROM ot.asks WHERE agent_id = ${id(name)} ORDER BY id DESC LIMIT 1`)
  const credit = name => row(name)?.body?.parts?.credit
  const told = name => rig.sql(`SELECT body, ev FROM ot.mail WHERE recipient_agent_id = ${id(name)} AND sender = '@user'
    AND kind = 'decision' ORDER BY id`).at(-1)
  const outcome = m => (m?.ev?.sections ?? []).find(s => s.kind === 'credit')?.outcome ?? m?.ev?.outcome
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const ask = (name, n, reason = 'proof: more work') => rig.tool(name, 'orgtree_request_credits', { new_limit: n, reason })
  const decide = (name, credits) => tryApi('POST', `/api/orgs/${rig.org}/nodes/${name}/batch`, { revs: { credits: row(name).rev }, credits })
  const legacy = body => tryApi('POST', `/api/orgs/${rig.org}/credit-requests`, body)

  // ---------------------------------------------------------------- tia: ask, amend, withdraw
  const a1 = await ask('tia', 12)
  const a2 = await ask('tia', 15)
  p.check('tia: asking again amends the figure on the one card', a1.ok && a2.ok && row('tia').status === 'open' && row('tia').rev === 2
    && credit('tia')?.old === 5 && credit('tia')?.new === 15, { rev: row('tia').rev, credit: credit('tia') })
  const a3 = await ask('tia', 3)
  p.check('tia: asking for no more than she has withdraws the request', a3.ok && /no credit request remains/.test(a3.text ?? '')
    && row('tia').status === 'withdrawn', { text: a3.text, status: row('tia').status })

  // ---------------------------------------------------------------- tia: approved, counter-offered, declined
  await ask('tia', 14)
  const d1 = await decide('tia', { granted: 14 })
  p.check('tia: granted what she asked for, she is told it was approved', d1.ok && grant('tia') === 14 && outcome(told('tia')) === 'approved',
    { grant: grant('tia'), outcome: outcome(told('tia')) })
  await ask('tia', 20)
  const d2 = await decide('tia', { granted: 17 })
  p.check('tia: granted more than she had but less than she asked, she is told it was a counter-offer', d2.ok && grant('tia') === 17
    && outcome(told('tia')) === 'counter', { grant: grant('tia'), outcome: outcome(told('tia')) })
  await ask('tia', 25)
  const d3 = await decide('tia', { granted: 17 })
  p.check('tia: granted exactly what she had, she is told the increase was declined (3.x), not counter-offered', d3.ok
    && grant('tia') === 17 && outcome(told('tia')) === 'declined', { grant: grant('tia'), outcome: outcome(told('tia')) })

  // ---------------------------------------------------------------- kim: reduced, denied
  await ask('kim', 9)
  const d4 = await decide('kim', { granted: 2 })
  p.check('kim: given less than she had, she is told her grant was reduced (3.x), not counter-offered', d4.ok && grant('kim') === 2
    && outcome(told('kim')) === 'reduced', { grant: grant('kim'), outcome: outcome(told('kim')) })
  await ask('kim', 6)
  const d5 = await decide('kim', { deny: true })
  p.check('kim: denied, her grant stays and she is told', d5.ok && grant('kim') === 2 && outcome(told('kim')) === 'denied',
    { grant: grant('kim'), outcome: outcome(told('kim')) })

  // ---------------------------------------------------------------- the older route: dry runs and the cap
  await ask('tia', 60)
  const tid = row('tia').uid
  const dryCap = await legacy({ id: tid, action: 'approve', granted: 60, dry: true })
  p.check('tia: the older route\'s dry run of a grant past the org\'s cap says it would be refused (3.x)', dryCap.ok
    && dryCap.json?.ok === false && (dryCap.json?.warnings ?? []).some(w => /cap of 50/.test(w)), dryCap)
  const overCap = await legacy({ id: tid, action: 'approve', granted: 60 })
  const atCap = await legacy({ id: tid, action: 'approve', granted: 50 })
  p.check('tia: approving past the cap is refused and changes nothing; approving up to it goes through', !overCap.ok
    && atCap.ok && grant('tia') === 50, { overCap, atCap: atCap.ok, grant: grant('tia') })
  const zero = await ask('tia', 55)
  p.check('tia: at the cap she has zero headroom: no request is made', !zero.ok && /ZERO credits/.test(zero.text ?? '')
    && row('tia').status !== 'open', { text: zero.text?.slice(0, 200), status: row('tia').status })
  await settings({ max_top_grant: 0 })
  const uncapped = await ask('tia', 55)
  const d6 = uncapped.ok ? await decide('tia', { granted: 55 }) : { ok: false, detail: uncapped.text }
  p.check('tia: with the cap at 0 (3.x: uncapped) her request is made and approved', uncapped.ok && d6.ok && grant('tia') === 55,
    { asked: uncapped.text?.slice(0, 160), decided: d6, grant: grant('tia') })
  await settings({ max_top_grant: 1000 })

  // ---------------------------------------------------------------- boss: a dry run below what his reports hold
  await ask('boss', 30)
  const held = rig.one(`SELECT coalesce(sum(seat + grant_credits), 0)::float8 AS h FROM ot.agents WHERE parent_id = ${id('boss')} AND state = 'live'`).h
  const dryFloor = await legacy({ id: row('boss').uid, action: 'approve', granted: 1, dry: true })
  p.check('boss: the dry run of a grant below what his reports hold says it would be refused (3.x)', dryFloor.ok
    && dryFloor.json?.ok === false && (dryFloor.json?.warnings ?? []).some(w => /unused; the rest is committed/.test(w)), { held, dryFloor })
  await legacy({ id: row('boss').uid, action: 'deny' })

  p.keep(rig, { agents: ['tia', 'kim', 'boss'], grep: /credit|grant|reallocate/i })
  return p.summary()
}
