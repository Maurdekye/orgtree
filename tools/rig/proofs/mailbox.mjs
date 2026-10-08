// Proof: an agent's own mailbox (orgtree_inbox, P11) and attachments on its
// mail (P13), against a running engine (docs/rust-engine/mail-artifact-
// parity.md records both as compile-checked only).
//   ian has 57 notices waiting (5 of them over 64 KB, with multi-byte text):
//       list pages by 50 with a cursor bound to him; a target-shaped
//       argument and another agent's cursor are refused; fetch takes 1-20
//       ids, serves a long body as chunk 0 with digests, defers what does
//       not fit in 256 KB, and does not see another agent's mail; chunk
//       reads the rest (UTF-8 boundaries, digests, the whole body back),
//       refuses a wrong handle or index, and works again after an engine
//       restart; reading changes no delivery state.
//   pam (holds a user audience) mails the user with attachments: at most
//       10; only to the user or @net: peers; a snapshot in her outbox that a
//       later edit does not change; a file outside her folders is refused;
//       ian (no audience) cannot attach to mail for the user.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/mailbox.mjs

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { Proof } from '../proof.mjs'

const sha = s => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex')

export default async function (rig) {
  const p = new Proof('mailbox')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  await rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0, { what: 'seed turns to settle', timeout: 60000 })
  await rig.op({ op: 'hire', name: 'ian', parent: 'boss', tier: 'haiku', title: 'Mailbox owner' })
  await rig.op({ op: 'hire', name: 'pam', parent: 'boss', tier: 'haiku', title: 'Attaches files' })
  await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'pam', reason: 'proof: may mail the user' })
  const id = name => rig.agentRow(name).id
  const inbox = args => rig.tool('ian', 'orgtree_inbox', args)

  // 52 small notices, then 5 long ones (each over 64 KB; '€' is 3 bytes, so 64 KB falls inside one)
  for (let i = 0; i < 52; i++) await rig.userMail('ian', `Notice ${i}: small.`, { notice: true })
  const long = []
  for (let i = 0; i < 5; i++) {
    const body = `LONG ${i} ` + 'x€'.repeat(30000) + ` END ${i}`
    long.push(body)
    await rig.userMail('ian', body, { notice: true })
  }
  const waiting = rig.sql(`SELECT uid, body FROM ot.mail WHERE recipient_agent_id = ${id('ian')} AND state = 'pending' ORDER BY id`)
  p.note('waiting', { count: waiting.length })
  const uidOf = text => waiting.find(m => m.body === text)?.uid

  // ---------------------------------------------------------------- list
  const l1 = await inbox({ action: 'list' })
  const l2 = l1.json?.next_cursor ? await inbox({ action: 'list', cursor: l1.json.next_cursor }) : null
  p.check('list: the first page holds 50 with a cursor; the next page holds the rest and ends', l1.ok && l1.json?.messages?.length === 50
    && l1.json.has_more === true && l2?.json?.messages?.length === waiting.length - 50 && l2.json.has_more === false && !l2.json.next_cursor,
  { first: l1.json?.messages?.length, cursor: l1.json?.next_cursor, second: l2?.json?.messages?.length })
  const one = await inbox({ action: 'list', limit: 1 })
  const capped = await inbox({ action: 'list', limit: 5000 })
  p.check('list: limit is honoured and capped (1 gives one; 5000 gives every waiting message here, at most 200)', one.json?.messages?.length === 1
    && capped.json?.messages?.length === Math.min(200, waiting.length), { one: one.json?.messages?.length, capped: capped.json?.messages?.length })
  const otherCursor = await inbox({ action: 'list', cursor: `${id('boss')}:0` })
  const target = await inbox({ action: 'list', agent: 'boss' })
  p.check('list: another agent\'s cursor and a target-shaped argument are refused', !otherCursor.ok && !target.ok
    && /own mailbox/.test(target.text ?? ''), { cursor: otherCursor.text, target: target.text })

  // ---------------------------------------------------------------- fetch
  const tooMany = await inbox({ action: 'fetch', message_ids: waiting.slice(0, 21).map(m => m.uid) })
  p.check('fetch: more than 20 ids are refused', !tooMany.ok && /1 to 20/.test(tooMany.text ?? ''), tooMany.text)
  const bossMail = rig.one(`SELECT uid FROM ot.mail WHERE recipient_agent_id = ${id('boss')} ORDER BY id DESC LIMIT 1`)?.uid
  const f = await inbox({ action: 'fetch', message_ids: [uidOf('Notice 0: small.'), ...long.map(uidOf), bossMail].filter(Boolean) })
  const got = f.json?.messages ?? []
  const first = got.find(m => m.id === uidOf(long[0]))
  p.check('fetch: a long body comes as chunk 0 of several, with its digests and a handle', f.ok && first?.chunk_index === 0 && first.chunk_total > 1
    && first.complete === false && first.body_sha256 === sha(long[0]) && Buffer.byteLength(first.content, 'utf8') <= 65536
    && first.chunk_sha256 === sha(first.content) && /^inbox:/.test(first.delivery_id ?? ''),
  first && { total: first.chunk_total, bytes: Buffer.byteLength(first.content, 'utf8'), handle: first.delivery_id })
  p.check('fetch: what does not fit in 256 KB is deferred, not cut; a small message comes whole', (f.json?.deferred_ids ?? []).length >= 1
    && got.some(m => m.content === 'Notice 0: small.' && m.complete === true), { served: got.length, deferred: f.json?.deferred_ids })
  p.check('fetch: another agent\'s message is simply not found here', (f.json?.not_found ?? []).includes(bossMail) && !got.some(m => m.id === bossMail),
    { not_found: f.json?.not_found })

  // ---------------------------------------------------------------- chunk
  let whole = first?.content ?? ''
  let chunkOk = true
  for (let i = 1; i < (first?.chunk_total ?? 0); i++) {
    const c = await inbox({ action: 'chunk', delivery_id: first.delivery_id, message_id: first.id, chunk_index: i })
    chunkOk &&= c.ok && c.json?.chunk_sha256 === sha(c.json?.content ?? '') && Buffer.byteLength(c.json?.content ?? '', 'utf8') <= 65536
    whole += c.json?.content ?? ''
  }
  p.check('chunk: every chunk is whole UTF-8 within 64 KB with its digest, and together they are the exact body', chunkOk && whole === long[0]
    && sha(whole) === first?.body_sha256, { chunks: first?.chunk_total, same: whole === long[0] })
  const wrongHandle = await inbox({ action: 'chunk', delivery_id: 'inbox:0:x:y', message_id: first?.id, chunk_index: 1 })
  const outside = await inbox({ action: 'chunk', delivery_id: first?.delivery_id, message_id: first?.id, chunk_index: 99 })
  p.check('chunk: a wrong handle and an index past the end are refused', !wrongHandle.ok && !outside.ok, { wrongHandle: wrongHandle.text, outside: outside.text })
  const states = rig.sql(`SELECT state FROM ot.mail WHERE recipient_agent_id = ${id('ian')}`).map(r => r.state)
  p.check('reading changes no delivery state: everything is still waiting', states.length === waiting.length && states.every(s => s === 'pending'),
    { states: [...new Set(states)] })
  await rig.restart()
  const after = await inbox({ action: 'chunk', delivery_id: first?.delivery_id, message_id: first?.id, chunk_index: 1 })
  p.check('chunk: the same handle still reads after an engine restart', after.ok && after.json?.chunk_index === 1, after.text?.slice(0, 160))

  // ---------------------------------------------------------------- attachments (P13)
  const scratch = name => path.join(rig.data, 'scratch', rig.org, name)
  fs.mkdirSync(scratch('pam'), { recursive: true })
  for (let i = 0; i < 11; i++) fs.writeFileSync(path.join(scratch('pam'), `f${i}.txt`), `file ${i}\n`)
  const outsideDir = path.join(rig.data, 'rig-outside')
  fs.mkdirSync(outsideDir, { recursive: true })
  fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret\n')
  const msg = args => rig.tool('pam', 'orgtree_message', args)
  const eleven = await msg({ to: 'user', body: 'Eleven files.', attachments: [...Array(11).keys()].map(i => `f${i}.txt`) })
  const local = await msg({ to: 'boss', body: 'For you.', attachments: ['f0.txt'] })
  const outsider = await msg({ to: 'user', body: 'Secret.', attachments: [path.join(outsideDir, 'secret.txt')] })
  const noAudience = await rig.tool('ian', 'orgtree_message', { to: 'user', body: 'Mine.', attachments: ['x.txt'] })
  p.check('attachments: more than 10, to a local agent, from outside her folders, and without a user audience are refused', !eleven.ok
    && /at most 10/.test(eleven.text ?? '') && !local.ok && /user or @net/.test(local.text ?? '') && !outsider.ok && !noAudience.ok,
  { eleven: eleven.text?.slice(0, 80), local: local.text?.slice(0, 80), outsider: outsider.text?.slice(0, 80), noAudience: noAudience.text?.slice(0, 80) })
  const two = await msg({ to: 'user', body: 'Two files.', attachments: ['f0.txt', 'f1.txt'] })
  const row = rig.one(`SELECT attachments FROM ot.mail WHERE sender = 'pam' AND body = 'Two files.'`)
  fs.writeFileSync(path.join(scratch('pam'), 'f0.txt'), 'edited after sending\n')
  const atts = row?.attachments ?? []
  p.check('attachments: two files ride the mail as snapshots in her outbox that a later edit does not change', two.ok && atts.length === 2
    && atts.every(a => /outbox/.test(a.path)) && fs.readFileSync(atts.find(a => a.name === 'f0.txt').path, 'utf8') === 'file 0\n', atts)

  p.keep(rig, { agents: ['ian', 'pam'], grep: /inbox|attach|mail/i })
  return p.summary()
}
