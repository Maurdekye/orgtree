// The user answers their own message (4.7.0, the user's chats; USER 2026-11-24 mf2cbc358ad35 "need to be
// able to reply to myself"). The chats send such a reply to the chat's agent with the user's earlier mail
// as its target, named as every reply target from the chats is: { kind: 'mail', org, box: 'user', id }.
// No engine change was made for it: this proof shows the existing user send route takes the target,
// stores it on the new mail and hands it back in the user's sent list and in the chat's own pages.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/user-reply-own.mjs
import { Proof } from '../proof.mjs'

export function setup() {
  return { fixture: { org: { name: 'Reply to my own message' }, agents: [{ name: 'boss', tier: 'sol', grant: 0 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('user-reply-own')
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const status = async fn => { try { await fn(); return 200 } catch (e) { return e.status ?? 0 } }

  await rig.userMail('boss', 'my first thought', { notice: true })
  const first = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND sender='@user' AND recipient_name='boss' AND body='my first thought'`).uid
  p.check('the user\'s first message is stored', typeof first === 'string' && first.length > 0, first)

  const sent = await status(() => rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/message`, { text: 'and one more thing', notice: true,
    targets: [{ kind: 'mail', org: rig.org, box: 'user', id: first }] }))
  p.check('a reply whose target is the user\'s own earlier message to that agent is accepted', sent === 200, sent)

  const row = rig.one(`SELECT uid, reply_to, replies FROM ot.mail WHERE org_id=${org} AND sender='@user' AND recipient_name='boss' AND body='and one more thing'`)
  const targets = Array.isArray(row?.replies) && row.replies.length ? row.replies : row?.reply_to ? [row.reply_to] : []
  p.check('the new mail carries that target, with the user as the author of what it answers',
    targets.length === 1 && targets[0].id === first && /^@?user$/.test(targets[0].from ?? ''), targets)

  // what the desktop reads back: the user's sent list, and the chat's own pages
  const box = await rig.api('GET', `/api/orgs/${rig.org}/inbox`)
  const mine = (box.sent ?? []).find(m => m.body === 'and one more thing')
  p.check('the user\'s sent list shows the reply with its quote', !!mine && (mine.replies ?? [mine.reply_to]).filter(Boolean)[0]?.id === first, mine)
  const chat = await rig.api('GET', `/api/orgs/${rig.org}/inbox?folder=chat&peer=boss`)
  const inChat = (chat.sent ?? []).find(m => m.body === 'and one more thing')
  p.check('and so does the chat\'s own page, next to the message it answers',
    !!inChat && (inChat.replies ?? [inChat.reply_to]).filter(Boolean)[0]?.id === first && (chat.sent ?? []).some(m => m.id === first), { sent: (chat.sent ?? []).map(m => m.body) })

  // a target that does not exist is still refused
  const gone = await status(() => rig.api('POST', `/api/orgs/${rig.org}/nodes/boss/message`, { text: 'to nothing', notice: true,
    targets: [{ kind: 'mail', org: rig.org, box: 'user', id: 'm-not-there' }] }))
  p.check('a reply to a message that does not exist is refused', gone === 404, gone)
  return p.summary()
}
