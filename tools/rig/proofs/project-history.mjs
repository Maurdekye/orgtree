// Proof: the project desk's history (docket
// project-desk-mail-event-listeners-and-slots-tabs; user 2026-10-20 06:22Z,
// design approved by coordinator-opus 06:36Z), through the real engine.
//   a project's event Listeners tab follows `listeners_seen` in the tree:
//   false on a fresh project, true from its first project_listener or
//   listener_watch, and still true once that is removed
//   every fired event is kept (op listener_history), newest first: who
//   fired it, its whole message, and every listener it reached with when
//   that listener began listening (its arming, or its previous event); a
//   listener watch's crossing is kept with its owner, count, the armed
//   number and the listeners armed then; 30 a time, a cursor pages the rest;
//   the tree's `last_fire` moves with every fire
//   every hand-out records when its listener began waiting (its last
//   hand-out, ack or arming); an ack frees the listener's dog (`freed_at`);
//   op mail_queue_history lists, in ack mode, the jobs held now and the
//   finished ones newest ack first with their ack, and in round-robin the
//   deliveries newest first; 30 a time
//   slot holders and recent holds carry their claim dog, for the desk only:
//   the agent tool's slots action keeps its output
//   the mail history names the project's dead-letter listeners, also one
//   past its owner's eight-dog tree preview (watchdog uncap 2026-10-20)
//   the migration's backfill copies earlier fires from ot.events and marks
//   projects that had listeners; running it again adds nothing
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-history.mjs

