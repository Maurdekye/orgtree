// Proof: a sender is warned when it mails a project whose inbox has no
// listeners (docket warn-senders-when-they-mail-a-project-whose-inbo; user
// 2026-10-20 11:04Z: "make sure they're warned that their mail may not be read
// by anyone or delivered anywhere unless the inbox has any listeners
// attached"), through the real engine.
//   an agent's orgtree_message to a project with no fair_queue listener gets a
//   warning that leads its result, says how to attach one and where the mail
//   can be read; the mail is still queued in the project's mailbox, as before
//   orgtree_send_notice to that project is warned the same way
//   a recipient list warns per recipient: only the unlistened project's line
//   a project whose only listener is paused is not unlistened: its sender gets
//   the paused note, not the warning
//   a project with an armed listener hands the mail out and warns nobody
//   the user's send from the project desk gets the same warning, ahead of
//   what the listener wake did (an agent woken, or nobody to wake)
//   once a listener attaches, the next send is handed out with no warning
//   orgtree_inbox project=<name> keeps its own queue line (the warning is per send)
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-inbox-warning.mjs

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-inbox-warning')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = (what, timeout = 60000) => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout }).catch(() => {})
  await settle('seed turns to settle', SEED_SETTLE_TIMEOUT)
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 600)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, kind, state FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mailTo = id => rig.sql(`SELECT id, uid, sender, state, notice, body FROM ot.mail WHERE recipient_agent_id = ${id} ORDER BY id`)
  const waiting = (project, body) => mailTo(node(project).id).find(m => m.body === body)
  const post = (project, text) => rig.tool('boss', 'orgtree_message', { metadata: { to: project }, body: text })
  const userPost = (project, text) => rig.userMail(project, text).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const warned = (t, project) => new RegExp(`Warning: project ${project}'s inbox has no listeners, so this mail may not be read by `
    + 'anyone or delivered anywhere until one attaches').test(t ?? '')
  const unwarned = t => !/no listeners/i.test(t ?? '') && !/Warning/.test(t ?? '')

  // ------------------------------------------------------------ nobody listens: the agent's send is warned
  const lone = await opTry({ op: 'create_project', name: 'lone', parent: 'boss', description: 'Nobody listens here.' })
  const t1 = await post('lone', 'Anyone there?')
  p.check('project lone exists with no listener (positive control: the send itself goes through)', lone.ok && t1.ok,
    { lone: lone.ok || lone.error, said: said(t1) })
  p.check('an agent mailing a project with no listeners is warned first, in the user\'s words',
    t1.ok && /^Sent to lone \(id m[^)]*\)\. Warning: /.test(t1.text ?? '') && warned(t1.text, 'lone'), t1.text)
  p.check('the warning says how to attach a listener and where the mail can be read',
    /orgtree_watchdog action=create kind=fair_queue target=lone/.test(t1.text ?? '') && /orgtree_inbox project=lone/.test(t1.text ?? '')
    && /position 1 in line/.test(t1.text ?? ''), t1.text)
  p.check('the mail is still accepted and queued in the project\'s mailbox', waiting('lone', 'Anyone there?')?.state === 'pending',
    waiting('lone', 'Anyone there?'))
  const n1 = await rig.tool('boss', 'orgtree_send_notice', { metadata: { to: 'lone' }, body: 'FYI: the build is green.' })
  const nRow = waiting('lone', 'FYI: the build is green.')
  p.check('orgtree_send_notice to that project is warned the same way, and still queued as a notice', n1.ok && warned(n1.text, 'lone')
    && nRow?.state === 'pending' && nRow?.notice === true, { said: said(n1), row: nRow })

  // ------------------------------------------------------------ an armed listener: handed out, nobody warned
  const wq = await opTry({ op: 'create_project', name: 'wq', parent: 'boss', description: 'One listener.' })
  const hw = await opTry({ op: 'hire', name: 'ew', parent: 'wq', tier: 'haiku', grant: 0, title: 'Worker W' })
  await settle('ew hired')
  const dw = await rig.tool('ew', 'orgtree_watchdog', { action: 'create', name: 'wq-queue', kind: 'fair_queue', target: 'wq' })
  const t2 = await post('wq', 'A job for wq')
  p.check('a project with an armed listener hands the mail out and warns nobody (positive control for the listener)',
    wq.ok && hw.ok && dw.ok && t2.ok && /handed it to ew/.test(t2.text ?? '') && unwarned(t2.text), { dog: said(dw), said: t2.text })
  await settle('ew turn')

  // ------------------------------------------------------------ a recipient list: per recipient
  const t3 = await rig.tool('boss', 'orgtree_message', { metadata: { to: ['lone', 'wq', 'ew'] }, body: 'Status round.' })
  const line = who => (t3.text ?? '').split('\n').find(l => l.startsWith(`- ${who}:`)) ?? ''
  p.check('a list send warns only on the unlistened project\'s line', t3.ok && /Sent to 3 of 3 recipients/.test(t3.text ?? '')
    && warned(line('lone'), 'lone') && unwarned(line('wq')) && unwarned(line('ew')), t3.text)
  await settle('list send turns')

  // ------------------------------------------------------------ a paused listener is attached
  const pz = await opTry({ op: 'create_project', name: 'pz', parent: 'boss', description: 'A paused listener.' })
  const hz = await opTry({ op: 'hire', name: 'ez', parent: 'pz', tier: 'haiku', grant: 0, title: 'Worker Z' })
  await settle('ez hired')
  const dz = await rig.tool('ez', 'orgtree_watchdog', { action: 'create', name: 'pz-queue', kind: 'fair_queue', target: 'pz' })
  const paused = await rig.tool('ez', 'orgtree_watchdog', { action: 'pause', id: 'pz-queue' })
  const t4 = await post('pz', 'Is anyone there?')
  p.check('a project whose only listener is paused gets the paused note, not the no-listener warning',
    pz.ok && hz.ok && dz.ok && paused.ok && t4.ok && /only listener is paused/.test(t4.text ?? '') && unwarned(t4.text), t4.text)

  // ------------------------------------------------------------ the user's send from the project desk
  const uq = await opTry({ op: 'create_project', name: 'uq', parent: 'boss', description: 'A member, no listener.' })
  const hu = await opTry({ op: 'hire', name: 'eu', parent: 'uq', tier: 'haiku', grant: 0, title: 'Worker U' })
  await settle('eu hired')
  const u1 = await userPost('uq', 'Who takes this?')
  const d1 = u1.ok ? u1.v.delivery : u1.error
  p.check('the user\'s send to a project with no listeners is warned, ahead of the agent the wake asked',
    uq.ok && hu.ok && u1.ok && /^Warning: /.test(d1 ?? '') && warned(d1, 'uq') && /eu was woken and asked to/.test(d1 ?? ''), d1)
  const u2 = await userPost('lone', 'Still nobody?')
  const d2 = u2.ok ? u2.v.delivery : u2.error
  p.check('with nobody under the project to wake, the user is warned and told nobody can pick it up',
    u2.ok && warned(d2, 'lone') && /nobody can pick it up/.test(d2 ?? ''), d2)
  p.check('the user\'s note has no agent tool syntax', u1.ok && u2.ok && !/orgtree_/.test(d1 + d2), { d1, d2 })
  await settle('eu woken')

  // ------------------------------------------------------------ a listener attaches: no more warning
  const du = await rig.tool('eu', 'orgtree_watchdog', { action: 'create', name: 'uq-queue', kind: 'fair_queue', target: 'uq' })
  await settle('eu takes the waiting mail')
  const t5 = await post('uq', 'Next job for uq')
  // arming starts hand-out rounds of its own; one of them can take the new
  // mail just before the send's own round, whose note then says it is queued
  // for the listener: either way a listener is attached and nobody is warned
  p.check('once a listener attaches, the next send is not warned', du.ok && t5.ok
    && /handed it to eu|of its 1 listener/.test(t5.text ?? '') && unwarned(t5.text), { dog: said(du), said: t5.text })

  // ------------------------------------------------------------ the inbox listing keeps its queue line
  const inbox = await rig.tool('boss', 'orgtree_inbox', { action: 'list', project: 'lone' })
  const queue = inbox.json?.queue ?? ''
  p.check('orgtree_inbox project=lone keeps its own queue line; the warning is per send', inbox.ok
    && /No agent watches the project/.test(queue) && !/Warning/.test(queue), said(inbox))

  await settle('the last turns')
  p.file('mail.json', rig.sql(`SELECT uid, sender, recipient_name, state, notice, body, extra FROM ot.mail ORDER BY id`))
  p.keep(rig, { agents: ['boss', 'ew', 'ez', 'eu'], grep: /project|fair_queue|dispatch|listener/i })
  return p.summary()
}
