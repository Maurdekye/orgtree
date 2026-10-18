// Proof: a project's mail queue mode (docket
// project-mail-queue-settings-round-robin-default-o; user 2026-10-18
// 08:01Z-08:02Z), through the real engine.
//   round-robin is the default; set_mail_queue switches a project to ack mode
//   and every fair_queue listener is told what that now requires
//   in ack mode each listener holds ONE handed mail; the rest wait in the
//   project's mailbox; the handed copy is stamped as needing an ack
//   an ack is orgtree_message to the project with reply_to = the handed
//   mail's id: it is recorded (read, ack_of), the project's copy is marked
//   acked, and the acker is handed the next waiting mail at once; acking the
//   same mail twice is refused
//   an un-acked mail goes back to the FRONT of the queue when its holder is
//   halted or removes its listener
//   switching back to round-robin tells the listeners no ack is needed
//   with exclude-sender on (off by default) a sender is never handed its own mail
//   a mail reclaimed after its last attempt is dead-lettered and the project's
//   superior told; purge retracts waiting mail only
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-queue.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-queue')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 300)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, kind, scope, state, halt FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mailTo = id => rig.sql(`SELECT id, uid, sender, state, notice, body, extra FROM ot.mail WHERE recipient_agent_id = ${id} ORDER BY id`)
  const copies = name => mailTo(node(name).id).filter(m => m.extra?.via_project?.name === 'q')
  const original = text => rig.one(`SELECT uid, state, extra FROM ot.mail WHERE recipient_agent_id = ${node('q').id} AND body = '${text}'`)
  const user = text => rig.userMail('q', text, { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const ack = (who, id, body) => rig.tool(who, 'orgtree_message', { metadata: { to: 'q', reply_to: id }, body })

  // ------------------------------------------------------------ a project with two listeners
  const made = await opTry({ op: 'create_project', name: 'q', parent: 'boss', description: 'A work queue.' })
  const ha = await opTry({ op: 'hire', name: 'qa', parent: 'q', tier: 'haiku', grant: 0, title: 'Queue worker A' })
  const hb = await opTry({ op: 'hire', name: 'qb', parent: 'q', tier: 'haiku', grant: 0, title: 'Queue worker B' })
  await settle('hire turns')
  const da = await rig.tool('qa', 'orgtree_watchdog', { action: 'create', name: 'q-queue', kind: 'fair_queue', target: 'q' })
  const db = await rig.tool('qb', 'orgtree_watchdog', { action: 'create', name: 'q-queue', kind: 'fair_queue', target: 'q' })
  p.check('project q with listeners qa and qb', made.ok && ha.ok && hb.ok && da.ok && db.ok,
    { made: made.ok || made.error, qa: ha.ok || ha.error, qb: hb.ok || hb.error, dogs: [said(da), said(db)] })
  p.check('round-robin is the default', (node('q').scope ?? {}).mail_queue === undefined, node('q').scope)

  // ------------------------------------------------------------ ack mode
  const notices0 = { qa: mailTo(node('qa').id).length, qb: mailTo(node('qb').id).length }
  const set = await opTry({ op: 'set_mail_queue', node: 'q', mode: 'ack' })
  p.check('set_mail_queue switches the project to ack mode', set.ok && node('q').scope?.mail_queue === 'ack', set.ok ? set.v : set.error)
  const told = who => mailTo(node(who).id).slice(notices0[who]).filter(m => m.sender !== '@user')
  p.check('every listener is told the mode changed and how to ack', ['qa', 'qb'].every(w => told(w).length === 1
    && /ack mode/i.test(told(w)[0].body) && /reply_to/.test(told(w)[0].body)), { qa: told('qa').map(m => m.body), qb: told('qb').map(m => m.body) })

  for (const t of ['Task 1', 'Task 2', 'Task 3']) await user(t)
  const held = () => ({ qa: copies('qa').map(m => m.body), qb: copies('qb').map(m => m.body) })
  p.check('each listener holds one mail; the third waits in the project', copies('qa').length === 1 && copies('qb').length === 1
    && original('Task 3')?.state === 'pending', { held: held(), task3: original('Task 3')?.state })
  p.check('the handed copy is stamped as needing an ack', [...copies('qa'), ...copies('qb')].every(m => m.extra.via_project.ack === true),
    [...copies('qa'), ...copies('qb')].map(m => m.extra.via_project))

  const first = copies('qa')[0]
  const firstOrig = rig.one(`SELECT uid FROM ot.mail WHERE uid = '${first.extra.via_project.mail}'`)
  const acked = await ack('qa', first.uid, `Done: ${first.body} is finished.`)
  p.check('qa acks with a reply to its mail and is handed the next one at once', acked.ok && /Ack recorded/.test(acked.text)
    && copies('qa').length === 2 && copies('qa')[1].body === 'Task 3', { said: said(acked), held: held() })
  const origAfter = rig.one(`SELECT extra FROM ot.mail WHERE uid = '${firstOrig.uid}'`)
  const record = rig.one(`SELECT state, extra, body FROM ot.mail WHERE recipient_agent_id = ${node('q').id} AND extra->>'ack_of' = '${firstOrig.uid}'`)
  p.check('the project records the ack: its copy is acked, the ack is kept as a read record', !!origAfter.extra.claimed?.acked_at
    && record?.state === 'read' && /is finished/.test(record?.body ?? ''), { claimed: origAfter.extra.claimed, record })
  const twice = await ack('qa', first.uid, 'Done again.')
  p.check('acking the same mail twice is refused', !twice.ok && /already acked/.test(twice.text), said(twice))

  // ------------------------------------------------------------ release to the front of the queue
  await user('Task 4')
  const t2holder = copies('qb').find(m => m.body === 'Task 2') ? 'qb' : 'qa'
  const halted = await opTry({ op: 'halt', nodes: ['qb'] })
  await rig.waitFor(() => node('qb')?.halt?.phase === 'halted', { what: 'qb to be halted', timeout: 20000 }).catch(() => {})
  await rig.waitFor(() => original('Task 2')?.state === 'pending', { what: 'Task 2 back in the queue', timeout: 20000 }).catch(() => {})
  const t2 = original('Task 2')
  p.check('halting the holder puts its un-acked mail back in the queue', halted.ok && t2holder === 'qb' && t2?.state === 'pending'
    && t2?.extra?.released?.by === 'qb', { holder: t2holder, t2 })
  const third = copies('qa')[1]
  const acked2 = await ack('qa', third.uid, 'Done: Task 3.')
  p.check('the released mail is first in line: qa is handed Task 2 before Task 4', acked2.ok && copies('qa').length === 3
    && copies('qa')[2].body === 'Task 2' && original('Task 4')?.state === 'pending', { said: said(acked2), held: held() })
  const removed = await rig.tool('qa', 'orgtree_watchdog', { action: 'remove', id: 'q-queue' })
  await rig.waitFor(() => original('Task 2')?.state === 'pending', { what: 'Task 2 back again', timeout: 20000 }).catch(() => {})
  p.check('removing its listener puts the holder\'s un-acked mail back too', removed.ok && original('Task 2')?.state === 'pending'
    && original('Task 2')?.extra?.released?.by === 'qa', { removed: said(removed), t2: original('Task 2') })

  // ------------------------------------------------------------ back to round-robin
  const before = mailTo(node('qb').id).length
  const back = await opTry({ op: 'set_mail_queue', node: 'q', mode: 'round_robin' })
  const toldBack = mailTo(node('qb').id).slice(before).filter(m => m.sender !== '@user' && !m.extra?.via_project)
  p.check('switching back to round-robin tells the listeners no ack is needed', back.ok && node('q').scope?.mail_queue === 'round_robin'
    && toldBack.length === 1 && /round-robin/i.test(toldBack[0].body) && /no ack/i.test(toldBack[0].body), toldBack.map(m => m.body))
  const bogus = await rig.tool('boss', 'orgtree_message', { metadata: { to: 'q' }, body: 'Ordinary project mail.' })
  p.check('ordinary mail to the project is not an ack', bogus.ok && !/Ack recorded/.test(bogus.text), said(bogus))
  await opTry({ op: 'unhalt', nodes: ['qb'] })
  await settle('qb unhalted')

  // ------------------------------------------------------------ exclude-sender (user 08:07Z-08:08Z, off by default)
  const reArm = await rig.tool('qa', 'orgtree_watchdog', { action: 'create', name: 'q-queue2', kind: 'fair_queue', target: 'q' })
  await settle('qa re-armed')
  const ex = await opTry({ op: 'set_mail_queue', node: 'q', exclude_sender: true })
  const qaBefore = copies('qa').length, qbBefore = copies('qb').length
  const fromQa = await rig.tool('qa', 'orgtree_message', { metadata: { to: 'q', notice: true }, body: 'From qa to the queue.' })
  await settle('the handed mail')
  const gotQa = copies('qa').slice(qaBefore).some(m => m.body === 'From qa to the queue.')
  const gotQb = copies('qb').slice(qbBefore).some(m => m.body === 'From qa to the queue.')
  p.check('with exclude-sender on, a sender is never handed its own mail', reArm.ok && ex.ok && ex.v?.exclude_sender === true
    && fromQa.ok && !gotQa && gotQb, { ex: ex.ok ? ex.v : ex.error, said: said(fromQa), gotQa, gotQb })
  // ------------------------------------------------------------ max attempts, dead letters, purge (user 08:11Z-08:13Z)
  const dl = await opTry({ op: 'create_project', name: 'dl', parent: 'boss', description: 'Dead letters.' })
  const hz = await opTry({ op: 'hire', name: 'dz', parent: 'dl', tier: 'haiku', grant: 0, title: 'Lone worker' })
  await settle('dz hired')
  const dz = await rig.tool('dz', 'orgtree_watchdog', { action: 'create', name: 'dl-queue', kind: 'fair_queue', target: 'dl' })
  const setDl = await opTry({ op: 'set_mail_queue', node: 'dl', mode: 'ack', max_attempts: 2 })
  const toDl = text => rig.userMail('dl', text, { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const dlMail = text => rig.one(`SELECT uid, state, extra FROM ot.mail WHERE recipient_agent_id = ${node('dl').id} AND body = '${text}'`)
  const haltDz = async on => {
    await opTry({ op: on ? 'halt' : 'unhalt', nodes: ['dz'] })
    await rig.waitFor(() => on ? node('dz')?.halt?.phase === 'halted' : !node('dz')?.halt, { what: `dz ${on ? '' : 'un'}halted`, timeout: 20000 }).catch(() => {})
  }
  const bossMail0 = mailTo(node('boss').id).length
  await toDl('Doomed task')
  const firstHand = dlMail('Doomed task')?.extra?.claimed?.by === 'dz'
  await haltDz(true)
  const afterOne = dlMail('Doomed task')
  await haltDz(false)
  await rig.waitFor(() => dlMail('Doomed task')?.extra?.claimed?.by === 'dz', { what: 'the second hand-out', timeout: 20000 }).catch(() => {})
  await haltDz(true)
  await rig.waitFor(() => !!dlMail('Doomed task')?.extra?.dead_letter, { what: 'the dead letter', timeout: 20000 }).catch(() => {})
  const dead = dlMail('Doomed task')
  p.check('a mail reclaimed after its last attempt goes to the dead-letter list, not the queue', dl.ok && hz.ok && dz.ok && setDl.ok
    && firstHand && afterOne?.state === 'pending' && dead?.state === 'read' && dead?.extra?.dead_letter?.attempts === 2,
    { setup: [dl.ok || dl.error, hz.ok || hz.error, said(dz), setDl.ok || setDl.error], afterOne, dead })
  const toldBoss = mailTo(node('boss').id).slice(bossMail0).filter(m => /dead-letter/.test(m.body) && /Doomed|gave up/.test(m.body))
  p.check('the project\'s superior is told of the dead letter', toldBoss.length === 1, mailTo(node('boss').id).slice(bossMail0).map(m => m.body))
  await toDl('Waiting A')
  await toDl('Waiting B')
  const purge = await opTry({ op: 'purge_mail_queue', node: 'dl' })
  p.check('purge retracts the waiting mail and leaves the dead letter alone', purge.ok && purge.v?.purged === 2
    && dlMail('Waiting A')?.state === 'retracted' && !!dlMail('Waiting A')?.extra?.purged
    && dlMail('Doomed task')?.state === 'read', { purge: purge.ok ? purge.v : purge.error, a: dlMail('Waiting A')?.state })
  await haltDz(false)
  await settle('the last turns')

  p.file('mail.json', rig.sql(`SELECT uid, sender, recipient_name, state, notice, body, extra FROM ot.mail ORDER BY id`))
  p.keep(rig, { agents: ['qa', 'qb', 'boss'], grep: /project|fair_queue|dispatch|ack/i })
  return p.summary()
}
