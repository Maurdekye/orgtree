// Proof: attention flags on docket items, and the user's replies on items.
//   alice owns the seeded item. She raises a flag: a reason is required and
//   bounded; a later update keeps the flag; amending edits the reason in
//   place (same revision). The user's dismiss against an old revision is
//   refused; the dismiss clears the flag, blocks the item and tells alice;
//   the exact same reason cannot be raised again, a new one can. The user's
//   reply on the item reaches alice as item-linked mail and acknowledges the
//   flag (cleared, with the reply on record); with a question linked to the
//   item still open, a reply leaves the flag up. alice takes a flag down.
//   carol (a participant): a reply addressed to her reaches her as a
//   participant; a reply to someone else is refused with nothing sent; a
//   reply sent as a notice wakes nobody.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/attention.mjs

import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('attention')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  const slug = rig.one(`SELECT slug FROM ot.work_items WHERE title = 'Rig smoke item'`).slug
  const id = name => rig.agentRow(name).id
  const work = (who, args) => rig.tool(who, 'orgtree_work', { slug, ...args })
  const upd = args => work('alice', { action: 'update', done_so_far: ['progress'], working_on_next: ['next'], ...args })
  const item = async () => (await rig.api('GET', `/api/orgs/${rig.org}/work-items/${slug}`)).item ?? {}
  const flag = async () => (await item()).manual_attention ?? null
  const tryApi = (method, route, body) => rig.api(method, route, body).then(json => ({ ok: true, json }),
    e => ({ ok: false, status: e.status, detail: String(e.body?.detail ?? e.message).slice(0, 200) }))
  const reply = body => tryApi('POST', `/api/orgs/${rig.org}/work-items/${slug}/reply`, body)
  const dismiss = setRev => tryApi('POST', `/api/orgs/${rig.org}/work-items/${slug}/dismiss-attention`, { set_rev: setRev })
  const mailTo = (name, since = 0) => rig.sql(`SELECT id, sender, kind, notice, body, ev, state FROM ot.mail
    WHERE recipient_agent_id = ${id(name)} AND id > ${since} ORDER BY id`)
  const lastMailId = () => rig.one(`SELECT coalesce(max(id), 0)::bigint AS n FROM ot.mail`).n
  await work('alice', { action: 'participants', add: ['carol'] })

  // ---------------------------------------------------------------- raising
  const bare = await upd({ attention: true })
  const long = await upd({ attention: true, attention_reason: 'x'.repeat(1501) })
  p.check('a flag needs a reason, and a reason over 1500 characters is refused (nothing raised)', !bare.ok && !long.ok
    && /attention_reason/.test(bare.text ?? '') && /1501/.test(long.text ?? '') && !(await flag()), { bare: bare.text?.slice(0, 120), long: long.text?.slice(0, 160) })
  const R1 = 'Please confirm the rig may use the seeded item for flags.'
  const raised = await upd({ attention: true, attention_reason: R1 })
  const f1 = await flag()
  const it1 = await item()
  p.check('alice raises a flag: the item carries it and the user is asked to look', raised.ok && f1?.reason === R1
    && it1.effective_attention === true && (it1.attention_sources ?? []).includes('manual'), { f1, sources: it1.attention_sources })
  await upd({ done_so_far: ['more progress'], working_on_next: ['still next'] })
  p.check('a later update without attention fields leaves the flag up', (await flag())?.set_rev === f1.set_rev, await flag())
  const R1b = R1 + ' The flags proof only reads it.'
  const amended = await upd({ attention_amend: true, attention_reason: R1b })
  const f2 = await flag()
  p.check('amending edits the standing reason in place (same revision, not a new raise)', amended.ok && f2?.reason === R1b
    && f2.set_rev === f1.set_rev, f2)

  // ---------------------------------------------------------------- dismissed
  const stale = await dismiss(f2.set_rev - 1)
  p.check('the user\'s dismiss against an older revision of the flag is refused', !stale.ok && stale.status === 409 && !!(await flag()), stale)
  const before = lastMailId()
  const dis = await dismiss(f2.set_rev)
  const it2 = await item()
  const told = mailTo('alice', before).find(m => /dismissed the attention flag/.test(m.body))
  p.check('the dismiss clears the flag, blocks the item with the reason, and tells alice', dis.ok && !it2.manual_attention
    && it2.status === 'blocked' && /attention flag dismissed by the user/.test(it2.blocked_reason ?? '') && !!told,
  { status: it2.status, blocked: it2.blocked_reason, told: told?.body?.slice(0, 160) })
  const again = await upd({ attention: true, attention_reason: R1b })
  p.check('the exact reason the user dismissed cannot be raised again', !again.ok && /dismissed exactly this reason/.test(again.text ?? '') && !(await flag()),
    again.text?.slice(0, 160))
  const R2 = 'New information: the flags proof now also needs a reply.'
  const fresh = await upd({ status: 'in_progress', attention: true, attention_reason: R2 })
  p.check('a new reason can be raised', fresh.ok && (await flag())?.reason === R2, (await flag()))

  // ---------------------------------------------------------------- replies
  const b1 = lastMailId()
  const r1 = await reply({ body: 'Confirmed, go ahead.' })
  const m1 = mailTo('alice', b1).find(m => m.sender === '@user')
  const it3 = await item()
  p.check('the user\'s reply reaches alice as item-linked mail', r1.ok && r1.json?.to === 'alice' && r1.json?.role === 'owner'
    && /Confirmed, go ahead\./.test(m1?.body ?? '') && m1?.ev?.variant === 'reply.docket', { r1: r1.json ?? r1, ev: m1?.ev?.variant })
  const hist = rig.sql(`SELECT op, detail FROM ot.work_events WHERE work_id = (SELECT id FROM ot.work_items WHERE slug = '${slug}') ORDER BY id`)
  const cleared = hist.filter(h => h.op === 'reply_clear_attention').at(-1)
  p.check('the reply acknowledges the flag: cleared, with the reply on record', !it3.manual_attention && cleared?.detail?.answer === 'Confirmed, go ahead.',
    { flag: it3.manual_attention, cleared })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'alice', reason: 'proof: may ask the user' })
  const asked = await rig.tool('alice', 'orgtree_ask', { question: 'Which flag colour?', options: ['Red', 'Blue'], work_item: slug })
  await upd({ attention: true, attention_reason: 'A third reason, with a question attached.' })
  const r2 = await reply({ body: 'Noted.' })
  p.check('with a question linked to the item still open, a reply leaves the flag up', asked.ok && r2.ok && !!(await flag()),
    { asked: asked.text?.slice(0, 100), flag: await flag() })
  const down = await upd({ attention: false })
  p.check('alice takes her flag down herself', down.ok && !(await flag()), down.text?.slice(0, 160))
  await rig.tool('alice', 'orgtree_withdraw_ask', {})

  // ---------------------------------------------------------------- addressed replies
  const b2 = lastMailId()
  const toCarol = await reply({ body: 'Carol, please check the wording.', to: 'carol' })
  const cm = mailTo('carol', b2).find(m => m.sender === '@user')
  p.check('a reply addressed to a participant reaches her as a participant', toCarol.ok && toCarol.json?.role === 'participant'
    && /ADDRESSED TO YOU AS A PARTICIPANT/.test(cm?.body ?? ''), { r: toCarol.json ?? toCarol, body: cm?.body?.slice(0, 200) })
  const b3 = lastMailId()
  const toBob = await reply({ body: 'Bob?', to: 'bob' })
  p.check('a reply addressed to someone who is neither owner nor participant is refused, nothing sent', !toBob.ok && toBob.status === 422
    && rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE id > ${b3} AND sender = '@user'`).n === 0, toBob)
  // alice settles first: no turn running and no waking mail waiting
  await rig.waitFor(() => rig.turns('alice').every(t => t.ended_at) && rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE recipient_agent_id = ${id('alice')} AND state = 'pending' AND NOT notice`).n === 0, { what: 'alice to settle', timeout: 60000 })
  await new Promise(r => setTimeout(r, 2000))
  const turnsBefore = rig.turns('alice').length
  const b4 = lastMailId()
  const quiet = await reply({ body: 'FYI only.', notice: true })
  await new Promise(r => setTimeout(r, 4000))
  const qm = mailTo('alice', b4).find(m => m.sender === '@user')
  p.check('a reply sent as a notice is stored as a notice and starts no turn', quiet.ok && quiet.json?.notice === true && qm?.notice === true
    && rig.turns('alice').length === turnsBefore, { r: quiet.json, notice: qm?.notice, turns: [turnsBefore, rig.turns('alice').length] })

  p.keep(rig, { agents: ['alice', 'carol'], grep: /attention|reply|docket/i })
  return p.summary()
}
