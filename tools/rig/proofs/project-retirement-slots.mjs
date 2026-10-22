// Focused lifecycle regression: slot release, waiting claims, FIFO and history.
import { Proof } from '../proof.mjs'

export async function setup() {
  return { recover: true, fixture: { org: { name: 'Retirement slots' }, agents: [{ name: 'boss', tier: 'sol', grant: 1000 }] } }
}

export default async function (rig) {
  const p = new Proof('project-retirement-slots')
  let phase = 'setup', completed = 0, serial = 0
  const traces = []
  try {
    rig.scenario({ default: { turns: [{ steps: [{ text: 'Synthetic slot grant received.' }] }] } })
    const project = async (name, parent, capacity) => {
      await rig.op({ op: 'create_project', name, parent })
      await rig.op({ op: 'set_slots', node: name, capacity })
    }
    const hire = (name, parent, grant = 0) => rig.op({ op: 'hire', name, parent, tier: 'sol', grant })
    const claim = (who, target, slots) => rig.tool(who, 'orgtree_watchdog', { action: 'create', name: `claim-${++serial}`, kind: 'slot', target, slots, once: true })
    const status = async target => (await rig.tool('boss', 'orgtree_project', { action: 'slots', name: target })).json
    const leases = target => rig.sql(`SELECT l.id,l.uid,a.name AS holder,l.slot_count AS slots,l.ended_at,l.end_reason,l.ended_by
      FROM ot.slot_leases l JOIN ot.agents pr ON pr.id=l.project_id LEFT JOIN ot.agents a ON a.id=l.holder_agent_id
      WHERE pr.org_id=(SELECT id FROM ot.orgs WHERE slug='${rig.org}') AND pr.name='${target}' ORDER BY l.id`)
    const active = target => leases(target).filter(l => !l.ended_at)
    const finish = async (kind, node) => kind === 'retire'
      ? rig.tool('boss', 'orgtree_retire', { node })
      : { ok: true, json: await rig.op({ op: kind, node }) }
    const check = (what, condition, detail) => p.check(`${phase}: ${what}`, condition, detail)
    const must = (what, condition, detail) => { if (!check(what, condition, detail)) throw Error(`precondition: ${what}`) }
    const settle = () => rig.waitFor(() => rig.sql('SELECT id FROM ot.turns WHERE ended_at IS NULL').length === 0,
      { what: 'synthetic setup turns settle', timeout: 60000 })
    const released = (target, held) => held.every(before => {
      const now = leases(target).find(l => l.uid === before.uid)
      return now?.ended_at && now.end_reason === 'retired' && now.slots === before.slots
    })
    const history = (page, held) => held.every(l => page?.history?.some(h => h.lease === l.uid && h.how === 'retired' && h.slots === l.slots))

    phase = 'single lease'
    await project('single', 'boss', 1)
    for (const who of ['single-holder', 'single-first', 'single-last']) await hire(who, 'single')
    await settle()
    const initial = await claim('single-holder', 'single', 1)
    const first = await claim('single-first', 'single', 1), last = await claim('single-last', 'single', 1)
    const before = await status('single'), held = active('single')
    must('one held lease and two real FIFO waiters', initial.ok && initial.json?.registered === false && first.ok && last.ok
      && held.length === 1 && before.line.map(w => w.agent).join() === 'single-first,single-last', before)
    const retired = await finish('retire', 'single-holder')
    const after = await status('single')
    check('retire ends the lease as retired and grants the first waiter before returning', retired.ok && released('single', held)
      && after.holders.map(h => h.agent).join() === 'single-first' && after.line.map(w => w.agent).join() === 'single-last', after)
    check('recent holds retain the ended lease and retirement reason', history(after, held), after.history)
    const release = await rig.tool('single-first', 'orgtree_project', { action: 'release_slot', lease: after.holders[0]?.lease })
    const next = await status('single')
    check('normal release still grants the remaining FIFO waiter exactly once', release.ok
      && next.holders.map(h => h.agent).join() === 'single-last' && next.line.length === 0, next)
    traces.push({ phase, before, retired, after, next }); completed++

    phase = 'multi-slot leases in multiple projects'
    await project('multi-a', 'boss', 3); await project('multi-b', 'multi-a', 2)
    for (const who of ['multi-holder', 'multi-first', 'multi-last', 'multi-other']) await hire(who, 'multi-b')
    await settle()
    for (const [target, count] of [['multi-a', 2], ['multi-a', 1], ['multi-b', 2]]) {
      const r = await claim('multi-holder', target, count)
      must(`inline ${target} ${count}-slot lease`, r.ok && r.json?.registered === false && typeof r.json.lease === 'string', r.json)
    }
    await claim('multi-first', 'multi-a', 2); await claim('multi-last', 'multi-a', 1); await claim('multi-other', 'multi-b', 2)
    const multiHeld = { a: active('multi-a'), b: active('multi-b') }
    const multiRet = await finish('retire', 'multi-holder')
    const ma = await status('multi-a'), mb = await status('multi-b')
    check('all three leases release across both projects with quantities and retired history intact', multiRet.ok
      && multiHeld.a.length === 2 && multiHeld.b.length === 1 && released('multi-a', multiHeld.a) && released('multi-b', multiHeld.b)
      && history(ma, multiHeld.a) && history(mb, multiHeld.b), { ma, mb })
    check('FIFO grants whole two-slot and one-slot requests in arrival order without oversubscription',
      active('multi-a').map(l => `${l.holder}:${l.slots}`).join() === 'multi-first:2,multi-last:1'
      && ma.held === 3 && ma.line.length === 0 && mb.held === 2 && mb.holders[0]?.agent === 'multi-other', { ma, mb })
    traces.push({ phase, multiHeld, multiRet, ma, mb }); completed++

    // A two-unit head blocks a one-unit tail while one unit remains free.
    // Ending only the queued agent must run grants too: no held lease exists
    // to lead projects_of() back to this project after its dog was paused.
    for (const kind of ['retire', 'dissolve', 'delete']) {
      phase = `${kind} waiting-only head`
      const target = `wait-${kind}`, blocker = `${kind}-block`, gone = `${kind}-wait`, tail = `${kind}-tail`
      await project(target, 'boss', 2)
      for (const who of [blocker, gone, tail]) await hire(who, target)
      await settle()
      await claim(blocker, target, 1); await claim(gone, target, 2); await claim(tail, target, 1)
      const old = await status(target), blockerLease = active(target)[0]
      must('head blocks the tail despite a free unit', old.held === 1 && old.line.map(w => w.agent).join() === `${gone},${tail}`, old)
      const ended = await finish(kind, gone)
      const current = await status(target)
      check('ending the head removes it from the active line and immediately grants the eligible tail', ended.ok
        && current.held === 2 && current.line.length === 0 && current.holders.some(h => h.agent === tail), current)
      check('unrelated live holder keeps its original lease and the ended claimant never receives one',
        active(target).some(l => l.uid === blockerLease.uid && l.holder === blocker)
        && leases(target).every(l => l.holder !== gone), leases(target))
      traces.push({ phase, old, ended, current }); completed++
    }

    for (const kind of ['retire', 'dissolve', 'delete']) {
      phase = `${kind} subtree`
      const a=`tree-${kind}-a`, b=`tree-${kind}-b`, manager=`${kind}-lead`, child=`${kind}-child`, waiting=`${kind}-queued`
      const first=`${kind}-next`, last=`${kind}-last`, other=`${kind}-other`
      await project(a,'boss',3);await project(b,a,2);await hire(manager,b,10)
      await hire(child,manager);await hire(waiting,manager)
      for(const who of [first,last,other])await hire(who,b)
      await settle()
      await claim(manager,a,1);await claim(child,a,2);await claim(child,b,2)
      await claim(waiting,a,1);await claim(waiting,b,1)
      await claim(first,a,2);await claim(last,a,1);await claim(other,b,2)
      const heldA=active(a),heldB=active(b),oldA=await status(a),oldB=await status(b)
      must('subtree owns single/multi leases and queued claims before ending',heldA.length===2&&heldB.length===1
        &&oldA.line.map(w=>w.agent).join()===`${waiting},${first},${last}`&&oldB.line.map(w=>w.agent).join()===`${waiting},${other}`,{oldA,oldB})
      const ended=await finish(kind,manager),nowA=await status(a),nowB=await status(b)
      check('all subtree leases end as retired, retain history and grant surviving claimants',ended.ok&&released(a,heldA)&&released(b,heldB)
        &&history(nowA,heldA)&&history(nowB,heldB)&&active(a).map(l=>`${l.holder}:${l.slots}`).join()===`${first}:2,${last}:1`
        &&nowB.holders.map(h=>h.agent).join()===other&&nowA.line.length===0&&nowB.line.length===0,{nowA,nowB})
      check('no ended descendant remains a holder or active waiter',![...nowA.holders,...nowA.line,...nowB.holders,...nowB.line]
        .some(row=>[manager,child,waiting].includes(row.agent)),{nowA,nowB})
      traces.push({phase,oldA,oldB,ended,nowA,nowB});completed++
    }

    // There is no user-facing 64-project lease cap. All these projects are
    // real descendants, so their ancestor legitimately holds their slots.
    // Retiring the ancestor also archives these projects; history must still
    // end every lease rather than leave an invisible active 65th hold.
    phase='more than 64 held projects'
    await hire('many-holder','boss',1)
    const many=[]
    for(let i=0;i<65;i++){
      const target=`many-${String(i).padStart(2,'0')}`
      await project(target,'many-holder',1)
      const r=await claim('many-holder',target,1)
      if(!r.ok||!r.json?.lease)throw Error(`could not prepare ${target}: ${r.text}`)
      many.push({target,lease:r.json.lease})
    }
    const ended=await finish('retire','many-holder')
    const manyRows=rig.sql("SELECT l.uid,l.ended_at,l.end_reason FROM ot.slot_leases l JOIN ot.agents a ON a.id=l.holder_agent_id WHERE a.name='many-holder' AND a.org_id=(SELECT id FROM ot.orgs WHERE slug='"+rig.org+"') ORDER BY l.id")
    check('every one of 65 project leases ends with retirement, including archived projects',ended.ok&&manyRows.length===65&&manyRows.every(l=>l.ended_at&&l.end_reason==='retired'),manyRows)
    traces.push({phase,ended,many,manyRows});completed++
    p.check('all nine assigned and boundary scenarios reached their end',completed===9,{completed})
  } catch(error) {
    p.check(`scenario failed during ${phase}`,false,{error:error.message,stack:error.stack})
  } finally {
    p.file('scenarios.json',traces)
    if(typeof rig?.engineLog==='function')p.keep(rig,{grep:/slots|lease|recheck_holder|retire|dissolve|delete/i})
  }
  return p.summary()
}
