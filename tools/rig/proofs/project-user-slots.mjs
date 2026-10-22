// Proof: the USER holds a project's concurrency slots themselves (docket
// let-the-user-manually-hold-a-number-of-a-project; user 2026-10-20 13:03Z
// "allow the user to manually hold a number of slots themselves", 13:22Z
// "B, and yes to all three": whole FIFO grants, holds that last until
// released), through the real engine and the user's ops.
//   user_slot_hold asks for N slots: granted at once when free, otherwise it
//   waits in the SAME first-come line as the agents' claims and is granted
//   whole; the user's hold counts against the capacity like an agent's lease
//   an agent sees it, named "user", in status (holders, line, history)
//   only the user ends it: an agent, a project ancestor with force included,
//   is refused; the user releases it (not "forced") or cancels a waiting request
//   cancelling a blocking head grants the claims behind it
//   a hold and a waiting request survive an engine restart, never reclaimed
//   refusals: no slots, a count past the capacity, over-asking, a long reason
// Run: node tools/rig/rig.mjs run tools/rig/proofs/project-user-slots.mjs

import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true }
}

export default async function (rig) {
  const p = new Proof('project-user-slots')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const settle = what => rig.waitFor(() => rig.sql(`SELECT 1 FROM ot.turns WHERE ended_at IS NULL`).length === 0,
    { what, timeout: 60000 }).catch(() => {})
  await settle('seed turns to settle')
  const said = r => (r?.ok ? JSON.stringify(r.json ?? r.text) : String(r?.text)).slice(0, 300)
  const opTry = body => rig.op(body).then(v => ({ ok: true, v }), e => ({ ok: false, error: e.message }))
  const node = name => rig.one(`SELECT id, name, scope, state, halt FROM ot.agents
                                  WHERE org_id = (SELECT id FROM ot.orgs WHERE slug = '${rig.org}' AND state = 'active') AND name = '${name}'`)
  // a red run (no user ops, no 0046 columns) must fail the checks, not the script
  const safe = (fn, dflt) => { try { return fn() } catch { return dflt } }
  const leases = () => safe(() => rig.sql(`SELECT l.uid, coalesce(a.name, 'user') AS holder, l.holder_kind, l.holder_agent_id, l.slot_count,
                                  l.ended_at, l.end_reason, l.ended_by, l.dog_id FROM ot.slot_leases l
                                  LEFT JOIN ot.agents a ON a.id = l.holder_agent_id WHERE l.project_id = ${node('build').id} ORDER BY l.id`), [])
  const active = () => leases().filter(l => !l.ended_at)
  const holding = () => active().map(l => l.holder).sort()
  const userLeases = () => leases().filter(l => l.holder === 'user')
  const userActive = () => active().filter(l => l.holder === 'user')
  // lease ids come from the table: a member without the team tools sees only its own in status
  const leaseOf = who => active().find(l => l.holder === who)?.uid
  const dogs = () => safe(() => rig.sql(`SELECT uid, state, spent_at, owner_kind, owner_agent_id, memo FROM ot.watchdogs
                                  WHERE kind = 'slot' AND owner_kind = 'user' ORDER BY id`), [])
  const claim = (who, name, slots) => rig.tool(who, 'orgtree_watchdog', { action: 'create', name, kind: 'slot', target: 'build', ...(slots ? { slots } : {}) })
  const status = async (who = 'boss') => (await rig.tool(who, 'orgtree_project', { action: 'slots', name: 'build' })).json ?? {}
  const lineOf = s => (s.line ?? []).map(w => w.agent)
  const holdersOf = s => (s.holders ?? []).map(h => h.agent).sort()
  const settleHold = (want, what) => rig.waitFor(() => JSON.stringify(holding()) === JSON.stringify(want), { what, timeout: 20000 }).catch(() => {})

  // ------------------------------------------------------------ a project with two slots
  const made = await opTry({ op: 'create_project', name: 'build', parent: 'boss', description: 'The build machine.' })
  const hires = []
  for (const n of ['sa', 'sb', 'sc']) hires.push(await opTry({ op: 'hire', name: n, parent: 'build', tier: 'haiku', grant: 0, title: `Builder ${n}` }))
  await settle('hire turns')
  const idle = await opTry({ op: 'create_project', name: 'idle', parent: 'boss', description: 'No slots.' })
  const two = await opTry({ op: 'set_slots', node: 'build', capacity: 2 })
  p.check('a project with two slots, three builders and a project with none', made.ok && idle.ok && hires.every(h => h.ok) && two.ok
    && node('build')?.scope?.slots_capacity === 2, { made: made.ok, two: two.ok })

  // ------------------------------------------------------------ the user holds one slot
  const h1 = await opTry({ op: 'user_slot_hold', node: 'build', slots: 1, reason: 'signing run' })
  await settleHold(['user'], 'the user hold granted')
  const l1 = userActive()[0]
  p.check('a user hold with a slot free is granted at once, as a lease with no agent holder', h1.ok && holding().join() === 'user'
    && l1?.holder_kind === 'user' && l1?.holder_agent_id === null && l1?.slot_count === 1, { h1: h1.ok ? h1.v : h1.error, leases: leases() })
  const d1 = dogs().find(d => d.uid === h1.v?.dog)
  p.check('the user\'s request dog is spent by its grant (no mail, nobody to wake)', d1?.state === 'spent' && !!d1?.spent_at && d1?.owner_kind === 'user'
    && d1?.owner_agent_id === null, dogs())
  const s1 = await status('boss')
  p.check('status shows the hold, named "user", with its reason', holdersOf(s1).join() === 'user' && s1.held === 1
    && (s1.holders ?? [])[0]?.reason === 'signing run' && (s1.holders ?? [])[0]?.slots === 1, said({ ok: true, json: s1 }))

  // ------------------------------------------------------------ it counts against the capacity, in the same line
  const ca = await claim('sa', 'build-a')
  const cb = await claim('sb', 'build-b')
  await settleHold(['sa', 'user'], 'sa granted beside the user')
  const s2 = await status('sa')
  p.check('the user\'s hold counts against the capacity: an agent takes the second slot and the next waits (an agent sees it too)',
    ca.ok && ca.json?.resolved === true && ca.json?.registered === false && ca.json?.slots === 1
    && typeof ca.json?.lease === 'string' && ca.json.lease === leaseOf('sa')
    && ca.json?.fire?.events?.length === 1 && ca.json.fire.events[0].includes(ca.json.lease)
    && cb.ok && /1st in line/.test(cb.text) && holdersOf(s2).join() === 'sa,user' && s2.held === 2
    && lineOf(s2).join() === 'sb', { ca: said(ca), cb: said(cb), s2 })
  const h2 = await opTry({ op: 'user_slot_hold', node: 'build', slots: 1, reason: 'then a second pass' })
  const s3 = await status('boss')
  p.check('the user\'s request waits in the SAME first-come line, behind the agent that came first', h2.ok
    && lineOf(s3).join() === 'sb,user' && (s3.line ?? []).map(w => w.position).join() === '1,2', s3.line)
  const beforeOver = { leases: leases(), dogs: dogs() }
  const over = await opTry({ op: 'user_slot_hold', node: 'build', slots: 2 })
  const afterOver = { leases: leases(), dogs: dogs() }
  p.check('the user\'s holds and waits together stay within the slot count', !over.ok
    && /409: requested 2 slots but only 0 remain.*\(1 held, 1 pending, capacity 2\)/.test(over.error ?? '')
    && JSON.stringify(beforeOver) === JSON.stringify(afterOver), { over, beforeOver, afterOver })

  // ------------------------------------------------------------ only the user ends it
  const lease1 = userActive()[0]?.uid
  const forceBoss = await rig.tool('boss', 'orgtree_project', { action: 'release_slot', lease: lease1, force: true })
  const releaseSa = await rig.tool('sa', 'orgtree_project', { action: 'release_slot', lease: lease1 })
  const unq = await rig.tool('boss', 'orgtree_project', { action: 'unqueue_slot', name: 'build', agent: 'user' })
  p.check('an agent cannot end the user\'s hold or request: a project ancestor with force, the holder\'s peers, the line removal',
    !forceBoss.ok && /user's own hold/.test(forceBoss.text) && !releaseSa.ok && !unq.ok && /only the user/.test(unq.text)
    && userActive().length === 1 && dogs().filter(d => d.state === 'armed').length === 1,
    { forceBoss: said(forceBoss), releaseSa: said(releaseSa), unq: said(unq) })

  // ------------------------------------------------------------ FIFO: the agent ahead is granted first; then the user's wait
  const relA = await rig.tool('sa', 'orgtree_project', { action: 'release_slot', lease: leaseOf('sa'), note: 'a done' })
  await settleHold(['sb', 'user'], 'sb granted ahead of the user\'s request')
  p.check('first come first served: the agent ahead of the user\'s waiting request is granted first', relA.ok
    && JSON.stringify(holding()) === JSON.stringify(['sb', 'user']) && lineOf(await status('boss')).join() === 'user', leases())
  const rel1 = await opTry({ op: 'slot_release', lease: lease1, note: 'signing done' })
  await rig.waitFor(() => userLeases().length === 2, { what: 'the waiting request granted', timeout: 20000 }).catch(() => {})
  const first = userLeases().find(l => l.uid === lease1)
  p.check('the user releases their own hold (plainly released, not forced) and their waiting request is granted whole', rel1.ok
    && first?.end_reason === 'released' && first?.ended_by === '@user' && userActive().length === 1 && holding().join() === 'sb,user',
    { rel1: rel1.ok ? rel1.v : rel1.error, leases: leases() })
  const hist = (await status('sa')).history ?? []
  p.check('the ended hold is in the project history, named "user", and an agent reads it', hist.some(h => h.agent === 'user' && h.how === 'released' && h.by === '@user'), hist)

  // ------------------------------------------------------------ whole grants are strict FIFO
  const relB = await rig.tool('sb', 'orgtree_project', { action: 'release_slot', lease: leaseOf('sb') })
  const relU = await opTry({ op: 'slot_release', lease: userActive()[0]?.uid })
  await settleHold([], 'every slot free')
  await claim('sa', 'build-a2')
  await settleHold(['sa'], 'sa holds one slot')
  const h3 = await opTry({ op: 'user_slot_hold', node: 'build', slots: 2, reason: 'whole machine' })
  const cc = await claim('sc', 'build-c')
  const s4 = await status('boss')
  p.check('a user hold of both slots waits whole, and a smaller claim never jumps the head although a slot is free', relB.ok && relU.ok && h3.ok
    && lineOf(s4).join() === 'user,sc' && holdersOf(s4).join() === 'sa' && /2nd in line/.test(cc.text) && s4.held === 1, { s4, cc: said(cc) })
  const cancel = await opTry({ op: 'user_slot_cancel', node: 'build', dog: h3.v?.dog })
  await settleHold(['sa', 'sc'], 'sc granted when the blocking head is cancelled')
  p.check('cancelling the blocking head removes it and grants the claim behind it at once', cancel.ok && holding().join() === 'sa,sc'
    && dogs().find(d => d.uid === h3.v?.dog)?.state === 'removed', { cancel: cancel.ok ? cancel.v : cancel.error, leases: active() })
  const stale = await opTry({ op: 'user_slot_cancel', node: 'build', dog: h3.v?.dog })
  p.check('a request already cancelled cannot be cancelled again', !stale.ok && /no waiting slot request/.test(stale.error ?? ''), stale)

  // ------------------------------------------------------------ restart: the hold lasts, nothing is reclaimed
  for (const l of active()) await rig.tool('boss', 'orgtree_project', { action: 'release_slot', lease: l.uid, force: true })
  await settleHold([], 'every slot free again')
  const hAll = await opTry({ op: 'user_slot_hold', node: 'build', slots: 2, reason: 'across a restart' })
  await settleHold(['user'], 'the user holds both slots')
  await claim('sb', 'build-b2')
  const before = userActive()[0]
  await rig.restart()
  await settle('after restart')
  const after = userActive()[0]
  const sr = await status('boss')
  p.check('a user hold and the line behind it survive an engine restart; nothing reclaims the hold', hAll.ok && before?.uid && after?.uid === before.uid
    && after.slot_count === 2 && !after.ended_at && holdersOf(sr).join() === 'user' && lineOf(sr).join() === 'sb', { before, after, sr })
  const relAll = await opTry({ op: 'slot_release', lease: after?.uid })
  await settleHold(['sb'], 'sb granted when the user releases')
  p.check('releasing after the restart grants the next in line', relAll.ok && holding().join() === 'sb', leases())

  // ------------------------------------------------------------ refusals
  const noSlots = await opTry({ op: 'user_slot_hold', node: 'idle', slots: 1 })
  const tooMany = await opTry({ op: 'user_slot_hold', node: 'build', slots: 3 })
  const zero = await opTry({ op: 'user_slot_hold', node: 'build', slots: 0 })
  const onAgent = await opTry({ op: 'user_slot_hold', node: 'sa', slots: 1 })
  const longWhy = await opTry({ op: 'user_slot_hold', node: 'build', slots: 1, reason: 'x'.repeat(201) })
  p.check('refused: a project with no slots, more than its count, none, an agent, a long reason', !noSlots.ok && /no concurrency slots/.test(noSlots.error ?? '')
    && !tooMany.ok && /exceeds/.test(tooMany.error ?? '') && !zero.ok && !onAgent.ok && /agent/.test(onAgent.error ?? '')
    && !longWhy.ok && /200 characters/.test(longWhy.error ?? ''), { noSlots, tooMany, zero, onAgent, longWhy })

  await settle('the last turns')
  p.file('leases.json', leases())
  p.file('user-dogs.json', dogs())
  p.keep(rig, { agents: ['sa', 'sb', 'sc', 'boss'], grep: /slot|lease/i })
  return p.summary()
}
