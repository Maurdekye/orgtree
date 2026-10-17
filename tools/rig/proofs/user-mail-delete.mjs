// Synthetic end-to-end proof for deleting one user-inbox copy.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export default async function (rig) {
  const p = new Proof('user-mail-delete')
  const lit = s => `'${String(s).replaceAll("'", "''")}'`
  const org = rig.sql(`SELECT id FROM ot.orgs WHERE slug=${lit(rig.org)}`)[0].id
  const send = (to, body, tags=[]) => rig.tool('boss', 'orgtree_message', {
    metadata: { to, tags }, body,
  })

  const kept = await send('user', 'delete target', ['Ephemeral', 'Keep'])
  const sibling = await send('user', 'same retained tag', ['Keep'])
  const control = 'agent-copy-delete-control'
  rig.exec(`INSERT INTO ot.mail(uid,org_id,sender,sender_agent_id,recipient_kind,recipient_agent_id,recipient_name,kind,body,state)
    SELECT ${lit(control)},${org},'boss',id,'agent',id,'boss','message','not a user inbox copy','read'
      FROM ot.agents WHERE org_id=${org} AND name='boss'`)
  p.check('setup creates two tagged user messages and an agent mailbox control', kept.ok && sibling.ok,
    { kept: kept.ok, sibling: sibling.ok })

  const target = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND body='delete target'`)?.uid
  const siblingUid = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND body='same retained tag'`)?.uid
  const attachment = path.join(rig.data, 'scratch', rig.org, 'retained-attachment.txt')
  fs.mkdirSync(path.dirname(attachment), { recursive: true })
  fs.writeFileSync(attachment, 'keep this file')
  rig.exec(`UPDATE ot.mail SET attachments=${lit(JSON.stringify([{ path: attachment, name: 'retained-attachment.txt' }]))}::jsonb
    WHERE org_id=${org} AND uid=${lit(target)}`)

  const beforeConvo = rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='boss')`)?.n
  const inboxSummary = async () => {
    const records = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    return records.records?.find(r => r.entity === 'org' && r.id === 'inbox_summary')?.body
  }
  const beforeSummary = await rig.waitFor(async () => {
    const summary = await inboxSummary()
    return summary?.user_inbox_count === 2 ? summary : null
  }, { timeout: 10000, every: 100, what: 'both unread user messages to reach the feed' })
  const before = await rig.api('GET', `/api/orgs/${rig.org}/inbox`)
  const remove = await rig.api('DELETE', `/api/orgs/${rig.org}/inbox/${encodeURIComponent(target)}`)
  const after = await rig.api('GET', `/api/orgs/${rig.org}/inbox`)
  const choices = await rig.api('GET', `/api/orgs/${rig.org}/inbox?tags_only=true`)
  const goneTag = await rig.api('GET', `/api/orgs/${rig.org}/inbox?tag=Ephemeral`)
  const stillTagged = await rig.api('GET', `/api/orgs/${rig.org}/inbox?tag=Keep`)
  const deletedCount = rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${org} AND uid=${lit(target)}`)?.n
  const orphanCount = rig.one(`SELECT count(*)::int AS n FROM ot.mail_tags t WHERE t.org_id=${org} AND t.key='ephemeral'
    AND NOT EXISTS (SELECT 1 FROM ot.mail_tag_links l WHERE l.org_id=t.org_id AND l.tag_key=t.key)`)?.n
  const remainingCount = rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${org} AND uid=${lit(siblingUid)}`)?.n
  const agentCount = rig.one(`SELECT count(*)::int AS n FROM ot.mail WHERE org_id=${org} AND uid=${lit(control)}`)?.n
  const afterConvo = rig.one(`SELECT count(*)::int AS n FROM ot.convo WHERE agent_id=(SELECT id FROM ot.agents WHERE org_id=${org} AND name='boss')`)?.n
  const afterSummary = await rig.waitFor(async () => {
    const summary = await inboxSummary()
    return summary?.user_inbox_count === 1 ? summary : null
  }, { timeout: 10000, every: 100, what: 'the user unread count to reflect deletion' })
  p.check('delete route permanently removes the selected user inbox row', remove.deleted === true && deletedCount === 0,
    { remove, deletedCount })
  p.check('inbox, active tag search and unread window no longer expose deleted mail',
    before.pending.some(m => m.id === target) && !after.pending.some(m => m.id === target)
      && !goneTag.pending.some(m => m.id === target) && !goneTag.delivered.some(m => m.id === target),
    { before: before.pending.length, after: after.pending.length })
  p.check('the pushed inbox summary drops the unread count for the deleted pending message',
    beforeSummary.user_inbox_count === 2 && afterSummary.user_inbox_count === 1,
    { before: beforeSummary.user_inbox_count, after: afterSummary.user_inbox_count })
  p.check('orphan tag-chip label is removed while a tag used by another mail remains',
    orphanCount === 0 && choices.tag_choices.includes('Keep') && !choices.tag_choices.includes('Ephemeral')
      && stillTagged.pending.some(m => m.id === siblingUid), choices.tag_choices)
  p.check('only the user inbox copy is deletable; agent copy and sender transcript remain',
    remainingCount === 1 && agentCount === 1 && beforeConvo === afterConvo, { beforeConvo, afterConvo })
  p.check('deleting mail leaves attachment files on disk', fs.readFileSync(attachment, 'utf8') === 'keep this file')

  let wrongBoxStatus = null
  try {
    await rig.api('DELETE', `/api/orgs/${rig.org}/inbox/${encodeURIComponent(control)}`)
  } catch (e) {
    wrongBoxStatus = e.status
  }
  p.check('a non-user mailbox row cannot be deleted through the user inbox route', wrongBoxStatus === 404 && agentCount === 1,
    { status: wrongBoxStatus, agentCount })
  p.keep(rig)
  return p.summary()
}
