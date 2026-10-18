// Proof: a project's dead-letter queue (docket
// project-dead-letter-queue-failed-ack-queue-jobs-a; user 2026-10-18 19:38Z-19:40Z),
// through the real engine.
//   a job that runs out of attempts keeps its mail, sender, attempt history (who
//   held it, when, how each attempt ended) and the final reason
//   agents above AND below the project list and read dead letters
//   (orgtree_project dead_letters), an agent outside its reach is refused
//   the project node in the tree carries the open dead-letter count
//   retry puts the job back in the queue with its attempts reset; drop keeps it
//   out of the open list with a reason; both refuse outside the project's reach
//   an event watchdog on project.dead_letter fires for an agent with reach and
//   stays silent for one without
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-dead-letters.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-dead-letters')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 400)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, kind, scope, state, halt FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mailTo = id => rig.sql(`SELECT id, uid, sender, state, notice, body, extra FROM ot.mail WHERE recipient_agent_id = ${id} ORDER BY id`)
  const dlMail = text => rig.one(`SELECT uid, state, extra FROM ot.mail WHERE recipient_agent_id = ${node('dl').id} AND body = '${text}'`)
  const toDl = text => rig.userMail('dl', text, { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const haltDz = async on => {
    await opTry({ op: on ? 'halt' : 'unhalt', nodes: ['dz'] })
    await rig.waitFor(() => on ? node('dz')?.halt?.phase === 'halted' : !node('dz')?.halt, { what: `dz ${on ? '' : 'un'}halted`, timeout: 20000 }).catch(() => {})
  }
  const holder = text => dlMail(text)?.extra?.claimed?.by
  // a job given two hand-outs while its only listener is halted in between ends in the dead letters
  const kill = async text => {
    await toDl(text)
    await rig.waitFor(() => holder(text) === 'dz', { what: `the first hand-out of ${text}`, timeout: 20000 }).catch(() => {})
    await haltDz(true)
    await haltDz(false)
    await rig.waitFor(() => holder(text) === 'dz', { what: `the second hand-out of ${text}`, timeout: 20000 }).catch(() => {})
    await haltDz(true)
    await rig.waitFor(() => !!dlMail(text)?.extra?.dead_letter, { what: `the dead letter ${text}`, timeout: 20000 }).catch(() => {})
    await haltDz(false)
  }
  const tree = async () => {
    const t = await rig.api('GET', `/api/orgs/${rig.org}`)
    const all = []
    const walk = n => { all.push(n); for (const c of n.children ?? []) walk(c) }
    for (const r of t.roots ?? []) walk(r)
    return all
  }
  const tool = (who, args) => rig.tool(who, 'orgtree_project', args)
  // a refusal that is the action's own, not the tool not knowing the action
  const refused = r => !r.ok && !/orgtree_project takes/.test(r.text ?? '')
  const list = (who, extra = {}) => tool(who, { action: 'dead_letters', name: 'dl', ...extra })

  // ------------------------------------------------------------ the project, its members and watchers
  const dl = await opTry({ op: 'create_project', name: 'dl', parent: 'boss', description: 'Dead letters.' })
  const hz = await opTry({ op: 'hire', name: 'dz', parent: 'dl', tier: 'haiku', grant: 0, title: 'Lone worker' })
  const ho = await opTry({ op: 'hire', name: 'xo', parent: 'boss', tier: 'haiku', grant: 0, title: 'Outsider' })
  await settle('hires')
  const dz = await rig.tool('dz', 'orgtree_watchdog', { action: 'create', name: 'dl-queue', kind: 'fair_queue', target: 'dl' })
  const setDl = await opTry({ op: 'set_mail_queue', node: 'dl', mode: 'ack', max_attempts: 2 })
  const evBoss = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'dl-watch', kind: 'event', target: 'project.dead_letter', interval_s: 15 })
  const evXo = await rig.tool('xo', 'orgtree_watchdog', { action: 'create', name: 'dl-watch-xo', kind: 'event', target: 'project.dead_letter', interval_s: 15 })
  p.check('project dl with a listener, an ack queue of 2 attempts and two event watchdogs', dl.ok && hz.ok && ho.ok && dz.ok && setDl.ok && evBoss.ok && evXo.ok,
    { dl: dl.ok || dl.error, dz: said(dz), set: setDl.ok || setDl.error, evBoss: said(evBoss), evXo: said(evXo) })

  const emptyList = await list('boss')
  p.check('a project with no dead letters lists none', emptyList.ok && emptyList.json?.total === 0 && (emptyList.json?.letters ?? []).length === 0, said(emptyList))

  // ------------------------------------------------------------ a job runs out of attempts
  await kill('Doomed task')
  const dead = dlMail('Doomed task')
  p.check('the job went to the dead letters (setup control)', !!dead?.extra?.dead_letter && dead.extra.dead_letter.attempts === 2, dead)

  const l1 = await list('boss')
  const row = (l1.json?.letters ?? [])[0]
  p.check('an agent above the project lists the dead letter with sender, attempts, last holder and reason',
    l1.ok && l1.json?.total === 1 && row?.id === dead?.uid && row?.from === '@user' && row?.attempts === 2 && row?.by === 'dz'
      && /halted/.test(row?.why ?? '') && /Doomed task/.test(row?.preview ?? ''), said(l1))
  const got = await list('boss', { id: dead?.uid })
  const g = got.json ?? {}
  p.check('reading it returns the whole mail, the final reason and the attempt history', got.ok && g.id === dead?.uid && g.body === 'Doomed task'
    && Array.isArray(g.history) && g.history.length === 2
    && g.history.every(h => h.by === 'dz' && !!h.at && !!h.ended?.at && h.ended?.how === 'released' && /halted/.test(h.ended?.why ?? ''))
    && g.history[0].n === 1 && g.history[1].n === 2 && /halted/.test(g.reason ?? ''), said(got))
  const member = await list('dz')
  p.check('an agent below the project lists them too', member.ok && member.json?.total === 1, said(member))
  const outsider = await list('xo')
  p.check('an agent outside the project\'s reach is refused', refused(outsider) && /above or below|reach|only/i.test(outsider.text ?? ''), said(outsider))
  const nodes = await tree()
  p.check('the project in the tree carries its open dead-letter count', nodes.find(n => n.id === 'dl')?.dead_letters === 1
    && !(nodes.find(n => n.id === 'dz')?.dead_letters > 0), nodes.filter(n => n.id === 'dl' || n.id === 'dz').map(n => [n.id, n.dead_letters]))

  // ------------------------------------------------------------ the event watchdogs
  await rig.waitFor(() => (rig.one(`SELECT fired FROM ot.watchdogs WHERE name = 'dl-watch'`)?.fired ?? 0) >= 1, { what: 'boss\'s dead-letter event dog', timeout: 40000 }).catch(() => {})
  const dogB = rig.one(`SELECT fired, events, state FROM ot.watchdogs WHERE name = 'dl-watch'`)
  const dogX = rig.one(`SELECT fired, events, state FROM ot.watchdogs WHERE name = 'dl-watch-xo'`)
  p.check('the event watchdog of an agent with reach fired, naming the project and the mail', (dogB?.fired ?? 0) >= 1
    && JSON.stringify(dogB?.events ?? '').includes(dead?.uid ?? '?') && /"dl"|dl\b/.test(JSON.stringify(dogB?.events ?? '')), dogB)
  p.check('the one of an agent without reach did not', (dogX?.fired ?? 0) === 0, dogX)

  // ------------------------------------------------------------ retry
  const xoRetry = await tool('xo', { action: 'retry_dead_letter', name: 'dl', id: dead?.uid })
  p.check('retry is refused outside the project\'s reach and leaves the letter', refused(xoRetry) && !!dlMail('Doomed task')?.extra?.dead_letter, said(xoRetry))
  const retried = await tool('boss', { action: 'retry_dead_letter', name: 'dl', id: dead?.uid })
  await rig.waitFor(() => holder('Doomed task') === 'dz', { what: 'the retried job handed out again', timeout: 20000 }).catch(() => {})
  const after = dlMail('Doomed task')
  p.check('retry puts the job back with its attempts reset: it is handed out again as attempt 1, history kept',
    retried.ok && !after?.extra?.dead_letter && after?.extra?.attempts === 1 && after?.extra?.claimed?.by === 'dz'
      && (after?.extra?.attempt_log ?? []).length === 3 && !!after?.extra?.retried?.[0]?.by, { said: said(retried), extra: after?.extra })
  const l2 = await list('boss')
  p.check('the dead-letter list is empty again', l2.ok && l2.json?.total === 0, said(l2))
  const again = await tool('boss', { action: 'retry_dead_letter', name: 'dl', id: dead?.uid })
  p.check('retrying a job that is no longer a dead letter is refused', refused(again), said(again))

  // ------------------------------------------------------------ drop
  const acked = await rig.tool('dz', 'orgtree_message', { metadata: { to: 'dl', reply_to: after?.extra?.claimed?.copy }, body: 'Done.' })
  await settle('the ack')
  await kill('Second doomed')
  const second = dlMail('Second doomed')
  const noReason = await tool('boss', { action: 'drop_dead_letter', name: 'dl', id: second?.uid })
  p.check('dropping a dead letter needs a reason', refused(noReason) && /reason/i.test(noReason.text ?? '') && !!dlMail('Second doomed')?.extra?.dead_letter && !dlMail('Second doomed')?.extra?.dead_letter_dropped, said(noReason))
  const xoDrop = await tool('xo', { action: 'drop_dead_letter', name: 'dl', id: second?.uid, reason: 'not mine' })
  p.check('dropping is refused outside the project\'s reach', refused(xoDrop) && !dlMail('Second doomed')?.extra?.dead_letter_dropped, said(xoDrop))
  const dropped = await tool('dz', { action: 'drop_dead_letter', name: 'dl', id: second?.uid, reason: 'obsolete request' })
  const l3 = await list('boss')
  const l4 = await list('boss', { include_dropped: true })
  p.check('a member drops it with a reason: it leaves the open list and the count, and stays readable',
    dropped.ok && l3.json?.total === 0 && l4.json?.letters?.length === 1 && l4.json.letters[0].dropped?.reason === 'obsolete request'
      && l4.json.letters[0].dropped?.by === 'dz', { dropped: said(dropped), l3: said(l3), l4: said(l4) })
  const retryDropped = await tool('boss', { action: 'retry_dead_letter', name: 'dl', id: second?.uid })
  p.check('a dropped letter cannot be retried', refused(retryDropped) && dlMail('Second doomed')?.state === 'read', said(retryDropped))
  const nodes2 = await tree()
  p.check('the tree count follows (no open dead letters left)', !(nodes2.find(n => n.id === 'dl')?.dead_letters > 0), nodes2.find(n => n.id === 'dl')?.dead_letters)

  p.file('mail.json', rig.sql(`SELECT uid, sender, recipient_name, state, notice, body, extra FROM ot.mail ORDER BY id`))
  p.keep(rig, { agents: ['dz', 'boss', 'xo'], grep: /project|fair_queue|dispatch|ack|dead/i })
  return p.summary()
}
