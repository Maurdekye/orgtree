// Proof: project slots (docket project-slots-first-come-permits-claimed-through;
// user 2026-10-18 08:37Z-08:40Z), through the real engine.
//   set_slots gives a project its slot count (0, the default, is no slots)
//   a one-shot `slot` watchdog claims: with a slot free it is granted at once
//   (the create result names the slot and lease, and the dog fires); with
//   none free the armed dog is the agent's place in a first-come line
//   only agents above or below the project may claim; one claim per agent
//   pausing a claim leaves the line, resuming rejoins at the back
//   orgtree_project action=release_slot releases, and the next in line is
//   granted at once; the user can force-release; status lists holders and line
//   a halted or retired holder loses its slot; leases and the line survive an
//   engine restart; a capacity raise grants the waiting at once
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-slots.mjs

import { SEED_SETTLE_TIMEOUT } from '../seed-settle.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-slots')
  let phase = 'setup'
  try {
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = (what, timeout = 60000) => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout })
  await settle('seed turns to settle', SEED_SETTLE_TIMEOUT)
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 300)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, scope, state, halt FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  const leases = () => rig.sql(`SELECT l.uid, a.name AS holder, l.slot_no, l.ended_at, l.end_reason FROM ot.slot_leases l
                                  JOIN ot.agents a ON a.id = l.holder_agent_id WHERE l.project_id = ${node('build').id} ORDER BY l.id`)
  const holding = () => leases().filter(l => !l.ended_at).map(l => l.holder).sort()
  const leaseOf = who => leases().find(l => l.holder === who && !l.ended_at)
  const claim = (who, name = 'build-slot') => rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'slot', target: 'build' })
  const granted = who => rig.sql(`SELECT body FROM ot.mail WHERE recipient_agent_id = ${node(who).id} AND body LIKE '%You now hold a concurrency slot%' ORDER BY id`)

  // ------------------------------------------------------------ a project with slots
  const made = await opTry({ op: 'create_project', name: 'build', parent: 'boss', description: 'The build machine.' })
  const hires = []
  for (const n of ['sa', 'sb', 'sc']) hires.push(await opTry({ op: 'hire', name: n, parent: 'build', tier: 'haiku', grant: 0, title: `Builder ${n}` }))
  await settle('hire turns')
  const off = await claim('sa', 'too-early')
  p.check('a project has no slots until its count is set (user 08:42Z: 0 is off)', !off.ok && /no concurrency slots/.test(off.text), said(off))
  const on = await opTry({ op: 'set_slots', node: 'build', capacity: 1 })
  p.check('set_slots gives a project its slot count', made.ok && hires.every(h => h.ok) && on.ok
    && node('build').scope?.slots_capacity === 1, on.ok ? on.v : on.error)

  // ------------------------------------------------------------ claim and the line
  phase = 'inline and queued grants'
  const activity = who => rig.one(`SELECT
    (SELECT count(*) FROM ot.watchdogs WHERE owner_agent_id=${node(who).id}) AS dogs,
    (SELECT count(*) FROM ot.mail WHERE recipient_agent_id=${node(who).id}) AS mails,
    (SELECT count(*) FROM ot.turns WHERE agent_id=${node(who).id}) AS turns`)
  const beforeInline = activity('sa')
  const ca = await claim('sa')
  await settle('inline did not wake sa')
  const afterInline = activity('sa')
  p.check('a claim with a slot free is granted at once, and says so', ca.ok && ca.json?.resolved === true && ca.json?.registered === false
    && ca.json?.slots === 1 && typeof ca.json?.lease === 'string' && ca.json.lease === leaseOf('sa')?.uid
    && ca.json?.fire?.events?.length === 1 && ca.json.fire.events[0].includes(ca.json.lease)
    && JSON.stringify(beforeInline) === JSON.stringify(afterInline)
    && JSON.stringify(holding()) === JSON.stringify(['sa']), { result: ca.json, holding: holding(), beforeInline, afterInline })
  // Force a registered claim without changing the later FIFO scenario. Ready
  // one-shots have no dog/mail/wake (USER 2026-10-21 18:05:58Z).
  const queuedGrant = await claim('boss', 'queued-grant')
  const firstRelease = await rig.tool('sa', 'orgtree_project', { action: 'release_slot', lease: ca.json?.lease })
  await rig.waitFor(() => granted('boss').length === 1, { what: 'queued boss grant mail', timeout: 20000 })
  const bossLease = leaseOf('boss')?.uid
  const bossMail = granted('boss')
  const bossDog = rig.one(`SELECT state,fired FROM ot.watchdogs WHERE name='queued-grant' AND owner_agent_id=${node('boss').id}`)
  const bossRelease = await rig.tool('boss', 'orgtree_project', { action: 'release_slot', lease: bossLease })
  const restoredSa = await claim('sa')
  await settle('registered grant completed')
  p.check('the slot dog fires with the grant', queuedGrant.ok && firstRelease.ok && bossDog?.state === 'spent' && bossDog.fired === 1
    && bossMail.length === 1 && typeof bossLease === 'string' && bossMail[0].body.includes(bossLease) && /release_slot/.test(bossMail[0].body)
    && granted('boss').length === 1 && granted('sa').length === 0 && bossRelease.ok && restoredSa.ok && holding().join() === 'sa',
    { bossMail, bossDog, bossLease, restored: restoredSa.json })
  const cb = await claim('sb')
  const cc = await claim('sc')
  p.check('with no slot free the dog is the agent\'s place in a first-come line', cb.ok && /1st in line/.test(cb.text)
    && cc.ok && /2nd in line/.test(cc.text), { sb: said(cb), sc: said(cc) })
  const outsider = await claim('carol')
  p.check('only agents above or below the project may claim', !outsider.ok && /above or below/.test(outsider.text), said(outsider))
  const beforeRefusal = { activity: activity('sa'), leases: leases(), sb: activity('sb') }
  const again = await claim('sa', 'build-slot-2')
  const pendingAgain = await claim('sb', 'pending-again')
  const afterRefusal = { activity: activity('sa'), leases: leases(), sb: activity('sb') }
  p.check('one claim per agent', !again.ok && /requested 1 slots but only 0 remain.*1 held, 0 pending, capacity 1/.test(again.text)
    && !pendingAgain.ok && /already have.*one armed or paused claim per agent/.test(pendingAgain.text)
    && JSON.stringify(beforeRefusal) === JSON.stringify(afterRefusal), { held: said(again), pending: said(pendingAgain), beforeRefusal, afterRefusal })

  // pausing leaves the line; resuming rejoins at the back
  await rig.tool('sb', 'orgtree_watchdog', { action: 'pause', id: 'build-slot' })
  await rig.tool('sb', 'orgtree_watchdog', { action: 'resume', id: 'build-slot' })
  const status = await rig.tool('boss', 'orgtree_project', { action: 'slots', name: 'build' })
  const line = (status.json?.line ?? []).map(w => w.agent)
  p.check('pausing leaves the line and resuming rejoins at the back', status.ok && JSON.stringify(line) === JSON.stringify(['sc', 'sb'])
    && (status.json?.holders ?? []).map(h => h.agent).join() === 'sa', said(status))

  // ------------------------------------------------------------ release and force-release
  phase = 'release and force-release'
  const rel = await rig.tool('sa', 'orgtree_project', { action: 'release_slot', lease: leaseOf('sa')?.uid, note: 'build ok' })
  await rig.waitFor(() => granted('sc').length === 1, { what: 'sc granted', timeout: 20000 })
  p.check('release grants the next in line at once', rel.ok && JSON.stringify(holding()) === JSON.stringify(['sc'])
    && granted('sc').length === 1 && leases().find(l => l.holder === 'sa')?.end_reason === 'released', { said: said(rel), leases: leases() })
  const notMine = await rig.tool('sb', 'orgtree_project', { action: 'release_slot', lease: leaseOf('sc')?.uid })
  p.check('only the holder releases its own slot', !notMine.ok, said(notMine))
  const force = await opTry({ op: 'slot_release', lease: leaseOf('sc')?.uid, force: true })
  await rig.waitFor(() => granted('sb').length === 1, { what: 'sb granted', timeout: 20000 })
  p.check('the user can force-release; the next in line is granted', force.ok && JSON.stringify(holding()) === JSON.stringify(['sb'])
    && /forced/.test(leases().find(l => l.holder === 'sc')?.end_reason ?? ''), { force: force.ok ? force.v : force.error, leases: leases() })

  // ------------------------------------------------------------ restart, halt, capacity, retire
  phase = 'restart, halt, capacity and retirement'
  await claim('sa', 'build-slot-3')
  await rig.restart()
  await settle('after restart')
  p.check('leases and the line survive an engine restart', JSON.stringify(holding()) === JSON.stringify(['sb'])
    && rig.sql(`SELECT 1 FROM ot.watchdogs WHERE kind = 'slot' AND state = 'armed' AND owner_agent_id = ${node('sa').id}`).length === 1,
    { holding: holding() })
  await opTry({ op: 'halt', nodes: ['sb'] })
  await rig.waitFor(() => leases().find(l => l.holder === 'sb')?.ended_at, { what: 'sb\'s lease to end', timeout: 20000 })
  await rig.waitFor(() => holding().includes('sa'), { what: 'sa granted again', timeout: 20000 })
  p.check('a halted holder loses its slot, and the next in line gets it', leases().find(l => l.holder === 'sb')?.end_reason === 'halted'
    && JSON.stringify(holding()) === JSON.stringify(['sa']), leases())
  await claim('sc', 'build-slot-4')
  const two = await opTry({ op: 'set_slots', node: 'build', capacity: 2 })
  await rig.waitFor(() => holding().length === 2, { what: 'the second slot granted', timeout: 20000 })
  p.check('raising the capacity grants the waiting at once', two.ok && JSON.stringify(holding()) === JSON.stringify(['sa', 'sc']), leases())
  const ret = await opTry({ op: 'retire', node: 'sc' })
  await rig.waitFor(() => leases().filter(l => l.holder === 'sc').every(l => l.ended_at), { what: 'sc\'s lease to end', timeout: 20000 })
  p.check('a retired holder loses its slot', ret.ok && leases().filter(l => l.holder === 'sc').every(l => l.ended_at)
    && leases().filter(l => l.holder === 'sc').some(l => l.end_reason === 'retired'), leases())
  await opTry({ op: 'unhalt', nodes: ['sb'] })
  await settle('the last turns')

  // queue time is recorded on the lease and shown in status (user 2026-10-19)
  const qrows = rig.sql(`SELECT queued_at, granted_at FROM ot.slot_leases WHERE queued_at IS NOT NULL`)
  const qstatus = await rig.tool('boss', 'orgtree_project', { action: 'slots', name: 'build' })
  p.check('each lease records when its claim queued, and status history carries it',
    leases().length > 0 && qrows.length === leases().length
    && qrows.every(r => Date.parse(r.queued_at) <= Date.parse(r.granted_at))
    && qrows.some(r => Date.parse(r.queued_at) < Date.parse(r.granted_at))
    && (qstatus.json?.history ?? []).every(h => 'queued' in h),
    { qrows, history: qstatus.json?.history })
  p.file('leases.json', leases())
  p.keep(rig, { agents: ['sa', 'sb', 'sc', 'boss'], grep: /slot|lease/i })
  return p.summary()
  } catch (error) {
    p.check(`project-slots failed during ${phase}`, false, { error: error.message, stack: error.stack })
    return p.summary()
  }
}
