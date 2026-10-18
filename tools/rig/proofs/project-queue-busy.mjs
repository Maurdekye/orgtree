// Proof: the ACK work queue tells the truth when its listeners are busy, keeps
// one held job per listener AGENT, refuses a duplicate listener, and reminds a
// listener at once when it ends a turn still holding a job (docket
// ack-work-queue-honest-all-listeners-busy-reply-a; live smoke test and user
// 2026-10-18 18:00Z-18:06Z), through the real engine.
//   a post when every listener holds an un-acked job says so, with its place
//   in line, in the sender's reply (agent sender and user sender alike);
//   with nobody watching the old "no agent watches" text stays, and a project
//   whose only listener is paused says that instead
//   an agent holds at most ONE un-acked job even with two fair_queue dogs on
//   the project (a legacy duplicate is injected by SQL; the tool refuses it)
//   creating a second fair_queue dog on a project the agent already watches
//   is refused, naming the existing dog
//   a listener whose turn ends holding an un-acked job is reminded at once,
//   once per held job, unless the project's setting is off
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-queue-busy.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-queue-busy')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 400)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, kind, scope, state, halt FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const mailTo = id => rig.sql(`SELECT id, uid, sender, state, notice, body, extra FROM ot.mail WHERE recipient_agent_id = ${id} ORDER BY id`)
  const copies = (who, project) => mailTo(node(who).id).filter(m => m.extra?.via_project?.name === project)
  const reminders = (who, project) => mailTo(node(who).id).filter(m => m.sender !== '@user' && !m.extra?.via_project
    && /still hold/i.test(m.body) && m.body.includes(project))
  const post = (project, text) => rig.tool('boss', 'orgtree_message', { metadata: { to: project }, body: text })
  const userPost = text => rig.userMail('aq', text, { notice: true }).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))

  // ------------------------------------------------------------ project aq: two listeners, ack mode
  const made = await opTry({ op: 'create_project', name: 'aq', parent: 'boss', description: 'An ack queue.' })
  const ha = await opTry({ op: 'hire', name: 'ea', parent: 'aq', tier: 'haiku', grant: 0, title: 'Worker A' })
  const hb = await opTry({ op: 'hire', name: 'eb', parent: 'aq', tier: 'haiku', grant: 0, title: 'Worker B' })
  await settle('hire turns')
  const da = await rig.tool('ea', 'orgtree_watchdog', { action: 'create', name: 'aq-queue', kind: 'fair_queue', target: 'aq' })
  const db = await rig.tool('eb', 'orgtree_watchdog', { action: 'create', name: 'aq-queue', kind: 'fair_queue', target: 'aq' })
  const set = await opTry({ op: 'set_mail_queue', node: 'aq', mode: 'ack' })
  p.check('project aq with listeners ea and eb in ack mode', made.ok && ha.ok && hb.ok && da.ok && db.ok && set.ok,
    { made: made.ok || made.error, ea: ha.ok || ha.error, eb: hb.ok || hb.error, dogs: [said(da), said(db)], set: set.ok || set.error })

  // ------------------------------------------------------------ the turn-end reminder (item 4)
  const settings = await rig.tool('boss', 'orgtree_project', { action: 'settings', name: 'aq' })
  p.check('the project setting "remind on turn end" is on by default and listed with the other queue settings',
    settings.ok && JSON.stringify(settings.json ?? settings.text).includes('turn_end_reminder')
    && (settings.json?.settings?.turn_end_reminder ?? true) === true, said(settings))
  const j1 = await post('aq', 'Job 1')
  await settle('listener turns for Job 1')
  const holder1 = copies('ea', 'aq').length ? 'ea' : 'eb'
  await rig.waitFor(() => reminders(holder1, 'aq').length >= 1, { what: 'the immediate reminder', timeout: 30000 }).catch(() => {})
  await settle('the reminder turn')
  const r1 = reminders(holder1, 'aq')
  p.check('a listener that ends its turn still holding an un-acked job is reminded at once, naming the job',
    j1.ok && r1.length === 1 && /Job 1/.test(r1[0].body) && /ack/i.test(r1[0].body) && /blocked/i.test(r1[0].body),
    { holder: holder1, reminders: r1.map(m => m.body) })
  p.check('the reminder fires once per held job (the reminder turn ending holding it does not remind again)',
    reminders(holder1, 'aq').length === 1, reminders(holder1, 'aq').map(m => m.body))

  // ------------------------------------------------------------ every listener busy: the honest reply
  const j2 = await post('aq', 'Job 2')
  await settle('listener turns for Job 2')
  const held = () => ({ ea: copies('ea', 'aq').length, eb: copies('eb', 'aq').length })
  p.check('each listener now holds one job', held().ea === 1 && held().eb === 1, held())
  const j3 = await post('aq', 'Job 3')
  const j4 = await post('aq', 'Job 4')
  const t3 = j3.text ?? '', t4 = j4.text ?? ''
  p.check('a post when every listener holds an un-acked job says so, and does not claim nobody watches',
    j3.ok && !/No agent watches/i.test(t3) && /2 listeners/.test(t3) && /un-acked/.test(t3) && /position 1\b/.test(t3), t3)
  p.check('the next post is told its place in line', j4.ok && /position 2\b/.test(t4) && !/No agent watches/i.test(t4), t4)
  const u5 = await userPost('Job 5')
  const tu = u5.ok ? JSON.stringify(u5.v) : u5.error
  p.check('the user\'s post gets the same honest wording', u5.ok && /2 listeners/.test(tu) && /un-acked/.test(tu) && /position 3\b/.test(tu)
    && !/No agent watches/i.test(tu), tu)
  const inbox = await rig.tool('boss', 'orgtree_inbox', { action: 'list', project: 'aq' })
  p.check('orgtree_inbox project output carries the same queue wording', inbox.ok && /un-acked/.test(JSON.stringify(inbox.json ?? inbox.text))
    && /2 listeners/.test(JSON.stringify(inbox.json ?? inbox.text)), said(inbox))

  // ------------------------------------------------------------ one held job per AGENT, a duplicate dog refused
  const dup = await rig.tool('ea', 'orgtree_watchdog', { action: 'create', name: 'aq-queue-2', kind: 'fair_queue', target: 'aq' })
  p.check('a second fair_queue dog on the same project is refused, naming the one the agent already has',
    !dup.ok && /already/i.test(dup.text ?? '') && /aq-queue/.test(dup.text ?? ''), said(dup))
  // a legacy duplicate (made before the guard) still must not hold two jobs
  const cols = rig.sql(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'ot' AND table_name = 'watchdogs'
                         AND column_name NOT IN ('id', 'uid', 'name') AND is_generated = 'NEVER' AND column_default IS NULL
                         OR (table_schema = 'ot' AND table_name = 'watchdogs' AND column_name NOT IN ('id', 'uid', 'name')
                             AND is_generated = 'NEVER' AND column_default IS NOT NULL)`).map(r => `"${r.column_name}"`).join(', ')
  let injected = true
  try {
    rig.exec(`INSERT INTO ot.watchdogs (uid, name, ${cols})
              SELECT 'aq-queue-dup', 'aq-queue-dup', ${cols} FROM ot.watchdogs
               WHERE kind = 'fair_queue' AND owner_agent_id = ${node('ea').id} AND state = 'armed' LIMIT 1`)
  } catch (e) { injected = String(e.message).slice(0, 300) }
  const dogsOfEa = rig.sql(`SELECT uid FROM ot.watchdogs WHERE kind = 'fair_queue' AND state = 'armed' AND owner_agent_id = ${node('ea').id}`)
  const outstanding = who => copies(who, 'aq').filter(m => {
    const orig = rig.one(`SELECT extra FROM ot.mail WHERE uid = '${m.extra.via_project.mail}'`)
    return orig?.extra?.claimed?.acked_at == null && orig?.extra?.claimed?.copy === m.uid
  })
  p.check('the legacy duplicate dog is in place (positive control)', injected === true && dogsOfEa.length === 2, { injected, dogsOfEa })
  const first = outstanding('ea')[0]
  const acked = first && await rig.tool('ea', 'orgtree_message', { metadata: { to: 'aq', reply_to: first.uid }, body: 'Done.' })
  await settle('the hand-out after the ack')
  p.check('with two dogs on the project an agent still holds at most one un-acked job',
    acked?.ok && outstanding('ea').length === 1, { acked: acked && said(acked), ea: outstanding('ea').map(m => m.body) })

  // ------------------------------------------------------------ no listener / paused listener / the setting off
  const lone = await opTry({ op: 'create_project', name: 'lone', parent: 'boss', description: 'Nobody listens.' })
  const t0 = await post('lone', 'Anyone?')
  p.check('with nobody watching, the old text stays', lone.ok && /No agent watches/i.test(t0.text ?? ''), t0.text)
  const pz = await opTry({ op: 'create_project', name: 'pz', parent: 'boss', description: 'A paused listener.' })
  const hz = await opTry({ op: 'hire', name: 'ez', parent: 'pz', tier: 'haiku', grant: 0, title: 'Worker Z' })
  await settle('ez hired')
  const dz = await rig.tool('ez', 'orgtree_watchdog', { action: 'create', name: 'pz-queue', kind: 'fair_queue', target: 'pz' })
  const pausedDog = await rig.tool('ez', 'orgtree_watchdog', { action: 'pause', id: 'pz-queue' })
  const tp = await post('pz', 'Is anyone there?')
  p.check('a project whose only listener is paused says so, not that nobody watches',
    pz.ok && hz.ok && dz.ok && pausedDog.ok && /paused/i.test(tp.text ?? '') && !/No agent watches/i.test(tp.text ?? ''), tp.text)
  const nr = await opTry({ op: 'create_project', name: 'nr', parent: 'boss', description: 'No immediate reminder.' })
  const hn = await opTry({ op: 'hire', name: 'en', parent: 'nr', tier: 'haiku', grant: 0, title: 'Worker N' })
  await settle('en hired')
  const dn = await rig.tool('en', 'orgtree_watchdog', { action: 'create', name: 'nr-queue', kind: 'fair_queue', target: 'nr' })
  const off = await opTry({ op: 'set_mail_queue', node: 'nr', mode: 'ack', turn_end_reminder: false })
  const readBack = await rig.tool('boss', 'orgtree_project', { action: 'settings', name: 'nr' })
  await post('nr', 'Quiet job')
  await settle('en turn')
  await new Promise(r => setTimeout(r, 8000))
  p.check('with the setting off there is no immediate reminder, and the setting reads back off',
    nr.ok && hn.ok && dn.ok && off.ok && copies('en', 'nr').length === 1 && reminders('en', 'nr').length === 0
    && (readBack.json?.settings?.turn_end_reminder === false), { off: off.ok ? off.v : off.error, read: said(readBack), reminders: reminders('en', 'nr').length })

  await settle('the last turns')
  p.file('mail.json', rig.sql(`SELECT uid, sender, recipient_name, state, notice, body, extra FROM ot.mail ORDER BY id`))
  p.keep(rig, { agents: ['ea', 'eb', 'boss'], grep: /project|fair_queue|dispatch|ack|remind/i })
  return p.summary()
}
