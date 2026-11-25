// A project's audience notices are the project's, never its manager's (4.7.0-alpha.5: @coordinator-opus got
// "Your explicit audience with the user was rescinded" at 2026-11-25 15:49:16Z when the user revoked the user
// audience of project @school2-review, which it manages; its own audience held). Grant and revoke notices for
// a project are routed to the project's manager, and the typed event they carried (access.audience_changed)
// renders as "you"; so the routed notice must carry the project-worded body and no event, while a notice about
// the reader's own audience keeps its event.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-audience-notice.mjs --no-ui
import { Proof } from '../proof.mjs'

export function setup() {
  return { session0: '0', fixture: { org: { name: 'Project audience notices' }, agents: [{ name: 'boss', tier: 'haiku', grant: 6 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}

export default async function (rig) {
  const p = new Proof('project-audience-notice')
  const oid = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const ok = (r, what) => { if (!r || r.error) throw new Error(`${what}: ${JSON.stringify(r)}`); return r }
  ok(await rig.op({ op: 'create_project', name: 'team', parent: 'boss' }), 'create_project')
  ok(await rig.op({ op: 'hire', name: 'worker', parent: 'team', tier: 'haiku', grant: 0 }), 'hire')
  const notes = since => rig.sql(`SELECT id, recipient_name, body, ev FROM ot.mail WHERE org_id=${oid} AND sender='@system' AND id > ${since} ORDER BY id`)
    .map(r => ({ ...r, ev: typeof r.ev === 'string' ? JSON.parse(r.ev) : r.ev }))
  const last = () => Number(rig.one(`SELECT coalesce(max(id),0) AS n FROM ot.mail WHERE org_id=${oid}`).n)
  const about = (rows, node) => rows.filter(r => r.ev && r.ev.variant === 'access.audience_changed' && (r.ev.object?.name ?? r.ev.object?.id) === node)

  // the user grants the project the user audience
  let mark = last()
  ok(await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'team', target: 'user', reason: 'proof' }), 'grant')
  let rows = notes(mark)
  const bossGrant = rows.filter(r => r.recipient_name === 'boss')
  p.check('the manager is told about the project grant, in words that name the project', bossGrant.some(r => /team/.test(r.body)), { bodies: bossGrant.map(r => r.body) })
  p.check('and no event in it reads as the manager\'s own grant', about(bossGrant, 'team').length === 0, { events: about(bossGrant, 'team').map(r => r.ev.outcome) })

  // the user revokes it
  mark = last()
  ok(await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'revoke', node: 'team', target: 'user' }), 'revoke')
  rows = notes(mark)
  const bossRevoke = rows.filter(r => r.recipient_name === 'boss')
  p.check('the manager is told the project\'s audience was rescinded, naming the project', bossRevoke.some(r => /team/.test(r.body) && /rescinded/.test(r.body)),
    { bodies: bossRevoke.map(r => r.body) })
  p.check('never as "Your explicit audience", and with no event about the project', bossRevoke.every(r => !/^Your explicit audience/.test(r.body)) && about(bossRevoke, 'team').length === 0,
    { bodies: bossRevoke.map(r => r.body), events: about(bossRevoke, 'team').map(r => r.ev.outcome) })
  p.check('the member still hears it lost the inherited route', rows.some(r => r.recipient_name === 'worker'), { to: rows.map(r => r.recipient_name) })

  // the manager's OWN audience: its notice keeps the typed event
  mark = last()
  ok(await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'boss', target: 'user', reason: 'proof' }), 'grant boss')
  ok(await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'revoke', node: 'boss', target: 'user' }), 'revoke boss')
  rows = notes(mark).filter(r => r.recipient_name === 'boss')
  p.check('a notice about the reader\'s own audience keeps its typed event', about(rows, 'boss').some(r => r.ev.outcome === 'rescinded'), { events: about(rows, 'boss').map(r => r.ev.outcome) })
  return p.summary()
}
