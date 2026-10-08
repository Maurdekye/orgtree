// Proof: who an agent may write to, and audiences (orgtree_audience).
// The seeded chain: boss (top) > alice > bob, and carol under boss.
//   Reach: bob writes to his superior alice; not to boss (not his direct
//   superior) nor carol (not his peer). Peers alice and carol write to each
//   other. boss writes down to bob (a distant report), which grants bob an
//   audience to answer him.
//   Audiences: bob asks carol for one; carol grants it and bob can write to
//   her; carol revokes it and he cannot. bob asks again and carol denies it:
//   he is told, and still cannot. alice asks the user for one; the user
//   grants it: alice can write to the user, and her question to the user is
//   a card on the user's desk instead of mail to boss.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/audiences.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('audiences')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const id = name => rig.agentRow(name).id
  const write = (from, to, body) => rig.tool(from, 'orgtree_message', { to, body, notice: true })
  const aud = (who, args) => rig.tool(who, 'orgtree_audience', args)
  const told = (name, re) => rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id = ${id(name)} ORDER BY id`).some(m => re.test(m.body))
  const holds = (grantee, grantor) => rig.sql(`SELECT 1 FROM ot.audiences WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active')
    AND grantee = '${grantee}' AND grantor = '${grantor}' AND revoked_at IS NULL`).length > 0

  // ---------------------------------------------------------------- reach
  const up = await write('bob', 'alice', 'bob to his superior')
  const skip = await write('bob', 'boss', 'bob to boss')
  const side = await write('bob', 'carol', 'bob to carol')
  p.check('bob writes to his superior, but not to boss (not his direct superior) nor carol (not his peer)', up.ok && !skip.ok && !side.ok
    && /audience/.test(side.text ?? ''), { up: up.ok, skip: skip.text?.slice(0, 80), side: side.text?.slice(0, 80) })
  const peers = [await write('alice', 'carol', 'peer to peer'), await write('carol', 'alice', 'peer back')]
  p.check('peers alice and carol write to each other', peers.every(r => r.ok), peers.map(r => r.ok || r.text))
  const down = await write('boss', 'bob', 'boss down to bob')
  const answer = await write('bob', 'boss', 'bob answers boss')
  p.check('boss writes down to bob, which lets bob answer him', down.ok && holds('bob', 'boss') && answer.ok, { down: down.ok, answer: answer.ok || answer.text })

  // ---------------------------------------------------------------- an audience between agents
  const ask1 = await aud('bob', { action: 'request', target: 'carol', reason: 'proof: bob needs carol' })
  const g = await aud('carol', { action: 'grant', from: 'bob' })
  const via = await write('bob', 'carol', 'bob to carol with an audience')
  p.check('bob asks carol for an audience; she grants it; he can write to her', ask1.ok && g.ok && holds('bob', 'carol') && via.ok,
    { ask: ask1.text?.slice(0, 120), grant: g.text?.slice(0, 120), via: via.ok || via.text })
  const rv = await aud('carol', { action: 'revoke', grantee: 'bob' })
  const after = await write('bob', 'carol', 'bob after the revoke')
  p.check('carol revokes it and bob can no longer write to her', rv.ok && !holds('bob', 'carol') && !after.ok, { revoke: rv.text?.slice(0, 120), after: after.ok })
  const ask2 = await aud('bob', { action: 'request', target: 'carol', reason: 'proof: once more' })
  const dn = await aud('carol', { action: 'deny', from: 'bob' })
  const still = await write('bob', 'carol', 'bob after the denial')
  p.check('bob asks again, carol denies it: he is told and still cannot write to her', ask2.ok && dn.ok && !still.ok
    && await rig.waitFor(() => told('bob', /declin|denied/i), { what: 'bob to be told', timeout: 15000 }).then(() => true, () => false),
  { ask: ask2.text?.slice(0, 120), deny: dn.text?.slice(0, 120) })

  // ---------------------------------------------------------------- an audience with the user
  const ask3 = await aud('alice', { action: 'request', target: 'user', reason: 'proof: alice wants to ask the user' })
  const pending = rig.sql(`SELECT requester, target, status FROM ot.audience_requests WHERE requester = 'alice' ORDER BY id DESC LIMIT 1`)[0]
  const ug = await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'alice', reason: 'proof: granted' })
  const toUser = await write('alice', 'user', 'alice to the user')
  const q = await rig.tool('alice', 'orgtree_ask', { question: 'May I proceed?', options: ['Yes', 'No'] })
  const card = rig.one(`SELECT status FROM ot.asks WHERE agent_id = ${id('alice')} ORDER BY id DESC LIMIT 1`)
  p.check('alice asks the user for an audience; once granted she writes to the user and her question is a card on the user\'s desk',
    ask3.ok && pending?.status === 'pending' && ug && toUser.ok && q.ok && card?.status === 'open' && /user's desk/.test(q.text ?? ''),
  { pending, toUser: toUser.ok || toUser.text, ask: q.text?.slice(0, 100), card })

  p.keep(rig, { agents: ['bob', 'carol', 'alice'], grep: /audience/i })
  return p.summary()
}
