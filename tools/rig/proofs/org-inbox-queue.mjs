// Proof: a project holds the org inbox (USER 2026-11-03 m99ee62b87e70, mdf5da6c51202, m896fa990fc53,
// m63e16cf45188; spec org-inbox-queue-spec.md rev 2.2), through the real engine and a fake hub peer.
//   inbound hub mail becomes one job in the front-door project's queue (sender stays the outside peer)
//   the worker the queue hands it to may reply to that sender (reply_to = its copy) before it acks
//   the peer's answer to that reply goes back to that worker alone (never the queue)
//   the worker acks (the ack sends nothing outside) and can no longer reply about the job
//   a follow-up from the peer before hand-out is bundled with the job and handed to the same listener
//   a member of the holding project cannot start an outside conversation (outside_top_level)
// Run: node tools/rig/rig.mjs run tools/rig/proofs/org-inbox-queue.mjs
// Written without a live run (the author may not run builds); the integrator measures it. The worker's
// reply row gets its hub id by SQL below, standing in for the hub transport the offline rig lacks.

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('org-inbox-queue')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = (what, timeout = 60000) => rig.waitFor(() => rig.sql('SELECT 1 FROM ot.turns WHERE ended_at IS NULL').length === 0,
    { what, timeout }).catch(() => {})
  await settle('seed turns to settle', SEED_SETTLE_TIMEOUT)
  const hub = (op, args = {}) => rig.api('POST', '/api/rig/hub-mail', { org: rig.org, op, ...args })
  const node = name => rig.one(`SELECT id, name, kind, scope FROM ot.agents WHERE org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}' AND state='active') AND name='${name}'`)
  const mailTo = name => rig.sql(`SELECT id, uid, sender, state, body, extra FROM ot.mail WHERE recipient_agent_id=${node(name).id} ORDER BY id`)
  const tryTool = (who, tool, args) => rig.tool(who, tool, args).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))

  // ------------------------------------------------------------ the front door: a project with two workers
  await rig.op({ op: 'create_project', name: 'door', parent: null, description: 'Front door.' })
  await rig.op({ op: 'hire', name: 'wa', parent: 'door', tier: 'haiku', grant: 0, title: 'Worker A' })
  await rig.op({ op: 'hire', name: 'wb', parent: 'door', tier: 'haiku', grant: 0, title: 'Worker B' })
  await rig.op({ op: 'set_mail_queue', node: 'door', mode: 'ack' })
  await settle('hire turns')
  // two listeners: wa listens now, wb later, so the first job is wa's
  const da = await rig.tool('wa', 'orgtree_watchdog', { action: 'create', name: 'door-queue', kind: 'fair_queue', target: 'door' })
  p.check('worker wa listens on the front-door project', !!da)
  const g = await rig.api('POST', `/api/orgs/${rig.org}/audiences`, { action: 'grant', node: 'door', target: 'extern', reason: 'proof: the project queues the org inbox' })
  p.check('a project can hold the org-inbox audience', rig.sql("SELECT 1 FROM ot.audiences WHERE grantee='door' AND grantor='@extern' AND revoked_at IS NULL").length === 1, g)

  // ------------------------------------------------------------ inbound becomes a job; the worker replies before acking
  await hub('inbound', { id: 'in1', body: 'Hello, I need help with my order.' })
  await rig.waitFor(() => mailTo('wa').some(m => m.extra?.via_project?.outside), { what: 'wa is handed the outside job', timeout: 30000 })
  const copy = mailTo('wa').find(m => m.extra?.via_project?.outside)
  p.check('the job copy keeps the outside peer as sender and names its job',
    copy.sender === '@net:peer.rig' && !!copy.extra.outside_job, copy)
  p.check('no copy went to an agent holder (the project is the only holder)',
    rig.sql("SELECT 1 FROM ot.mail WHERE net_id='in1' AND recipient_kind='agent' AND extra->'via_project' IS NULL AND extra->'org_inbox' IS NULL").length === 0)
  const reply1 = await tryTool('wa', 'orgtree_message', { metadata: { to: '@net:peer.rig', reply_to: copy.uid }, body: 'Happy to help: what is your order number?' })
  p.check('the worker replies to the sender about its job before acking', reply1.ok, reply1)
  const out = rig.one("SELECT uid, via_job, sender_agent_id FROM ot.org_inbox WHERE dir='out' AND by_name='wa' ORDER BY id DESC LIMIT 1")
  p.check('the reply row remembers the job', out?.via_job === copy.extra.outside_job, out)
  const reply2 = await tryTool('wa', 'orgtree_message', { metadata: { to: '@net:peer.rig', reply_to: copy.uid }, body: 'Also, a second note.' })
  p.check('several replies are allowed before the ack', reply2.ok, reply2)

  // the peer answers THAT reply: it goes to wa alone (simulate the hub id the offline rig never assigns)
  rig.sql(`UPDATE ot.org_inbox SET net_id='out1' WHERE uid='${out.uid}'`)
  const before = rig.sql('SELECT id FROM ot.mail').length
  await hub('inbound', { id: 'in2', body: 'Order 1234.', reply_to: 'out1' })
  await rig.waitFor(() => mailTo('wa').some(m => m.body === 'Order 1234.'), { what: 'the answer reaches wa', timeout: 30000 })
  const answer = mailTo('wa').find(m => m.body === 'Order 1234.')
  p.check('the peer\'s answer goes to the worker that wrote, carrying the job',
    answer.extra?.outside_job === copy.extra.outside_job, answer)
  p.check('and to nobody else: one new mail, no new job in the queue',
    rig.sql('SELECT id FROM ot.mail').length === before + 1 &&
    rig.sql(`SELECT 1 FROM ot.mail WHERE recipient_agent_id=${node('door').id} AND body='Order 1234.'`).length === 0)

  // ------------------------------------------------------------ the ack sends nothing; the right ends
  const outsBefore = rig.sql("SELECT 1 FROM ot.org_inbox WHERE dir='out'").length
  await rig.tool('wa', 'orgtree_message', { metadata: { to: 'door', reply_to: copy.uid }, body: 'Resolved.' })
  p.check('the ack sends nothing outside', rig.sql("SELECT 1 FROM ot.org_inbox WHERE dir='out'").length === outsBefore)
  const late = await tryTool('wa', 'orgtree_message', { metadata: { to: '@net:peer.rig', reply_to: copy.uid }, body: 'One more thing.' })
  p.check('after the ack the worker can no longer reply about the job', !late.ok && /only about outside mail/i.test(late.error ?? ''), late)

  // ------------------------------------------------------------ a worker cannot start an outside conversation
  const cold = await tryTool('wb', 'orgtree_message', { metadata: { to: '@net:peer.rig' }, body: 'Unprompted.' })
  p.check('a member of the holding project has no outside right of its own', !cold.ok, cold)

  // ------------------------------------------------------------ a follow-up before hand-out is bundled
  await rig.tool('wa', 'orgtree_watchdog', { action: 'pause', id: 'door-queue' }).catch(() => {})
  await hub('inbound', { id: 'in3', body: 'Second question.' })
  const jobRow = rig.one("SELECT uid, extra->'org_inbox'->>'uid' AS box FROM ot.mail WHERE net_id='in3' AND extra ? 'org_inbox'")
  p.check('with nobody listening the second message waits as a pending job', !!jobRow, jobRow)
  const boxRow = rig.one("SELECT uid FROM ot.org_inbox WHERE net_id='in3' AND dir='in'")
  await hub('inbound', { id: 'in4', body: 'Actually, one more detail.', reply_to: 'in3' })
  const bundled = rig.one(`SELECT state, extra FROM ot.mail WHERE net_id='in4' AND recipient_agent_id=${node('door').id}`)
  p.check('the follow-up is bundled with the unhanded job, not queued separately',
    bundled?.extra?.bundled_with === jobRow.uid && bundled.state === 'read', { bundled, boxRow })
  await rig.tool('wa', 'orgtree_watchdog', { action: 'resume', id: 'door-queue' }).catch(() => {})
  await rig.waitFor(() => mailTo('wa').some(m => m.body === 'Actually, one more detail.'), { what: 'the follow-up is handed with its job', timeout: 30000 })
  p.check('both messages reached the same listener', mailTo('wa').some(m => m.body === 'Second question.'))
  p.file('mail.json', rig.sql('SELECT uid, sender, recipient_name, state, body, extra FROM ot.mail ORDER BY id'))
  p.keep(rig, { agents: ['wa', 'wb'], grep: /project|fair_queue|dispatch|outside|org_inbox/i })
  return p.summary()
}
