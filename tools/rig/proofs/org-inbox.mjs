// Proof: mail between two organizations on this machine (@org:<slug>) and
// who holds each org's inbox (P14, P15, P28), against a running engine.
//   A is the rig org (boss top-level, alice under him); B is a second org
//   made here (zoe top-level, yan under her).
//   P14: alice, below the top and without the org-inbox audience, cannot
//        write outside; boss, top-level, can, and holds A's org inbox.
//   P15: B has no holder when the mail arrives; its first live top-level
//        agent (zoe) is granted the audience and gets the mail. Her answer
//        reaches A's holder.
//   P28: single-holder mode: the user's grant to alice revokes boss's;
//        alice alone gets the next outside mail. With multi-holder on, both
//        hold it, and turning multi-holder off is refused while both do.
//        Once alice is retired, the next outside mail goes to boss again.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-inbox.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('org-inbox')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const A = rig.org
  const B = (await rig.api('POST', '/api/orgs', { name: 'Rig Other Org', dirs: [], net_autoconnect: false })).slug
  await rig.op({ op: 'hire', name: 'zoe', tier: 'haiku', title: 'B lead', grant: 5 }, { org: B })
  await rig.op({ op: 'hire', name: 'yan', parent: 'zoe', tier: 'haiku', title: 'B member' }, { org: B })
  const orgId = slug => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${slug}' AND state = 'active'`).id
  const holders = slug => rig.sql(`SELECT grantee, reason FROM ot.audiences WHERE org_id = ${orgId(slug)} AND grantor = '@extern'
    AND revoked_at IS NULL ORDER BY id`).map(r => r.grantee)
  const mailFrom = (slug, name, peer, text) => rig.sql(`SELECT m.state FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
    WHERE a.org_id = ${orgId(slug)} AND a.name = '${name}' AND m.sender = '${peer}' AND m.body LIKE '%${text}%'`)
  const send = (who, slug, to, body) => rig.tool(who, 'orgtree_message', { to, body }, { org: slug })
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))

  // ---------------------------------------------------------------- P14
  const low = await send('alice', A, `@org:${B}`, 'PROOF-1 from alice')
  p.check('P14: alice (below the top, no org-inbox audience) cannot write outside', !low.ok && /org-inbox audience/.test(low.text ?? '')
    && rig.sql(`SELECT 1 FROM ot.org_inbox WHERE org_id = ${orgId(B)} AND body LIKE 'PROOF-1%'`).length === 0, low.text)
  const top = await send('boss', A, `@org:${B}`, 'PROOF-2 from boss')
  p.check('P14: boss (top-level) writes outside and so holds A\'s org inbox', top.ok && holders(A).join(',') === 'boss', { text: top.text, holders: holders(A) })

  // ---------------------------------------------------------------- P15
  p.check('P15: B had no holder; its first live top-level agent zoe now holds the inbox and got the mail', holders(B).join(',') === 'zoe'
    && mailFrom(B, 'zoe', `@org:${A}`, 'PROOF-2').length === 1 && mailFrom(B, 'yan', `@org:${A}`, 'PROOF-2').length === 0,
  { holders: holders(B), zoe: mailFrom(B, 'zoe', `@org:${A}`, 'PROOF-2') })
  const answer = await send('zoe', B, `@org:${A}`, 'PROOF-3 answer from zoe')
  p.check('zoe\'s answer reaches A\'s holder (boss)', answer.ok && mailFrom(A, 'boss', `@org:${B}`, 'PROOF-3').length === 1, answer.text)

  // ---------------------------------------------------------------- P28
  const g = await tryApi('POST', `/api/orgs/${A}/audiences`, { action: 'grant', node: 'alice', target: 'extern', reason: 'proof: alice takes the org inbox' })
  p.check('P28: in single-holder mode the user\'s grant to alice revokes boss\'s', g.ok && holders(A).join(',') === 'alice', { g, holders: holders(A) })
  await send('zoe', B, `@org:${A}`, 'PROOF-4 to the new holder')
  p.check('P28: the next outside mail reaches alice alone', mailFrom(A, 'alice', `@org:${B}`, 'PROOF-4').length === 1
    && mailFrom(A, 'boss', `@org:${B}`, 'PROOF-4').length === 0)
  await rig.api('POST', `/api/orgs/${A}/settings`, { org_inbox_multi_holder: true })
  await tryApi('POST', `/api/orgs/${A}/audiences`, { action: 'grant', node: 'boss', target: 'extern', reason: 'proof: boss too' })
  const both = holders(A).sort().join(',')
  const off = await tryApi('POST', `/api/orgs/${A}/settings`, { org_inbox_multi_holder: false })
  p.check('P28: with multi-holder on both hold it, and turning it off is refused while both do', both === 'alice,boss' && !off.ok,
    { both, off })
  await tryApi('POST', `/api/orgs/${A}/audiences`, { action: 'revoke', node: 'boss', target: 'extern' })
  await rig.api('POST', `/api/orgs/${A}/settings`, { org_inbox_multi_holder: false })
  await rig.op({ op: 'retire', node: 'alice' })
  await send('zoe', B, `@org:${A}`, 'PROOF-5 after alice left')
  p.check('P15: with its only holder retired, the next outside mail goes to the first live top-level agent (boss)',
    mailFrom(A, 'boss', `@org:${B}`, 'PROOF-5').length === 1 && holders(A).includes('boss'), { holders: holders(A) })

  p.keep(rig, { agents: ['boss', 'alice'], grep: /org_inbox|extern|audience/i })
  return p.summary()
}
