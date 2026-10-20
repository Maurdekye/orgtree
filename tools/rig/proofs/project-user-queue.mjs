// Proof: the USER joins a project's mail queue as a listener (docket
// let-the-user-manually-hold-a-number-of-a-project; user 2026-10-20 13:04:56Z
// "also allow the user to register themselves as a mail queue listener",
// 13:22Z "yes to all three": leaving keeps a held job until it is ACKed),
// through the real engine and the user's ops.
//   user_queue_join: a fair_queue dog with no agent owner; the user takes
//   their turn in the round-robin with the agents; the jobs the queue hands
//   them arrive as normal mail in their inbox (recipient_kind 'user')
//   the user counts as a listener: a post to a project only the user
//   listens to is not told "no listeners"; ACK mode: the user holds one job
//   per batch, a second waits ("all holding an un-acked job")
//   user_job_ack ends the attempt as acked (Reply & acknowledge keeps a
//   reply mail they sent as the completion record) and frees their place:
//   the queue hands them the next job at once; ack twice and ack of ordinary
//   mail are refused
//   leaving the queue keeps a held job until it is acknowledged: nothing
//   reclaims it, and the engine refuses to take it back
//   the user's listener and held job survive an engine restart
//   joining again updates the batch in place (the desk header's "Join mail
//   queue N times", user 2026-10-20 16:39Z): the same dog keeps its place in
//   the order, a raised batch hands a waiting job at once, a lowered one
//   reclaims nothing (a held job stays held until acknowledged)
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-user-queue.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-user-queue')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.v ?? r.text) : String(r?.text ?? r?.error)).slice(0, 400)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const safe = (fn, dflt) => { try { return fn() } catch { return dflt } }
  const org = () => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const node = name => rig.one(`SELECT id, name, kind, scope FROM ot.agents WHERE org_id = ${org()} AND name = '${name}' AND state <> 'deleted'`)
  const userDogs = () => safe(() => rig.sql(`SELECT id, uid, kind, state, owner_agent_id, owner_kind, fired, memo FROM ot.watchdogs
                                   WHERE owner_kind = 'user' AND kind = 'fair_queue' ORDER BY id`), [])
  // the jobs the queue handed the user, in their inbox
  const userCopies = project => safe(() => rig.sql(`SELECT uid, body, state, notice, recipient_kind, recipient_name, extra FROM ot.mail
                                   WHERE recipient_kind = 'user' AND extra->'via_project'->>'name' = '${project}' ORDER BY id`), [])
  const agentCopies = (who, project) => rig.sql(`SELECT uid, body FROM ot.mail WHERE recipient_agent_id = ${node(who).id}
                                   AND extra->'via_project'->>'name' = '${project}' ORDER BY id`)
  // the project's own copies of the jobs it has handed out (they carry an attempt count)
  const jobs = project => rig.sql(`SELECT uid, state, body, extra FROM ot.mail WHERE recipient_agent_id = ${node(project).id}
                                   AND extra ? 'attempts' ORDER BY id`)
  const waiting = project => rig.sql(`SELECT uid, body FROM ot.mail WHERE recipient_agent_id = ${node(project).id} AND state = 'pending' ORDER BY id`)
  const jobOf = (project, body) => jobs(project).find(j => j.body.includes(body))
  const post = (project, text) => rig.tool('boss', 'orgtree_message', { metadata: { to: project }, body: text })
  const history = project => opTry({ op: 'mail_queue_history', node: project })

  // ------------------------------------------------------------ round-robin: the user takes a turn
  const made = await opTry({ op: 'create_project', name: 'uq', parent: 'boss', description: 'A round-robin queue.' })
  const hire = await opTry({ op: 'hire', name: 'ea', parent: 'uq', tier: 'haiku', grant: 0, title: 'Worker A' })
  await settle('hire turns')
  const da = await rig.tool('ea', 'orgtree_watchdog', { action: 'create', name: 'uq-queue', kind: 'fair_queue', target: 'uq' })
  const join = await opTry({ op: 'user_queue_join', node: 'uq', batch: 1 })
  const ud = userDogs()[0]
  p.check('the user joins the queue: a fair_queue dog with no agent owner, armed', made.ok && hire.ok && da.ok && join.ok && ud?.state === 'armed'
    && ud?.owner_agent_id === null && ud?.owner_kind === 'user', { join: join.ok ? join.v : join.error, dogs: userDogs() })
  const dogBefore = userDogs()[0]
  const same = await opTry({ op: 'user_queue_join', node: 'uq', batch: 1 })
  p.check('joining again with the same batch changes nothing', same.ok && same.v?.updated === false && userDogs().length === 1
    && userDogs()[0].id === dogBefore.id, same)
  const twice = await opTry({ op: 'user_queue_join', node: 'uq', batch: 3 })
  p.check('joining again with another batch updates it in place: the same dog, still one per project, armed',
    twice.ok && twice.v?.updated === true && userDogs().length === 1 && userDogs()[0].id === dogBefore.id
    && userDogs()[0].uid === dogBefore.uid && userDogs()[0].state === 'armed' && Number(userDogs()[0].memo?.batch) === 3
    && userDogs()[0].fired === dogBefore.fired, { twice: twice.ok ? twice.v : twice.error, dogs: userDogs() })
  const lowAgain = await opTry({ op: 'user_queue_join', node: 'uq', batch: 1 })
  const tooMany = await opTry({ op: 'user_queue_join', node: 'uq', batch: 21 })
  const none = await opTry({ op: 'user_queue_join', node: 'uq', batch: 0 })
  p.check('an update keeps to the batch limit: 1 to 20', lowAgain.ok && Number(userDogs()[0].memo?.batch) === 1 && !tooMany.ok && !none.ok
    && /1 to 20/.test(tooMany.error ?? '') && Number(userDogs()[0].memo?.batch) === 1, { tooMany: tooMany.error, none: none.error })

  for (const n of [1, 2, 3, 4]) await post('uq', `Job ${n}`)
  await settle('jobs handed out')
  const mine = userCopies('uq')
  const hers = agentCopies('ea', 'uq')
  p.check('the user takes their turn: two of four jobs each (round-robin counts the user)', mine.length === 2 && hers.length === 2
    && mine.map(m => m.body).join('|').includes('Job 2') && hers.map(m => m.body).join('|').includes('Job 1'),
    { user: mine.map(m => m.body.slice(0, 40)), ea: hers.map(m => m.body.slice(0, 40)) })
  p.check('a handed job is normal mail in the user\'s inbox (to @user, unread), via the project', mine.every(m => m.recipient_kind === 'user'
    && m.recipient_name === '@user' && m.state === 'pending' && m.extra?.via_project?.name === 'uq' && m.extra?.via_project?.ack === false), mine.map(m => m.extra))
  const hist = await history('uq')
  p.check('the project\'s delivered list names the user ("user"), not a missing agent', hist.ok
    && (hist.v?.history ?? []).filter(h => h.agent === 'user').length === 2 && (hist.v?.history ?? []).every(h => typeof h.agent === 'string'), said(hist))
  const left = await opTry({ op: 'user_queue_leave', node: 'uq' })
  await post('uq', 'Job 5')
  await post('uq', 'Job 6')
  await settle('after leaving')
  p.check('after the user leaves, every job goes to the agent', left.ok && userDogs()[0]?.state === 'removed' && userCopies('uq').length === 2
    && agentCopies('ea', 'uq').length === 4, { left: left.ok ? left.v : left.error, user: userCopies('uq').length, ea: agentCopies('ea', 'uq').length })
  const leaveAgain = await opTry({ op: 'user_queue_leave', node: 'uq' })
  p.check('leaving a queue the user is not in is refused', !leaveAgain.ok && /not in project/.test(leaveAgain.error ?? ''), leaveAgain)

  // ------------------------------------------------------------ ACK mode, the user the only listener
  const made2 = await opTry({ op: 'create_project', name: 'uqa', parent: 'boss', description: 'An ack queue only the user listens to.' })
  const ack = await opTry({ op: 'set_mail_queue', node: 'uqa', mode: 'ack' })
  const join2 = await opTry({ op: 'user_queue_join', node: 'uqa', batch: 1 })
  const j1 = await post('uqa', 'Review the notes')
  const j2 = await post('uqa', 'Second review')
  await settle('ack jobs')
  p.check('the user alone listens in ACK mode: a post to the project is not told "no listeners"', made2.ok && ack.ok && join2.ok
    && j1.ok && !/no listeners|No agent watches/i.test(j1.text ?? '') && j2.ok && !/no listeners|No agent watches/i.test(j2.text ?? ''), { j1: j1.text, j2: j2.text })
  p.check('a second post while the user holds one un-acked job waits, and says so (the user counts as a listener holding a job)',
    /1 listener, all holding an un-acked job/.test(j2.text ?? '') && userCopies('uqa').length === 1, { j2: j2.text, copies: userCopies('uqa').length })
  const note = await rig.userMail('uqa', 'A note from the user', { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  p.check('the user\'s own post to that project is not told it has no listeners either, and no agent is woken to attach one',
    note.ok && !/Warning|no listeners|woken and asked/i.test(note.v?.delivery ?? ''), note.ok ? note.v?.delivery : note.error)
  const copy = userCopies('uqa')[0]
  const job = jobOf('uqa', 'Review the notes')
  p.check('the held job is claimed by the user: by "user", no agent id, ack required', job?.state === 'read' && job?.extra?.claimed?.by === 'user'
    && job?.extra?.claimed?.by_id === null && job?.extra?.claimed?.by_user === true && job?.extra?.claimed?.ack === true && !job?.extra?.claimed?.acked_at,
    job?.extra?.claimed)
  const h2 = await history('uqa')
  const working = h2.v?.working ?? []
  p.check('the desk\'s Working list names the user and their listener', h2.ok && working.length === 1 && working[0].agent === 'user' && working[0].mail === job?.uid
    && working[0].dog?.id === `user/${userDogs().find(d => d.state === 'armed')?.uid}`, said(h2))
  const nth = await opTry({ op: 'mail_take_back', node: 'uqa', mail: job?.uid })
  p.check('the user\'s own job cannot be taken back; they acknowledge it', !nth.ok && /user's own job/.test(nth.error ?? ''), nth)

  // ------------------------------------------------------------ leaving keeps the held job
  const left2 = await opTry({ op: 'user_queue_leave', node: 'uqa' })
  await post('uqa', 'Third review')
  await settle('dispatch after leaving')
  const stillHeld = jobOf('uqa', 'Review the notes')
  p.check('leaving the queue keeps the held job: it stays claimed by the user, un-acked, with nobody reclaiming it',
    left2.ok && stillHeld?.state === 'read' && stillHeld?.extra?.claimed?.by_user === true && !stillHeld?.extra?.claimed?.acked_at && !stillHeld?.extra?.released,
    { left2: left2.ok ? left2.v : left2.error, claimed: stillHeld?.extra?.claimed, released: stillHeld?.extra?.released })
  p.check('with nobody listening the later jobs wait in the project\'s mailbox (the second review, the user\'s note, the third review)',
    waiting('uqa').length === 3 && userCopies('uqa').length === 1, waiting('uqa').map(w => w.body.slice(0, 30)))

  // ------------------------------------------------------------ acknowledge
  const reply = await rig.userMail('boss', 'Reviewed: the notes read well.', { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const notAJob = await opTry({ op: 'user_job_ack', copy: userCopies('uq')[0]?.uid })
  p.check('an ordinary job copy of a round-robin project cannot be acknowledged', !notAJob.ok && /ACK mode|nothing to acknowledge/.test(notAJob.error ?? ''), notAJob)
  const noMail = await opTry({ op: 'user_job_ack', copy: 'nosuchmail' })
  p.check('an unknown mail cannot be acknowledged', !noMail.ok && /no mail/.test(noMail.error ?? ''), noMail)
  const badReply = await opTry({ op: 'user_job_ack', copy: copy?.uid, reply: 'notmymail' })
  p.check('the reply must be a mail the user sent', !badReply.ok && /reply is the id of a mail you sent/.test(badReply.error ?? ''), badReply)
  const done = await opTry({ op: 'user_job_ack', copy: copy?.uid, reply: reply.v?.id })
  const after = jobOf('uqa', 'Review the notes')
  const ending = safe(() => rig.one(`SELECT agent_id, agent_name, how, ack_uid, copy_uid FROM ot.project_mail_endings WHERE mail_uid = '${job?.uid}'`), null)
  p.check('Reply & acknowledge ends the attempt as acked, keeping the reply as the completion record', reply.ok && done.ok
    && !!after?.extra?.claimed?.acked_at && after?.extra?.claimed?.ack_mail === reply.v?.id
    && ending?.how === 'acked' && ending?.agent_name === 'user' && ending?.agent_id === null && ending?.ack_uid === reply.v?.id,
    { done: done.ok ? done.v : done.error, claimed: after?.extra?.claimed, ending })
  const copyAfter = userCopies('uqa').find(m => m.uid === copy?.uid)
  p.check('the user\'s copy is marked acknowledged for the inbox reader', !!copyAfter?.extra?.via_project?.acked_at, copyAfter?.extra?.via_project)
  const twiceAck = await opTry({ op: 'user_job_ack', copy: copy?.uid })
  p.check('a job already acknowledged cannot be acknowledged again', !twiceAck.ok && /already acknowledged/.test(twiceAck.error ?? ''), twiceAck)

  // ------------------------------------------------------------ rejoin: the queue hands the next job at once; a restart keeps the hold
  const rejoin = await opTry({ op: 'user_queue_join', node: 'uqa', batch: 1 })
  await rig.waitFor(() => userCopies('uqa').length === 2, { what: 'the waiting job handed to the user on rejoining', timeout: 30000 }).catch(() => {})
  const second = jobOf('uqa', 'Second review') ?? jobs('uqa').find(j => j.extra?.claimed?.by_user === true && !j.extra?.claimed?.acked_at)
  p.check('rejoining hands the user the oldest waiting job at once', rejoin.ok && userCopies('uqa').length === 2 && second?.extra?.claimed?.by_user === true && !second?.extra?.claimed?.acked_at,
    { rejoin: rejoin.ok ? rejoin.v : rejoin.error, copies: userCopies('uqa').map(m => m.body.slice(0, 30)) })
  await rig.restart()
  await settle('after restart')
  // a post makes the queue run (and release any held job whose holder is gone): the user's stays theirs
  await post('uqa', 'After the restart')
  await settle('dispatch after restart')
  const heldAfterRestart = jobs('uqa').filter(j => j.extra?.claimed?.by_user === true && !j.extra?.claimed?.acked_at)
  p.check('the user\'s listener and held job survive an engine restart, unreclaimed', userDogs().some(d => d.state === 'armed') && heldAfterRestart.length === 1
    && !heldAfterRestart[0].extra?.released, { dogs: userDogs().map(d => d.state), held: heldAfterRestart.map(j => j.body.slice(0, 30)) })
  const doneNoReply = await opTry({ op: 'user_job_ack', copy: userCopies('uqa').at(-1)?.uid })
  p.check('Acknowledge without reply ends it too, and frees the place for the next job', doneNoReply.ok
    && jobs('uqa').filter(j => j.extra?.claimed?.by_user === true && !j.extra?.claimed?.acked_at).length === 1,
    { done: doneNoReply.ok ? doneNoReply.v : doneNoReply.error, held: jobs('uqa').filter(j => j.extra?.claimed?.by_user === true).map(j => ({ b: j.body.slice(0, 20), acked: !!j.extra?.claimed?.acked_at })) })

  // ------------------------------------------------------------ the batch changes in place
  const made3 = await opTry({ op: 'create_project', name: 'uqb', parent: 'boss', description: 'An ack queue to change the batch of.' })
  const ack3 = await opTry({ op: 'set_mail_queue', node: 'uqb', mode: 'ack' })
  const join3 = await opTry({ op: 'user_queue_join', node: 'uqb', batch: 1 })
  const armed3 = () => userDogs().filter(d => d.state === 'armed' && Number(d.memo?.target_id) === node('uqb').id)
  const dog3 = armed3()[0]
  await post('uqb', 'Job A')
  await post('uqb', 'Job B')
  await post('uqb', 'Job C')
  await settle('batch jobs')
  p.check('batch 1: the user holds one job, the others wait', made3.ok && ack3.ok && join3.ok && userCopies('uqb').length === 1
    && waiting('uqb').length === 2, { copies: userCopies('uqb').length, waiting: waiting('uqb').length })
  const raise = await opTry({ op: 'user_queue_join', node: 'uqb', batch: 2 })
  await rig.waitFor(() => userCopies('uqb').length === 2, { what: 'a raised batch hands the next waiting job at once', timeout: 30000 }).catch(() => {})
  const heldNow = () => jobs('uqb').filter(j => j.extra?.claimed?.by_user === true && !j.extra?.claimed?.acked_at)
  p.check('raising the batch hands the next waiting job at once, to the same listener, keeping the job already held',
    raise.ok && raise.v?.updated === true && userCopies('uqb').length === 2 && waiting('uqb').length === 1 && heldNow().length === 2
    && armed3().length === 1 && armed3()[0].uid === dog3.uid && jobOf('uqb', 'Job A')?.extra?.claimed?.by_user === true,
    { raise: raise.ok ? raise.v : raise.error, copies: userCopies('uqb').length, waiting: waiting('uqb').length })
  const lower = await opTry({ op: 'user_queue_join', node: 'uqb', batch: 1 })
  await post('uqb', 'Job D')
  await settle('after lowering')
  p.check('lowering the batch below the jobs held reclaims nothing: both stay held, and nothing more is handed out',
    lower.ok && lower.v?.updated === true && heldNow().length === 2 && userCopies('uqb').length === 2 && waiting('uqb').length === 2
    && !jobs('uqb').some(j => j.extra?.released), { lower: lower.ok ? lower.v : lower.error, held: heldNow().length, waiting: waiting('uqb').length })
  const ackA = await opTry({ op: 'user_job_ack', copy: userCopies('uqb')[0]?.uid })
  await settle('after the first ack')
  p.check('still over the new batch after one acknowledgement: no new job yet', ackA.ok && heldNow().length === 1 && userCopies('uqb').length === 2, { held: heldNow().length })
  const ackB = await opTry({ op: 'user_job_ack', copy: userCopies('uqb')[1]?.uid })
  await rig.waitFor(() => userCopies('uqb').length === 3, { what: 'the next job once under the batch', timeout: 30000 }).catch(() => {})
  p.check('under the batch again, the next waiting job is handed', ackB.ok && userCopies('uqb').length === 3 && heldNow().length === 1,
    { copies: userCopies('uqb').length, held: heldNow().length })

  await settle('the last turns')
  p.file('user-dogs.json', userDogs())
  p.file('user-copies.json', userCopies('uqa'))
  p.keep(rig, { agents: ['ea', 'boss'], grep: /queue|fair|ack/i })
  return p.summary()
}
