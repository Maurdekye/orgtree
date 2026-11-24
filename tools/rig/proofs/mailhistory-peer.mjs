// One chat's history, paged at the source: `peer=` on the user's inbox route
// (the user's chats, 4.7.0; USER 2026-11-24 m46fce69c48c9, coordinator
// m7939b5e5f292). A page holds only that counterparty's mail, 50 rows, with
// the cursor and the rows the route always had; without `peer` it answers as
// before.
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true, fixture: {
    org: { name: 'Peer history fixture' },
    agents: [{ name: 'boss', tier: 'sol', grant: 0 }, { name: 'aide', tier: 'sol', grant: 0 }, { name: 'mate', tier: 'sol', grant: 0 }],
    scenario: { default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } },
  } }
}

export default async function (rig) {
  const p = new Proof('mailhistory-peer')
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const page = (folder, peer, before) => rig.api('GET', `/api/orgs/${rig.org}/inbox?folder=${folder}`
    + (peer === undefined ? '' : `&peer=${encodeURIComponent(peer)}`) + (before ? `&before=${before}` : ''))
  const status = async fn => { try { await fn(); return 0 } catch (e) { return e.status } }

  // 60 from the user to boss, 3 to aide, one send to both; boss writes back 55 times, aide twice
  for (let i = 0; i < 60; i++) await rig.userMail('boss', `to boss ${i}`, { notice: true })
  for (let i = 0; i < 3; i++) await rig.userMail('aide', `to aide ${i}`, { notice: true })
  for (let i = 0; i < 55; i++) await rig.tool('boss', 'orgtree_message', { metadata: { to: 'user', notice: true }, body: `from boss ${i}` })
  for (let i = 0; i < 2; i++) await rig.tool('aide', 'orgtree_message', { metadata: { to: 'user', notice: true }, body: `from aide ${i}` })
  // the user's reply to boss that answers two of boss's mails at once
  const two = rig.sql(`SELECT uid FROM ot.mail WHERE org_id=${org} AND sender='boss' AND recipient_kind='user' ORDER BY id LIMIT 2`).map(r => r.uid)
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/message`, { text: 'answering two', notice: true,
    targets: two.map(id => ({ kind: 'mail', org: rig.org, box: 'user', id })) })
  // (after the agents' own mail: under a project they no longer have a direct line)
  // one send to several recipients: the megaphone to a project's two agents
  await rig.op({ op: 'create_project', name: 'crew', parent: 'boss' })
  await rig.op({ op: 'move', node: 'aide', new_parent: 'crew' })
  await rig.op({ op: 'move', node: 'mate', new_parent: 'crew' })
  await rig.api('POST', `/api/orgs/${rig.org}/nodes/crew/broadcast`, { text: 'to both', notice: true })

  // ---- the sent folder, by recipient
  const s1 = await page('sent', 'boss')
  p.check('a peer page of the sent folder holds 50 rows, all to that recipient, newest first, and says there is more',
    s1.sent.length === 50 && s1.sent.every(m => m.to === 'boss') && typeof s1.next_cursor === 'string'
    && s1.sent[0].body === 'answering two' && s1.pending.length + s1.delivered.length === 0, { n: s1.sent.length, cursor: s1.next_cursor, first: s1.sent[0]?.body })
  const s2 = await page('sent', 'boss', s1.next_cursor)
  const bossSent = [...s1.sent, ...s2.sent]
  p.check('the cursor walks to the end of that chat: every message to boss once, and no more pages',
    s2.next_cursor === null && new Set(bossSent.map(m => m.id)).size === bossSent.length
    && bossSent.filter(m => /^to boss \d+$/.test(m.body)).length === 60 && bossSent.every(m => m.to === 'boss'), { second: s2.sent.length, total: bossSent.length })
  p.check('a reply that answers several mails is one message, in its recipient\'s chat, with every target',
    bossSent.filter(m => m.body === 'answering two').length === 1
    && (bossSent.find(m => m.body === 'answering two').replies ?? []).length === 2, bossSent.find(m => m.body === 'answering two'))
  const aideSent = await page('sent', 'aide')
  p.check('another recipient\'s page holds only its own mail', aideSent.sent.every(m => m.to === 'aide')
    && aideSent.sent.filter(m => /^to aide \d+$/.test(m.body)).length === 3 && aideSent.next_cursor === null, aideSent.sent.map(m => m.body))
  // a send to several recipients is one row per recipient: it is in each one's page
  const mateSent = await page('sent', 'mate')
  const rowsBoth = rig.sql(`SELECT recipient_name FROM ot.mail WHERE org_id=${org} AND sender='@user' AND body='to both' ORDER BY id`).map(r => r.recipient_name)
  p.check('one send to two recipients is in the page of each of them, once', rowsBoth.slice().sort().join() === 'aide,mate'
    && aideSent.sent.filter(m => m.body === 'to both').length === 1 && mateSent.sent.filter(m => m.body === 'to both').length === 1
    && mateSent.sent.length === 1 && !bossSent.some(m => m.body === 'to both'), { rows: rowsBoth, aide: aideSent.sent.length, mate: mateSent.sent.length })

  // ---- the inbox folder, by sender
  const i1 = await page('inbox', 'boss')
  const mine = m => [...m.pending, ...m.delivered]
  p.check('a peer page of the inbox holds 50 rows, all from that sender, and says there is more',
    mine(i1).length === 50 && mine(i1).every(m => m.from === 'boss') && typeof i1.next_cursor === 'string' && i1.sent.length === 0, { n: mine(i1).length, cursor: i1.next_cursor })
  const i2 = await page('inbox', 'boss', i1.next_cursor)
  p.check('and its second page ends that chat', i2.next_cursor === null && mine(i2).length === 5 && mine(i2).every(m => m.from === 'boss'), { n: mine(i2).length })
  const aideIn = await page('inbox', 'aide')
  p.check('another sender\'s page holds only its own mail', mine(aideIn).length === 2 && mine(aideIn).every(m => m.from === 'aide') && aideIn.next_cursor === null, mine(aideIn).map(m => m.body))
  const nobody = await page('inbox', 'no-such-agent')
  p.check('an unknown peer is an empty page, not an error', mine(nobody).length === 0 && nobody.next_cursor === null, nobody)

  // ---- the same rows as the route without `peer`, which answers as before
  const whole = await page('sent')
  const same = whole.sent.find(m => m.id === s1.sent[0].id)
  p.check('without peer the page is the whole mailbox, 200 a page, as before', whole.sent.length === 64 + rowsBoth.length
    && whole.sent.some(m => m.to === 'aide') && whole.next_cursor === null, { n: whole.sent.length })
  p.check('a row is the same row in both pages', JSON.stringify(same) === JSON.stringify(s1.sent[0]), { peer: s1.sent[0], whole: same })
  // ---- the chat folder: both directions in one page under one cursor
  const ids = m => [...m.pending, ...m.delivered, ...m.sent].map(x => Number(rig.one(`SELECT id FROM ot.mail WHERE org_id=${org} AND uid='${x.id}'`).id))
  let chat = await page('chat', 'boss'), seen = [], pages = 0
  const firstChat = chat
  for (;;) {
    pages++; seen.push(...ids(chat))
    if (!chat.next_cursor || pages > 10) break
    chat = await page('chat', 'boss', chat.next_cursor)
  }
  p.check('a chat page is 50 rows of both directions, newest first, each in its own list',
    ids(firstChat).length === 50 && firstChat.sent.every(m => m.to === 'boss') && [...firstChat.pending, ...firstChat.delivered].every(m => m.from === 'boss')
    && firstChat.sent.length > 0 && firstChat.pending.length + firstChat.delivered.length > 0, { sent: firstChat.sent.length, received: firstChat.pending.length + firstChat.delivered.length })
  p.check('its cursor walks the whole conversation once, with no hole: 61 written and 55 received in 3 pages',
    pages === 3 && seen.length === 116 && new Set(seen).size === 116, { pages, rows: seen.length })
  const firstIds = ids(firstChat).sort((a, b) => b - a)
  const everyBoss = rig.sql(`SELECT id FROM ot.mail WHERE org_id=${org} AND ((sender='boss' AND recipient_kind='user') OR (sender='@user' AND recipient_name='boss')) ORDER BY id DESC LIMIT 50`).map(r => Number(r.id))
  p.check('the first page is exactly the 50 newest rows of that conversation', JSON.stringify(firstIds) === JSON.stringify(everyBoss), { got: firstIds.slice(0, 5), want: everyBoss.slice(0, 5) })
  p.check('the chat folder without a peer is refused', (await status(() => page('chat'))) === 400)
  p.check('an empty peer is no peer', (await page('sent', '')).sent.length === whole.sent.length)
  p.check('a bad folder or cursor is still refused with a peer', (await status(() => page('record', 'boss'))) === 400 && (await status(() => page('sent', 'boss', '0'))) === 400)
  return p.summary()
}
