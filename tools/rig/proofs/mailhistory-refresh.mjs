// Exact retained-ID history reads: bounded, scoped and authoritative after mutations.
import { Proof } from '../proof.mjs'
export { setup } from './user-job-delete.mjs'

export default async function (rig) {
  const p = new Proof('mailhistory-refresh')
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  await rig.tool('boss', 'orgtree_message', { metadata: { to: 'user', notice: true }, body: 'retained mail' })
  const uid = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND recipient_kind='user' AND body='retained mail'`).uid
  const selected = (ids, folder = 'inbox', node) => rig.api('GET', `/api/orgs/${rig.org}/${node ? `nodes/${node}/` : ''}inbox?folder=${folder}&ids=${encodeURIComponent(JSON.stringify(ids))}`)
  const failure = async fn => { try { await fn(); return 0 } catch (e) { return e.status } }
  const unread = await selected([uid, 'missing'])
  p.check('bounded selection names exact coverage and includes pending user mail', JSON.stringify(unread.refreshed_ids) === JSON.stringify([uid, 'missing'])
    && unread.pending.some(m => m.id === uid) && unread.next_cursor === null, unread)
  await rig.api('POST', `/api/orgs/${rig.org}/inbox/read`, { ids: [uid] })
  const read = await selected([uid])
  p.check('remote read moves retained user mail out of pending', read.pending.length === 0 && read.delivered.some(m => m.id === uid), read)
  await rig.api('DELETE', `/api/orgs/${rig.org}/inbox/${uid}`)
  const removed = await selected([uid])
  p.check('remote delete is authoritative only for the explicitly requested ids', removed.refreshed_ids?.[0] === uid && removed.pending.length + removed.delivered.length === 0, removed)
  p.check('empty, oversized and malformed selections are refused', (await failure(() => selected([]))) === 400
    && (await failure(() => selected(Array.from({ length: 201 }, (_, i) => String(i))))) === 400
    && (await failure(() => rig.api('GET', `/api/orgs/${rig.org}/inbox?folder=inbox&ids=invalid`))) === 400)
  p.check('a cursor and retained ids cannot be combined', (await failure(() => rig.api('GET', `/api/orgs/${rig.org}/inbox?folder=inbox&before=1&ids=${encodeURIComponent(JSON.stringify([uid]))}`))) === 400)
  await rig.userMail('boss', 'user sent fixture', { notice: true })
  const sent = rig.one(`SELECT uid FROM ot.mail WHERE org_id=${org} AND sender='@user' AND body='user sent fixture'`).uid
  const outgoing = await selected([sent], 'sent')
  p.check('sent refresh projects sent mail while incoming scope excludes it', outgoing.sent.some(m => m.id === sent)
    && (await selected([sent])).delivered.length === 0 && (await selected([sent])).pending.length === 0, outgoing)
  const boss = await selected([sent], 'inbox', 'boss')
  p.check('node refresh uses its incoming recipient scope', [...boss.pending, ...boss.delivered].some(m => m.id === sent), boss)
  await rig.op({ op: 'create_project', name: 'history-project', parent: 'boss' })
  const project = await selected([sent], 'inbox', 'history-project')
  p.check('project refresh cannot expose a different node inbox', project.refreshed_ids?.[0] === sent
    && project.pending.length + project.delivered.length + project.sent.length === 0, project)
  return p.summary()
}
