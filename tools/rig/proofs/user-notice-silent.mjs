// Notices to the user raise no desktop notification (4.7.0, USER 2026-11-25 15:12:47Z m66c0b3c98c18:
// "notices sent to the user should not trigger a notification, even if normal mail is set to trigger
// one"). The desktop's alerts (native toasts, in-app toasts, taskbar flash, jump list) are all fed by
// one inventory, GET /api/desktop/notifications (domain::notices::for_org). An agent sends the user a
// plain message, a plain notice and a notice that names @user; only the message may be in it, while
// all three stay pending (unread) mail in the user's chats.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/user-notice-silent.mjs
import { Proof } from '../proof.mjs'

export function setup() {
  return { session0: '0', fixture: { org: { name: 'Quiet notices' }, agents: [{ name: 'rhea', tier: 'haiku', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('user-notice-silent')
  const send = (id, tool, body) => ({ tool, id, args: { metadata: { to: 'user' }, body } })
  rig.scenario({ default: { turns: [
    { match: ['notice proof'], steps: [
      send('toolu_n1', 'orgtree_message', 'loud message to the user'),
      send('toolu_n2', 'orgtree_send_notice', 'quiet notice to the user'),
      send('toolu_n3', 'orgtree_send_notice', 'quiet notice that names @user directly'),
      { text: 'Sent.' }] },
    { steps: [{ text: 'OK.' }] },
  ] } })
  const before = rig.turns('rhea').filter(t => t.ended_at).length
  await rig.userMail('rhea', 'notice proof')
  await rig.waitFor(() => rig.turns('rhea').filter(t => t.ended_at).length > before || null, { what: 'the turn to end', timeout: 60000 })
  const rows = rig.sql(`SELECT body, notice, state FROM ot.mail WHERE sender = 'rhea' AND recipient_kind = 'user' ORDER BY id`)
  p.check('all three reached the user as pending mail, the two notices flagged', rows.length === 3
    && rows.every(r => r.state === 'pending') && rows.filter(r => r.notice === true).length === 2, { rows })
  const all = []
  for (let offset = 0, guard = 0; guard < 20; guard++) {
    const page = await rig.api('GET', '/api/desktop/notifications' + (offset ? `?offset=${offset}` : ''))
    all.push(...(page?.notices ?? []))
    if (page?.next_offset == null) break
    offset = page.next_offset
  }
  const mine = all.filter(n => n.agent === 'rhea')
  const shown = mine.map(n => ({ kind: n.kind, body: n.body }))
  p.check('the message is in the notification inventory', mine.some(n => /loud message/.test(n.body ?? '')), { shown })
  p.check('neither notice is in it, the one naming @user included', !mine.some(n => /quiet notice/.test(n.body ?? '')), { shown })
  return p.summary()
}
