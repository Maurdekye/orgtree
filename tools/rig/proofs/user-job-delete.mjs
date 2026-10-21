// Scratch HTTP regression: deletion must preserve the user's explicit ACK path.
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true, fixture: {
    org: { name: 'User job deletion fixture' },
    agents: [{ name: 'boss', tier: 'sol', grant: 0 }],
    scenario: { default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } },
  } }
}

export default async function (rig) {
  const p = new Proof('user-job-delete')
  const attempt = async fn => {
    try { return { ok: true, value: await fn() } }
    catch (e) { return { ok: false, status: e.status, detail: e.body?.detail ?? e.message } }
  }
  const del = uid => attempt(() => rig.api('DELETE', `/api/orgs/${rig.org}/inbox/${uid}`))
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const mail = uid => rig.one(`SELECT uid,state,extra FROM ot.mail WHERE org_id=${org} AND uid='${uid}'`)
  const copies = project => rig.sql(`SELECT uid,state,extra FROM ot.mail WHERE org_id=${org} AND recipient_kind='user'
    AND extra->'via_project'->>'name'='${project}' ORDER BY id`)
  const history = project => rig.op({ op: 'mail_queue_history', node: project })

  await rig.op({ op: 'create_project', name: 'delete-ack', parent: 'boss' })
  await rig.op({ op: 'set_mail_queue', node: 'delete-ack', mode: 'ack' })
  await rig.op({ op: 'user_queue_join', node: 'delete-ack', batch: 1 })
  await rig.userMail('delete-ack', 'First job', { notice: true })
  await rig.userMail('delete-ack', 'Waiting job', { notice: true })
  const [copy] = copies('delete-ack')
  if (!copy) throw Error('fixture failed: first user job was not handed out')
  const original = copy.extra.via_project.mail
  const before = mail(original)
  const beforeHistory = await history('delete-ack')
  p.check('fixture holds exactly one ACK job with a waiting successor', copies('delete-ack').length === 1
    && before.extra.claimed.by_user === true && before.extra.claimed.ack === true && !before.extra.claimed.acked_at, before)
  const refused = await del(copy.uid)
  p.check('DELETE held user copy returns 409 with existing ACK action names', refused.status === 409
    && ['Acknowledge job', 'Reply & acknowledge', 'Acknowledge without reply'].every(s => refused.detail?.includes(s)), refused)
  p.check('refused deletion preserves user copy, original claim and assignment history', !!mail(copy.uid)
    && JSON.stringify(mail(original)) === JSON.stringify(before)
    && JSON.stringify(await history('delete-ack')) === JSON.stringify(beforeHistory))
  p.check('deletion does not implicitly ACK or free batch capacity', !mail(original)?.extra.claimed.acked_at
    && copies('delete-ack').length <= 1)

  await rig.op({ op: 'user_queue_leave', node: 'delete-ack' })
  const afterLeave = await del(copy.uid)
  await rig.op({ op: 'user_queue_join', node: 'delete-ack', batch: 1 })
  p.check('leaving and rejoining cannot bypass held-copy deletion protection', afterLeave.status === 409
    && (await del(copy.uid)).status === 409 && copies('delete-ack').length === 1, afterLeave)
  const ack = await attempt(() => rig.op({ op: 'user_job_ack', copy: copy.uid }))
  p.check('preserved copy remains explicitly acknowledgeable and frees the next job', ack.ok
    && !!mail(original)?.extra.claimed.acked_at && copies('delete-ack').length === 2, ack)
  const afterAck = mail(original)
  const historyAfterAck = await history('delete-ack')
  const ackedDelete = await del(copy.uid)
  p.check('DELETE after explicit ACK succeeds', ackedDelete.ok && ackedDelete.value?.deleted === true && !mail(copy.uid), ackedDelete)
  p.check('deleting an ACKed copy preserves original job and complete history', !!afterAck?.extra.claimed.acked_at
    && JSON.stringify(mail(original)) === JSON.stringify(afterAck)
    && JSON.stringify(await history('delete-ack')) === JSON.stringify(historyAfterAck))
  p.check('DELETE cannot remove the project original or report a missing copy as deleted',
    (await del(original)).status === 404 && (await del('missing-user-copy')).status === 404)

  const sent = await rig.tool('boss', 'orgtree_message', { metadata: { to: 'user', notice: true }, body: 'Ordinary user mail' })
  if (!sent.ok) throw Error(`ordinary mail fixture failed: ${sent.text}`)
  const ordinary = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND recipient_kind='user' AND body='Ordinary user mail' ORDER BY id DESC LIMIT 1`)
  p.check('ordinary inbox mail still deletes', !!ordinary && (await del(ordinary.uid)).ok && !mail(ordinary.uid))

  await rig.op({ op: 'create_project', name: 'delete-rr', parent: 'boss' })
  await rig.op({ op: 'user_queue_join', node: 'delete-rr', batch: 1 })
  await rig.userMail('delete-rr', 'Round-robin job', { notice: true })
  const rr = copies('delete-rr')[0]
  const rrOriginal = rr && mail(rr.extra.via_project.mail)
  p.check('round-robin queue copies delete without changing their original', !!rr && rr.extra.via_project.ack === false
    && (await del(rr.uid)).ok && !mail(rr.uid)
    && JSON.stringify(mail(rr.extra.via_project.mail)) === JSON.stringify(rrOriginal))
  p.keep(rig, { grep: /delete_user_mail|user_job_ack/ })
  return p.summary()
}
