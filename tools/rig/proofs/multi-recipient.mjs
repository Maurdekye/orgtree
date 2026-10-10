// Proof: orgtree_message / orgtree_send_notice with a list in `to`.
// The seeded chain: boss (top) > alice > bob, and carol under boss.
//   alice → [boss, bob, carol]: one mail each, the result names every outcome.
//   bob → [alice, carol]: alice gets it, carol is refused (not his peer); the
//   call still succeeds and says "1 of 2". bob → [carol, boss]: every one
//   refused, so the call is refused. Duplicates collapse; 11 names are refused;
//   notice, orgtree_send_notice and a relative image warning ride the list; a
//   plain string `to` answers exactly as before.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/multi-recipient.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('multi-recipient')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const got = (tag) => rig.sql(`SELECT a.name, m.notice FROM ot.mail m JOIN ot.agents a ON a.id = m.recipient_agent_id
                                WHERE m.body LIKE '%${tag}%' ORDER BY a.name`)
  const names = (tag) => got(tag).map(r => r.name).join(',')
  const send = (from, args, tool = 'orgtree_message') => rig.tool(from, tool, { notice: true, ...args })

  const all = await send('alice', { to: ['boss', 'bob', 'carol'], body: 'MR-ALL hello all' })
  p.check('alice → [boss, bob, carol]: accepted, "Sent to 3 of 3", one line per recipient',
    all.ok && /Sent to 3 of 3/.test(all.text) && ['boss', 'bob', 'carol'].every(n => new RegExp(`^- ${n}: `, 'm').test(all.text)), all.text)
  p.check('each of the three gets exactly one mail', names('MR-ALL') === 'bob,boss,carol', got('MR-ALL'))
  p.check('notice: true reaches every copy', got('MR-ALL').every(r => r.notice === true), got('MR-ALL'))

  const part = await send('bob', { to: ['alice', 'carol'], body: 'MR-PART partial' })
  p.check('bob → [alice, carol]: accepted, "Sent to 1 of 2", carol\'s line says refused',
    part.ok && /Sent to 1 of 2/.test(part.text) && /^- carol: refused: /m.test(part.text), part.text)
  p.check('only alice gets it', names('MR-PART') === 'alice', got('MR-PART'))

  const none = await send('bob', { to: ['carol', 'boss'], body: 'MR-NONE nobody' })
  p.check('bob → [carol, boss]: every one refused, so the call is refused and names both',
    !none.ok && /Sent to 0 of 2/.test(none.text ?? '') && /- carol: refused/.test(none.text ?? '') && /- boss: refused/.test(none.text ?? ''), none.text)
  p.check('nobody gets it', got('MR-NONE').length === 0, got('MR-NONE'))

  const dup = await send('alice', { to: ['carol', ' carol ', 'carol'], body: 'MR-DUP once' })
  p.check('duplicates collapse to one send, answered like a single recipient', dup.ok && !/Sent to \d+ of/.test(dup.text) && names('MR-DUP') === 'carol', { text: dup.text, got: got('MR-DUP') })

  const many = await send('boss', { to: Array.from({ length: 11 }, (_, i) => `x${i}`), body: 'MR-MANY' })
  p.check('11 recipients are refused before anything is sent', !many.ok && /at most 10 recipients/.test(many.text ?? '') && got('MR-MANY').length === 0, many.text)
  const empty = await send('boss', { to: [], body: 'MR-EMPTY' })
  p.check('an empty list is refused', !empty.ok && /at least one recipient/.test(empty.text ?? ''), empty.text)

  const note = await rig.tool('boss', 'orgtree_send_notice', { to: ['alice', 'carol'], body: 'MR-NOTE fyi' })
  p.check('orgtree_send_notice takes a list too; both copies are passive', note.ok && names('MR-NOTE') === 'alice,carol' && got('MR-NOTE').every(r => r.notice === true), { text: note.text, got: got('MR-NOTE') })

  const img = await send('boss', { to: ['alice', 'carol'], body: 'MR-IMG see ![plot](outbox/plot.png)' })
  p.check('a relative image in a list send warns that agents cannot see it', img.ok && /relative image paths \(outbox\/plot\.png\)/.test(img.text) && /alice, carol cannot see them/.test(img.text), img.text)

  const one = await send('bob', { to: 'alice', body: 'MR-ONE plain string' })
  p.check('a plain string `to` works exactly as before', one.ok && !/Sent to \d+ of/.test(one.text) && /^Sent to alice \(id /.test(one.text) && names('MR-ONE') === 'alice', one.text)

  return p.summary()
}