import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
import { REPO } from '../lib.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-history')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.v ?? r.text) : String(r?.text ?? r?.error)).slice(0, 500)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const org = () => rig.one(`SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active'`).id
  const node = name => rig.one(`SELECT id, name, extra FROM ot.agents
                                  WHERE org_id = ${org()} AND name = '${name}' AND state <> 'deleted'`)
  const ms = iso => (typeof iso === 'string' ? Date.parse(iso) : NaN)
  // a database time as the engine's iso() writes it: whole milliseconds, truncated
  const dbMs = query => Number(rig.one(`SELECT floor(extract(epoch FROM s.v) * 1000)::bigint AS v FROM (${query}) s`)?.v)
  const dogAt = (who, name) => dbMs(`SELECT created_at AS v FROM ot.watchdogs WHERE owner_agent_id = ${node(who).id} AND name = '${name}' ORDER BY id DESC LIMIT 1`)
  const tree = async () => {
    const t = await rig.api('GET', `/api/orgs/${rig.org}`)
    const all = []
    const walk = n => { all.push(n); for (const c of n.children ?? []) walk(c) }
    for (const r of t.roots ?? []) walk(r)
    return all
  }
  const treeNode = async id => (await tree()).find(n => n.id === id)
  const project = async (name, workers) => {
    const made = await opTry({ op: 'create_project', name, parent: 'boss', description: `History testbed ${name}.` })
    const hires = []
    for (const w of workers) hires.push(await opTry({ op: 'hire', name: w, parent: name, tier: 'haiku', grant: 0, title: `Worker ${w}` }))
    await settle(`${name} hires`)
    return made.ok && hires.every(h => h.ok)
  }
  // passive listeners: their fire mail wakes nobody, so no turns pile up
  const listen = (who, name, target, extra = {}) =>
    rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'project_listener', target, once: false, notice: true, ...extra })
  const fire = (who, name, body) => rig.tool(who, 'orgtree_project', { action: 'fire_event', name, ...(body ? { body } : {}) })
  const history = (name, before) => opTry({ op: 'listener_history', node: name, ...(before ? { history_before: before } : {}) })
  const queue = (name, before) => opTry({ op: 'mail_queue_history', node: name, ...(before ? { history_before: before } : {}) })

  // ------------------------------------------------------------ listeners_seen
  const madeX = await project('hx', ['ha', 'hb'])
  const fresh = await treeNode('hx')
  p.check('a fresh project has never had a listener: its tree node says so', madeX && !!fresh && fresh.listeners_seen === false,
    { made: madeX, listeners_seen: fresh?.listeners_seen })
  const firstEar = await listen('ha', 'ha-ear', 'hx')
  await rig.waitFor(async () => (await treeNode('hx'))?.listeners_seen === true, { what: 'listeners_seen', timeout: 15000 }).catch(() => {})
  p.check('its first event listener marks it for good (agents.extra.listeners_seen_at)',
    firstEar.ok && (await treeNode('hx'))?.listeners_seen === true && !!node('hx').extra?.listeners_seen_at,
    { said: said(firstEar), extra: node('hx').extra })
  const removed = await rig.tool('ha', 'orgtree_watchdog', { action: 'remove', id: 'ha-ear' })
  await settle('listener removed')
  p.check('removing the listener leaves the mark', removed.ok && (await treeNode('hx'))?.listeners_seen === true, said(removed))
  const madeW = await project('hw', ['hw1'])
  const watchOnly = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'hw-watch', kind: 'listener_watch', target: 'hw', count: 3, notice: true })
  await rig.waitFor(async () => (await treeNode('hw'))?.listeners_seen === true, { what: 'hw listeners_seen', timeout: 15000 }).catch(() => {})
  p.check('a listener watch alone marks its project too', madeW && watchOnly.ok && (await treeNode('hw'))?.listeners_seen === true, said(watchOnly))

  // ------------------------------------------------------------ fired events
  const la = await listen('ha', 'ha-ear2', 'hx')
  const lb = await listen('hb', 'hb-once', 'hx', { once: true })
  const message1 = 'first go\n' + 'x'.repeat(2500)
  const f1 = await fire('boss', 'hx', message1)
  const h1 = await history('hx')
  const row1 = h1.v?.history?.[0]
  const lastFiredA = dbMs(`SELECT last_fired AS v FROM ot.watchdogs WHERE owner_agent_id = ${node('ha').id} AND name = 'ha-ear2'`)
  p.check('a fire is kept: who fired it, its whole message, and each listener it reached, in delivery order',
    la.ok && lb.ok && f1.ok && h1.ok && row1?.kind === 'event' && row1?.by === 'boss' && row1?.message === message1
    && (row1?.listeners ?? []).map(l => l.agent).join() === 'ha,hb'
    && (row1?.listeners ?? []).map(l => l.dog).join() === 'ha-ear2,hb-once',
    { said: said(f1), row: row1 && { ...row1, message: (row1.message ?? '').length } })
  p.check('a listener reached the first time had listened since its arming; the fire time is the dogs\' last fire',
    ms(row1?.listeners?.[0]?.since) === dogAt('ha', 'ha-ear2') && ms(row1?.listeners?.[1]?.since) === dogAt('hb', 'hb-once')
    && ms(row1?.at) === lastFiredA && row1?.listeners?.[1]?.once === true && row1?.listeners?.[0]?.once === false,
    { listeners: row1?.listeners, at: row1?.at, dogA: dogAt('ha', 'ha-ear2'), lastFiredA })
  const fireMail = who => rig.one(`SELECT uid FROM ot.mail WHERE recipient_agent_id = ${node(who).id} AND body LIKE '%PROJECT EVENT%' ORDER BY id DESC LIMIT 1`)?.uid
  const mailA = fireMail('ha'), mailB = fireMail('hb')
  p.check('each listener a fire reached links its own fire mail, in its own mailbox',
    !!mailA && !!mailB && row1?.listeners?.[0]?.mail === mailA && row1?.listeners?.[1]?.mail === mailB
    && !row1?.listeners?.[0]?.mail_gone && !row1?.listeners?.[1]?.mail_gone, { listeners: row1?.listeners, mailA, mailB })
  let removedMail = null
  try { rig.exec(`DELETE FROM ot.mail WHERE uid = '${mailB}'`); removedMail = 'ok' } catch (e) { removedMail = e.message }
  const gone = (await history('hx')).v?.history?.[0]?.listeners?.[1]
  p.check('a fire mail no longer there is marked gone, so its link is not offered', removedMail === 'ok' && gone?.mail === mailB && gone?.mail_gone === true,
    { removedMail, gone })
  const f2 = await fire('boss', 'hx')
  const row2 = (await history('hx')).v?.history?.[0]
  p.check('the next fire reaches the continuous listener only, listening since the previous fire; no message is null',
    f2.ok && row2?.id !== row1?.id && (row2?.listeners ?? []).map(l => l.agent).join() === 'ha'
    && ms(row2?.listeners?.[0]?.since) === ms(row1?.at) && row2?.message == null, row2)
  const lb2 = await listen('hb', 'hb-ear', 'hx')
  const watch = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: 'pair', kind: 'listener_watch', target: 'hx', count: 2, once: true, notice: true })
  await rig.waitFor(async () => (await history('hx')).v?.history?.[0]?.kind === 'watch', { what: 'the watch crossing', timeout: 20000 }).catch(() => {})
  const row3 = (await history('hx')).v?.history?.[0]
  p.check('a listener watch\'s crossing is kept with its owner, dog, count, armed number and the listeners armed then',
    lb2.ok && watch.ok && row3?.kind === 'watch' && row3?.by === 'boss' && row3?.watch?.agent === 'boss' && row3?.watch?.dog === 'pair'
    && row3?.watch?.count === 2 && row3?.watch?.armed === 2 && ms(row3?.watch?.since) === dogAt('boss', 'pair')
    && (row3?.listeners ?? []).map(l => l.agent).join() === 'ha,hb'
    && ms(row3?.listeners?.[0]?.since) === ms(row2?.at) && ms(row3?.listeners?.[1]?.since) === dogAt('hb', 'hb-ear'),
    { said: said(watch), row: row3 })
  const hxTree = await treeNode('hx')
  const newestHx = rig.one(`SELECT max(id) AS id FROM ot.project_fires WHERE project_id = ${node('hx').id}`)?.id
  p.check('the tree\'s last_fire is the newest kept fire', hxTree?.last_fire != null && Number(hxTree?.last_fire) === Number(newestHx),
    { tree: hxTree?.last_fire, newest: newestHx })

  // ------------------------------------------------------------ paging fires
  const madeP = await project('hp', [])
  const fires = []
  for (let i = 0; i < 32; i++) fires.push(await fire('boss', 'hp', `n${i}`))
  const page1 = await history('hp')
  const page2 = await history('hp', page1.v?.history_next)
  const names = rows => (rows ?? []).map(r => r.message).join()
  const want1 = Array.from({ length: 30 }, (_, i) => `n${31 - i}`).join()
  p.check('fires to nobody are kept too, and page 30 at a time, newest first, with a cursor to the rest',
    madeP && fires.every(f => f.ok) && page1.ok && names(page1.v?.history) === want1 && typeof page1.v?.history_next === 'string'
    && page2.ok && names(page2.v?.history) === 'n1,n0' && page2.v?.history_next == null
    && (page1.v?.history ?? []).every(r => (r.listeners ?? []).length === 0),
    { page1: names(page1.v?.history), next: page1.v?.history_next, page2: names(page2.v?.history), next2: page2.v?.history_next, err: page1.error ?? page2.error })
  const bad = await history('hp', 'not-a-cursor')
  p.check('a malformed cursor is refused', !bad.ok && /cursor/.test(bad.error ?? ''), bad)

  // ------------------------------------------------------------ the mail queue, ack mode
  const madeQ = await project('hq', ['qa', 'qb'])
  const qa = await rig.tool('qa', 'orgtree_watchdog', { action: 'create', name: 'hq-queue', kind: 'fair_queue', target: 'hq', notice: true })
  const qb = await rig.tool('qb', 'orgtree_watchdog', { action: 'create', name: 'hq-queue', kind: 'fair_queue', target: 'hq', notice: true })
  const ackMode = await opTry({ op: 'set_mail_queue', node: 'hq', mode: 'ack' })
  await settle('mode notices')
  const toQ = text => rig.userMail('hq', text, { notice: true })
  const job = text => rig.one(`SELECT uid, extra FROM ot.mail WHERE recipient_agent_id = ${node('hq').id} AND body = '${text}'`)
  await toQ('Job 1')
  await toQ('Job 2')
  const q1 = await queue('hq')
  const w1 = q1.v?.working ?? []
  const j1 = job('Job 1'), j2 = job('Job 2')
  const workingOk = [j1, j2].every(j => {
    const r = w1.find(x => x.mail === j?.uid)
    return r && r.agent === j.extra.claimed.by && r.copy === j.extra.claimed.copy && r.dog?.name === 'hq-queue'
      && ms(r.held_at) === Math.floor(ms(j.extra.claimed.at)) && ms(r.waited_from) === dogAt(r.agent, 'hq-queue')
      && /Job [12]/.test(r.gist ?? '')
  })
  p.check('ack mode: the jobs held now are Working, each with its listener, job, copy, wait start (the dog\'s arming) and hand-out',
    madeQ && qa.ok && qb.ok && ackMode.ok && q1.ok && q1.v?.ack === true && w1.length === 2 && workingOk && (q1.v?.history ?? []).length === 0,
    { q: q1.v ?? q1.error, j1: j1?.extra?.claimed, j2: j2?.extra?.claimed })
  const holder = j1?.extra?.claimed?.by
  const ackOf = (who, copy, body) => rig.tool(who, 'orgtree_message', { metadata: { to: 'hq', reply_to: copy }, body })
  const acked = await ackOf(holder, j1?.extra?.claimed?.copy, 'Done: Job 1.')
  const j1a = job('Job 1')
  const record = rig.one(`SELECT uid FROM ot.mail WHERE recipient_agent_id = ${node('hq').id} AND extra->>'ack_of' = '${j1?.uid}'`)
  const q2 = await queue('hq')
  const fin = q2.v?.history?.[0]
  p.check('an acked job is Recently Finished: its listener, job, ack, wait start, hand-out and ack times',
    acked.ok && fin?.agent === holder && fin?.mail === j1?.uid && fin?.ack === record?.uid && /Done: Job 1/.test(fin?.ack_gist ?? '')
    && ms(fin?.held_at) === Math.floor(ms(j1a.extra.claimed.at)) && ms(fin?.ended_at) === Math.floor(ms(j1a.extra.claimed.acked_at))
    && ms(fin?.waited_from) === dogAt(holder, 'hq-queue') && (q2.v?.working ?? []).length === 1,
    { said: said(acked), fin, claimed: j1a?.extra?.claimed, working: q2.v?.working })
  const freed = rig.one(`SELECT memo->'run'->>'freed_at' AS f FROM ot.watchdogs WHERE owner_agent_id = ${node(holder).id} AND name = 'hq-queue'`)?.f
  p.check('the ack frees the listener\'s dog at the ack\'s time', Math.floor(ms(freed)) === Math.floor(ms(j1a.extra.claimed.acked_at)),
    { freed, acked_at: j1a.extra.claimed.acked_at })
  await toQ('Job 3')
  const j3 = job('Job 3')
  p.check('the next job goes to the freed listener, which waited from its ack',
    j3?.extra?.claimed?.by === holder && Math.floor(ms(j3?.extra?.claimed?.waited_from)) === Math.floor(ms(j1a.extra.claimed.acked_at))
    && Array.isArray(j3?.extra?.attempt_log) && !!j3.extra.attempt_log.at(-1)?.waited_from,
    { j3: j3?.extra })
  // 30 more finished jobs from the same listener (the other still holds Job 2)
  let cycled = await ackOf(holder, j3?.extra?.claimed?.copy, 'Done: Job 3.')
  for (let i = 4; i < 34 && cycled.ok; i++) {
    await toQ(`Job ${i}`)
    const j = job(`Job ${i}`)
    cycled = j?.extra?.claimed?.by === holder ? await ackOf(holder, j.extra.claimed.copy, `Done: Job ${i}.`) : { ok: false, text: `Job ${i} went to ${j?.extra?.claimed?.by}` }
  }
  const qp1 = await queue('hq')
  const qp2 = await queue('hq', qp1.v?.history_next)
  const jobs = rows => (rows ?? []).map(r => (r.gist ?? '').replace('Job ', '')).join()
  const wantQ1 = Array.from({ length: 30 }, (_, i) => String(33 - i)).join()
  p.check('Recently Finished pages 30 at a time, newest ack first',
    cycled.ok && qp1.ok && jobs(qp1.v?.history) === wantQ1 && typeof qp1.v?.history_next === 'string'
    && qp2.ok && jobs(qp2.v?.history) === '3,1' && qp2.v?.history_next == null
    && (qp1.v?.history ?? []).every(r => r.how === 'acked'),
    { cycled: said(cycled), page1: jobs(qp1.v?.history), page2: jobs(qp2.v?.history), next: qp1.v?.history_next })

  // ------------------------------------------------------------ take back (user 06:42Z)
  const other = j2?.extra?.claimed?.by
  const otherCopy = j2?.extra?.claimed?.copy
  const otherMails0 = rig.sql(`SELECT id FROM ot.mail WHERE recipient_agent_id = ${node(other).id}`).length
  const back = await opTry({ op: 'mail_take_back', node: 'hq', mail: j2?.uid })
  await rig.waitFor(() => job('Job 2')?.extra?.claimed?.copy !== otherCopy, { what: 'Job 2 handed again', timeout: 20000 }).catch(() => {})
  const j2b = job('Job 2')
  const toldOther = rig.sql(`SELECT body, notice FROM ot.mail WHERE recipient_agent_id = ${node(other).id} ORDER BY id`).slice(otherMails0)
    .filter(m => /took/.test(m.body) && m.body.includes(otherCopy))
  const logged = rig.one(`SELECT actor, detail FROM ot.events WHERE op = 'mail_take_back' ORDER BY id DESC LIMIT 1`)
  const q3 = await queue('hq')
  const takenRow = (q3.v?.history ?? []).find(r => r.mail === j2?.uid)
  p.check('the user takes a held job back: it goes to the other listener first, the holder is told, the engine logs it',
    back.ok && back.v?.taken === true && j2b?.extra?.claimed?.by === holder && toldOther.length === 1 && toldOther[0].notice === true
    && logged?.actor === '@user' && logged?.detail?.mail === j2?.uid && logged?.detail?.holder === other,
    { back: back.ok ? back.v : back.error, j2: j2b?.extra?.claimed, told: toldOther, logged })
  p.check('and the take-back is Recently Finished as taken back, with who and why',
    takenRow?.how === 'taken_back' && takenRow?.agent === other && /@user/.test(takenRow?.why ?? '') && takenRow?.copy === otherCopy,
    takenRow)
  const ackGone = await ackOf(other, otherCopy, 'Done: Job 2 after all.')
  p.check('its old holder can no longer ack it', !ackGone.ok && /no longer yours/.test(ackGone.text ?? ''), said(ackGone))
  const twice = await opTry({ op: 'mail_take_back', node: 'hq', mail: j1?.uid })
  p.check('a job nobody holds cannot be taken back', !twice.ok && /not held|nobody holds|already/.test(twice.error ?? ''), twice)

  // ------------------------------------------------------------ failures and dead letters (user 06:41Z)
  const madeZ = await project('hz', ['zz'])
  const zz = await rig.tool('zz', 'orgtree_watchdog', { action: 'create', name: 'hz-queue', kind: 'fair_queue', target: 'hz', notice: true })
  const setZ = await opTry({ op: 'set_mail_queue', node: 'hz', mode: 'ack', max_attempts: 2 })
  await settle('hz notices')
  const zjob = () => rig.one(`SELECT uid, extra FROM ot.mail WHERE recipient_agent_id = ${node('hz').id} AND body = 'Doomed'`)
  const haltZ = async on => {
    await opTry({ op: on ? 'halt' : 'unhalt', nodes: ['zz'] })
    await rig.waitFor(() => on ? !!rig.agentRow('zz')?.halt : !rig.agentRow('zz')?.halt, { what: `zz ${on ? '' : 'un'}halted`, timeout: 20000 }).catch(() => {})
  }
  await rig.userMail('hz', 'Doomed', { notice: true })
  await haltZ(true)
  await rig.waitFor(() => !zjob()?.extra?.claimed, { what: 'Doomed taken back', timeout: 20000 }).catch(() => {})
  await haltZ(false)
  await rig.waitFor(() => zjob()?.extra?.claimed?.by === 'zz', { what: 'Doomed handed again', timeout: 20000 }).catch(() => {})
  await haltZ(true)
  await rig.waitFor(() => !!zjob()?.extra?.dead_letter, { what: 'Doomed dead-lettered', timeout: 20000 }).catch(() => {})
  const zq = await queue('hz')
  const zh = zq.v?.history ?? []
  p.check('a job that failed without an ack, and then its dead letter, are Recently Finished, newest first, each with its kind',
    madeZ && zz.ok && setZ.ok && zh.length === 2 && zh[0].how === 'dead_letter' && zh[1].how === 'failed'
    && zh.every(r => r.mail === zjob()?.uid && r.agent === 'zz') && /halted/.test(zh[1].why ?? '') && zh[1].attempt === 1 && zh[0].attempt === 2,
    { zh, extra: zjob()?.extra })
  await haltZ(false)

  // ------------------------------------------------------------ the mail queue, round-robin
  const madeR = await project('hr', ['ra', 'rb'])
  const ra = await rig.tool('ra', 'orgtree_watchdog', { action: 'create', name: 'hr-queue', kind: 'fair_queue', target: 'hr', notice: true })
  const rb = await rig.tool('rb', 'orgtree_watchdog', { action: 'create', name: 'hr-queue', kind: 'fair_queue', target: 'hr', notice: true })
  for (const t of ['R1', 'R2', 'R3']) await rig.userMail('hr', t, { notice: true })
  const rr = await queue('hr')
  const rows = rr.v?.history ?? []
  const copyOf = text => rig.one(`SELECT uid, recipient_name, extra FROM ot.mail WHERE extra->'via_project'->>'name' = 'hr' AND body = '${text}'`)
  const c1 = copyOf('R1'), c3 = copyOf('R3')
  const r1 = rows.find(r => r.gist === 'R1'), r3 = rows.find(r => r.gist === 'R3')
  p.check('round-robin: every delivery, newest first, with its listener, job and copy; nothing is Working',
    madeR && ra.ok && rb.ok && rr.ok && rr.v?.ack === false && !(rr.v?.working ?? []).length
    && rows.map(r => r.gist).join() === 'R3,R2,R1' && r1?.agent === c1?.recipient_name && r1?.copy === c1?.uid
    && r1?.mail === c1?.extra?.via_project?.mail && r1?.dog?.name === 'hr-queue',
    { rows, c1: c1 && { uid: c1.uid, to: c1.recipient_name } })
  p.check('a listener\'s first delivery waited from its arming; its next from that delivery',
    ms(r1?.waited_from) === dogAt(r1?.agent, 'hr-queue') && r3?.agent === r1?.agent
    && Math.abs(ms(r3?.waited_from) - ms(r1?.held_at)) < 1000 && ms(r3?.waited_from) > ms(r1?.waited_from)
    && !!c3?.extra?.via_project?.waited_from,
    { r1, r3, dog: dogAt(r1?.agent, 'hr-queue') })

  // ------------------------------------------------------------ slots
  const madeS = await project('hs', ['sa'])
  const capacity = await opTry({ op: 'set_slots', node: 'hs', capacity: 1 })
  const claim = await rig.tool('sa', 'orgtree_watchdog', { action: 'create', name: 'hs-build', kind: 'slot', target: 'hs', notice: true })
  const s1 = await opTry({ op: 'slot_status', node: 'hs' })
  const holderDog = s1.v?.holders?.[0]?.dog
  p.check('a slot holder carries its claim dog (spent by the grant)',
    madeS && capacity.ok && claim.ok && holderDog?.name === 'hs-build' && holderDog?.kind === 'slot' && holderDog?.owner === 'sa'
    && holderDog?.id === 'sa/hs-build', { said: said(claim), holders: s1.v?.holders ?? s1.error })
  // the claim dog is the desk's Watchdog column: an agent's
  // `orgtree_project action=slots` keeps the output it had, with or without team
  const toolSlots = async who => (await rig.tool(who, 'orgtree_project', { action: 'slots', name: 'hs' })).json
  const t1 = await toolSlots('boss'), t1own = await toolSlots('sa')
  p.check('the agent tool\'s slots output names no claim dog for a holder',
    t1?.holders?.length === 1 && !('dog' in (t1.holders[0] ?? {})) && t1own?.holders?.length === 1 && !('dog' in (t1own.holders[0] ?? {})),
    { boss: t1?.holders ?? t1, sa: t1own?.holders ?? t1own })
  const lease = s1.v?.holders?.[0]?.lease
  const released = await rig.tool('sa', 'orgtree_project', { action: 'release_slot', lease })
  const s2 = await opTry({ op: 'slot_status', node: 'hs' })
  p.check('and so does its recent hold', released.ok && s2.v?.history?.[0]?.lease === lease && s2.v?.history?.[0]?.dog?.name === 'hs-build',
    { said: said(released), history: s2.v?.history ?? s2.error })
  const t2 = await toolSlots('boss'), t2own = await toolSlots('sa')
  p.check('nor for a recent hold',
    t2?.history?.[0]?.agent === 'sa' && !('dog' in t2.history[0]) && t2own?.history?.[0]?.agent === 'sa' && !('dog' in t2own.history[0]),
    { boss: t2?.history?.slice(0, 1) ?? t2, sa: t2own?.history?.slice(0, 1) ?? t2own })

  // ------------------------------------------------------------ the Dead Letter Line past the tree's preview
  // The tree carries eight generic dogs per owner (watchdog uncap,
  // 2026-10-20) and a dead-letter listener is a generic event dog, so the
  // engine lists a project's with its mail history
  const madeL = await project('hl', ['la'])
  let filled = 0
  for (let i = 0; i < 8; i++) {
    const f = await rig.tool('boss', 'orgtree_watchdog', { action: 'create', name: `hl-fill-${i}`, kind: 'event', target: 'project.event', pattern: 'zz-never', notice: true })
    if (f.ok) filled++
  }
  const deadDog = (who, name, target, pattern) => rig.tool(who, 'orgtree_watchdog',
    { action: 'create', name, kind: 'event', target, notice: true, ...(pattern ? { pattern } : {}) })
  const dls = [await deadDog('boss', 'hl-dead', 'project.dead_letter', '"project":"hl"'), await deadDog('boss', 'hl-elsewhere', 'project.*', '"project":"elsewhere"'),
    await deadDog('la', 'la-dead', 'project.*'), await deadDog('sa', 'sa-dead', 'project.dead_letter')]
  const paused = await rig.tool('la', 'orgtree_watchdog', { action: 'pause', id: 'la-dead' })
  const dogGroup = await rig.waitFor(async () => {
    const s = await rig.api('GET', `/api/orgs/${rig.org}/records`)
    const g = (s.records ?? []).find(r => r.entity === 'org' && r.id === 'watchdogs')?.body
    return (g?.watchdog_counts?.boss?.total ?? 0) >= 10 ? g : null
  }, { what: "boss's dogs in the tree", timeout: 10000 }).catch(() => null)
  const bossPreview = (dogGroup?.watchdogs ?? []).filter(w => w.owner === 'boss').map(w => w.id)
  p.check("boss's dead-letter dog is past the tree's eight-dog preview (the case this covers)",
    madeL && filled === 8 && dls.every(d => d.ok) && paused.ok && bossPreview.length === 8 && !bossPreview.includes('boss/hl-dead'),
    { filled, said: dls.map(said), paused: said(paused), bossPreview, counts: dogGroup?.watchdog_counts?.boss })
  const lh = await opTry({ op: 'mail_queue_history', node: 'hl' })
  const dlIds = (lh.v?.dead_letter_listeners ?? []).map(w => w.id)
  p.check("the mail history names the project's dead-letter listeners: above or below it, armed or paused, their pattern taking it, in dog order",
    lh.ok && JSON.stringify(dlIds) === '["boss/hl-dead","la/la-dead"]'
    && lh.v.dead_letter_listeners[1]?.state === 'paused' && lh.v.dead_letter_listeners[0]?.target === 'project.dead_letter',
    { dlIds, error: lh.error })
  const lh2 = await opTry({ op: 'mail_queue_history', node: 'hl', history_before: '1' })
  p.check('with the first page only', lh2.ok && !('dead_letter_listeners' in (lh2.v ?? {})), { keys: Object.keys(lh2.v ?? {}), error: lh2.error })

  // ------------------------------------------------------------ the migration's backfill
  const sqlText = fs.readFileSync(path.join(REPO, 'engine', 'rs', 'orgtree-engine', 'migrations', '0040_project_history.sql'), 'utf8')
  const backfill = sqlText.split('-- BACKFILL')[1] ?? ''
  const madeB = await project('hb2', [])
  const madeD = await project('hd', [])
  rig.exec(`INSERT INTO ot.events (org_id, at, op, actor, subject_agent_id, detail)
            VALUES (${org()}, now() - interval '1 hour', 'project_event_fire', 'boss', ${node('hb2').id},
                    '{"project":"hb2","delivered":2,"listeners":["ha","hb"],"message":"an old fire"}'::jsonb)`)
  rig.exec(`INSERT INTO ot.events (org_id, op, actor, subject_agent_id, detail)
            VALUES (${org()}, 'project_event_fire', 'boss', ${node('hb2').id}, '{"project":"hb2","listeners":"not a list"}'::jsonb)`)
  rig.exec(`INSERT INTO ot.watchdogs (uid, org_id, owner_agent_id, name, kind, target, interval_s, state, memo, created_at)
            VALUES ('old-ear', ${org()}, ${node('boss').id}, 'old-ear', 'project_listener', 'hd', 5, 'removed',
                    jsonb_build_object('target_id', ${node('hd').id}), now() - interval '2 hours')`)
  // a job of hb2 handed twice and never acked: dead-lettered after its second attempt
  const log = JSON.stringify([
    { n: 1, by: 'boss', by_id: node('boss').id, copy: 'old-copy-1', at: '2026-10-19T10:00:00Z',
      ended: { how: 'released', why: 'was halted', at: '2026-10-19T10:05:00Z' } },
    { n: 2, by: 'boss', by_id: node('boss').id, copy: 'old-copy-2', at: '2026-10-19T10:06:00Z',
      ended: { how: 'timed_out', why: 'did not ack it after 2 reminders', at: '2026-10-19T10:30:00Z' } },
  ])
  rig.exec(`INSERT INTO ot.mail (uid, org_id, sender, recipient_kind, recipient_agent_id, recipient_name, body, state, extra)
            VALUES ('old-job', ${org()}, '@user', 'agent', ${node('hb2').id}, 'hb2', 'An old job', 'read',
                    jsonb_build_object('attempts', 2, 'attempt_log', '${log}'::jsonb,
                                       'dead_letter', jsonb_build_object('by', 'boss', 'attempts', 2)))`)
  const counts = () => rig.one(`SELECT (SELECT count(*) FROM ot.project_fires) AS fires, (SELECT count(*) FROM ot.project_mail_endings) AS endings`)
  const before = counts()
  let ran = null
  try { rig.exec(backfill); ran = 'ok' } catch (e) { ran = e.message }
  const after1 = counts()
  const old = rig.sql(`SELECT kind, fired_by, message, listeners, at FROM ot.project_fires WHERE project_id = ${node('hb2').id} ORDER BY id`)
  const ends = rig.sql(`SELECT how, why, attempt, agent_name, copy_uid, held_at, ended_at FROM ot.project_mail_endings
                         WHERE project_id = ${node('hb2').id} ORDER BY id`)
  try { rig.exec(backfill) } catch (e) { ran = e.message }
  const after2 = counts()
  p.check('the backfill copies earlier fires from ot.events (message, firer, listener names) and only those',
    madeB && madeD && backfill.length > 0 && ran === 'ok' && Number(after1.fires) === Number(before.fires) + 2 && old.length === 2
    && old[0].kind === 'event' && old[0].fired_by === 'boss' && old[0].message === 'an old fire'
    && JSON.stringify((old[0].listeners ?? []).map(l => l.agent)) === '["ha","hb"]'
    && JSON.stringify(old[1].listeners) === '[]',
    { ran, before, after1, old })
  p.check('it copies the endings a job\'s log shows (a failed attempt, then its dead letter) and only those',
    Number(after1.endings) === Number(before.endings) + 2 && ends.length === 2
    && ends[0].how === 'failed' && ends[0].why === 'was halted' && ends[0].attempt === 1 && ends[0].copy_uid === 'old-copy-1'
    && ends[1].how === 'dead_letter' && ends[1].attempt === 2 && /reminders/.test(ends[1].why ?? ''),
    { before, after1, ends })
  p.check('it marks a project whose only listener is long removed, and a second run adds nothing',
    !!node('hd').extra?.listeners_seen_at && after2.fires === after1.fires && after2.endings === after1.endings,
    { extra: node('hd').extra, after1, after2 })

  p.file('fires.json', rig.sql(`SELECT f.id, a.name AS project, f.kind, f.fired_by, left(f.message, 80) AS message, f.watch, f.listeners, f.at
                                  FROM ot.project_fires f JOIN ot.agents a ON a.id = f.project_id ORDER BY f.id`))
  p.file('queue.json', rig.sql(`SELECT uid, recipient_name, body, extra FROM ot.mail
                                  WHERE extra ? 'via_project' OR extra ? 'ack_of' OR extra ? 'claimed' ORDER BY id`))
  p.keep(rig, { agents: ['ha', 'hb', 'qa', 'qb', 'ra', 'rb', 'sa', 'boss'], grep: /listener|project|fair_queue|slot/i })
  return p.summary()
}
