// Proof: retired piles reach the canvas (user 2026-10-20 11:00Z, alpha.18:
// "i disabled the 'hide retired agents' setting, but i see no retired agents
// anywhere on the canvas"). The record feed's shared set must carry each
// visible parent's retired-pile representatives, as its design says
// (docs/state-system/pg-step6-record-feed.md §1.3) and as 3.x's pile edges
// did: the FIRST archived child (where the pile sits among the live
// siblings) and the LAST (its default front) of the top level, of every
// live agent and, in turn, of each pile's default front. Nothing else
// retired: a buried member's own retired reports stay out.
//
// The expected set comes from an oracle over the database rows (a JS walk,
// independent of the engine's SQL), itself checked against the names this
// fixture was built to produce. Then a retire, a rehire, a delete and a
// top-level retire each move the representatives through the live feed
// (snapshot and catch-up), the top level's retired count follows (it went
// stale before: the `foreground` group was re-read only on org changes),
// a rehire out of a pile front's nested pile drops the front's count (the
// rehire marked only its new parent before), and an engine restart rebuilds
// the same set.
//
// Red at 689e41f: the shared set holds no retired agent at all, and the
// top-level count stays where it was after a retire.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/retired-piles.mjs

import { TOKEN_HEADER } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Retired piles' }, agents: [{ name: 'boss', tier: 'sol', grant: 400 }] } }
}

export default async function (rig) {
  const p = new Proof('retired-piles')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const slug = rig.org
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${slug}'`).id
  const hire = (name, parent) => rig.op({ op: 'hire', name, tier: 'sol', grant: 0, ...(parent ? { parent } : {}) })
  const retire = node => rig.op({ op: 'retire', node })
  const project = (name, parent) => rig.op({ op: 'create_project', name, parent })

  // ------------------------------------------------------------ the org
  // top level: three retired (a pile of 3) and one live
  for (const n of ['top-a', 'top-b', 'top-c']) await hire(n)
  await hire('top-live')
  for (const n of ['top-a', 'top-b', 'top-c']) await retire(n)
  // under boss: old-1..old-5 retired; old-2 (buried) has retired reports of
  // its own, old-5 (the default front) has a nested pile of three. A hire
  // takes the next order after the LIVE siblings, so every live sibling is
  // hired before the old ones retire: old-1..old-5, lead, proj, proj-one in
  // that order, and later old-6 last.
  for (const n of ['old-1', 'old-2', 'old-3', 'old-4', 'old-5']) await hire(n, 'boss')
  for (const n of ['hidden-1', 'hidden-2']) { await hire(n, 'old-2'); await retire(n) }
  for (const n of ['nest-1', 'nest-2', 'nest-3']) { await hire(n, 'old-5'); await retire(n) }
  // a live lead with a single retired report
  await hire('lead', 'boss'); await hire('lead-kid', 'lead'); await retire('lead-kid')
  // projects: one with three retired members, one with a single retired member
  await project('proj', 'boss')
  for (const n of ['pm-1', 'pm-2', 'pm-3']) { await hire(n, 'proj'); await retire(n) }
  await hire('pm-live', 'proj')
  await project('proj-one', 'boss'); await hire('solo', 'proj-one'); await retire('solo')
  for (const n of ['old-1', 'old-2', 'old-3', 'old-4', 'old-5']) await retire(n)

  // ------------------------------------------------------------ the oracle
  const rows = () => rig.sql(`SELECT id, name, parent_id, state, sibling_order FROM ot.agents
    WHERE org_id = ${orgId} AND state <> 'deleted' ORDER BY id`)
  const oracle = () => {
    const all = rows()
    const byId = new Map(all.map(r => [r.id, r]))
    const kids = new Map()
    for (const r of all) {
      const k = r.parent_id ?? 0
      if (!kids.has(k)) kids.set(k, [])
      kids.get(k).push(r)
    }
    const reps = new Map()                          // name -> parent name ('' = top level)
    const visit = [0, ...all.filter(r => r.state === 'live').map(r => r.id)]
    const seen = new Set()
    while (visit.length) {
      const parent = visit.shift()
      if (seen.has(parent)) continue
      seen.add(parent)
      const retired = (kids.get(parent) ?? []).filter(r => r.state === 'archived')
        .sort((a, b) => a.sibling_order - b.sibling_order || a.id - b.id)
      if (!retired.length) continue
      const parentName = parent === 0 ? '' : byId.get(parent).name
      for (const r of [retired[0], retired[retired.length - 1]]) reps.set(r.name, parentName)
      visit.push(retired[retired.length - 1].id)    // the default front's own pile shows
    }
    return { reps, all, byId }
  }

  // ------------------------------------------------------------ the feed
  const snapshot = () => rig.api('GET', `/api/orgs/${slug}/records`)
  const agentsOf = snap => {
    const byKey = new Map(snap.records.filter(r => r.entity === 'agent').map(r => [r.id, r.body]))
    const out = new Map()
    for (const body of byKey.values()) {
      out.set(body.id, { state: body.state, parent: body.parent_id == null ? '' : byKey.get(body.parent_id)?.id ?? `?${body.parent_id}`,
        total: body.retired_children_total })
    }
    return out
  }
  const held = snap => new Map([...agentsOf(snap)].filter(([, a]) => a.state === 'archived').map(([n, a]) => [n, a.parent]))
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  const show = m => Object.fromEntries([...m].sort(([a], [b]) => a.localeCompare(b)))
  const foreground = snap => snap.records.find(r => r.entity === 'org' && r.id === 'foreground')?.body ?? null
  const truth = () => rig.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE parent_id IS NULL)::int AS roots
    FROM ot.agents WHERE org_id = ${orgId} AND state IN ('archived', 'unrecoverable')`)
  // the renderer's projection refuses a parent whose count is below the retired children it holds
  const countsCover = snap => {
    const a = agentsOf(snap)
    const heldUnder = new Map()
    for (const [, x] of a) if (x.state === 'archived') heldUnder.set(x.parent, (heldUnder.get(x.parent) ?? 0) + 1)
    const bad = []
    for (const [parent, n] of heldUnder) {
      const total = parent === '' ? foreground(snap)?.retired_roots_total : a.get(parent)?.total
      if (!(Number(total) >= n)) bad.push({ parent, held: n, total })
    }
    return bad
  }
  const settle = async (what, want) => {
    try { return await rig.waitFor(async () => { const s = await snapshot(); return want(s) ? s : null }, { timeout: 15000, every: 250, what }) }
    catch { return snapshot() }
  }

  const expected = new Map(Object.entries({
    'top-a': '', 'top-c': '', 'old-1': 'boss', 'old-5': 'boss', 'nest-1': 'old-5', 'nest-3': 'old-5',
    'lead-kid': 'lead', 'pm-1': 'proj', 'pm-3': 'proj', solo: 'proj-one',
  }))
  let o = oracle()
  p.check('control: the fixture retired what it meant to (18 archived) and the oracle picks the designed representatives',
    o.all.filter(r => r.state === 'archived').length === 18 && same(o.reps, expected), { oracle: show(o.reps) })

  let snap = await settle('the representatives in the shared set', s => same(held(s), oracle().reps))
  p.file('snapshot-initial.json', snap)
  p.check('the shared set carries every visible parent\'s first and last retired child, at the top level, under an agent, under projects and under a pile\'s front',
    same(held(snap), o.reps), { held: show(held(snap)), want: show(o.reps) })
  const buried = ['old-2', 'old-3', 'old-4', 'hidden-1', 'hidden-2', 'nest-2', 'top-b', 'pm-2']
  p.check('nothing else retired: buried pile members and their own reports stay out',
    buried.every(n => !agentsOf(snap).has(n)), buried.filter(n => agentsOf(snap).has(n)))
  const t0 = truth()
  p.check('the counts cover what is held (the renderer\'s projection would accept it)', countsCover(snap).length === 0, countsCover(snap))
  p.check('the top-level count is the database\'s', foreground(snap)?.retired_roots_total === t0.roots && foreground(snap)?.retired_total === t0.total,
    { feed: foreground(snap), db: t0 })

  // the HTTP tree read: held representatives once, the rest a hidden count
  const tree = await rig.api('GET', `/api/orgs/${slug}`)
  const find = (nodes, name) => { for (const n of nodes ?? []) { if (n.id === name) return n; const hit = find(n.children, name); if (hit) return hit } return null }
  const boss = find(tree.roots, 'boss')
  p.check('the HTTP tree holds the representatives and hides the rest of each count',
    boss?.hidden_retired_children === 3 && find(tree.roots, 'old-1')?.state === 'archived' && find(tree.roots, 'old-5')?.state === 'archived'
      && find(tree.roots, 'proj')?.hidden_retired_children === 1 && tree.foreground?.hidden_retired_roots === 1 && !find(tree.roots, 'old-3'),
    { boss: boss?.hidden_retired_children, proj: find(tree.roots, 'proj')?.hidden_retired_children, roots: tree.foreground?.hidden_retired_roots })

  // ------------------------------------------------------------ moves
  // a new retiree under boss becomes the pile's last: old-5 and its nested pile leave
  const before = snap.cursor
  await hire('old-6', 'boss'); await retire('old-6')
  o = oracle()
  snap = await settle('old-6 as the new front', s => same(held(s), oracle().reps))
  p.check('a retire moves the pile: the newest retiree is its front, the old front and its nested pile leave',
    same(held(snap), o.reps) && held(snap).get('old-6') === 'boss' && !held(snap).has('old-5') && !held(snap).has('nest-1'),
    { held: show(held(snap)), want: show(o.reps) })
  const changes = await rig.api('GET', `/api/orgs/${slug}/changes?after=${before.rev}&org_uuid=${before.org_uuid}&incarnation=${before.incarnation}`)
  p.file('changes-after-retire.json', changes)
  const key = name => String(o.all.find(r => r.name === name)?.id)
  const upserted = new Set((changes.upserts ?? []).filter(r => r.entity === 'agent' && (r.set ?? 'shared') === 'shared').map(r => r.id))
  const tombed = new Set((changes.tombstones ?? []).filter(r => r.entity === 'agent' && (r.set ?? 'shared') === 'shared').map(r => r.id))
  p.check('the catch-up carries the same move: old-6 in, old-5 and its pile out',
    changes.type === 'record_changes' && upserted.has(key('old-6')) && ['old-5', 'nest-1', 'nest-3'].every(n => tombed.has(key(n))) && !tombed.has(key('old-6')),
    { type: changes.type, upserted: [...upserted], tombed: [...tombed] })
  const t1 = truth()
  p.check('the org\'s retired count follows a retire', foreground(snap)?.retired_total === t1.total && t1.total === t0.total + 1,
    { feed: foreground(snap), db: t1, before: t0 })

  // a rehire of the first representative: the next retired child places the pile
  await rig.op({ op: 'rehire', node: 'old-1' })
  o = oracle()
  snap = await settle('old-2 as the pile\'s first', s => same(held(s), oracle().reps))
  p.check('a rehire moves the pile\'s first to the next retiree, and the rehired agent is a live record',
    same(held(snap), o.reps) && held(snap).get('old-2') === 'boss' && agentsOf(snap).get('old-1')?.state === 'live'
      && !agentsOf(snap).has('hidden-1'),
    { held: show(held(snap)), want: show(o.reps), old1: agentsOf(snap).get('old-1') })

  // deleting the top level's front: the one before it fronts the pile
  await rig.op({ op: 'delete', node: 'top-c' })
  o = oracle()
  snap = await settle('top-b as the top level\'s front', s => same(held(s), oracle().reps))
  p.check('a delete moves the pile\'s front', same(held(snap), o.reps) && held(snap).get('top-b') === '' && !agentsOf(snap).has('top-c'),
    { held: show(held(snap)), want: show(o.reps) })

  // a top-level retire: the new front, and the top level's count follows it (stale before the fix)
  await hire('top-d'); await retire('top-d')
  o = oracle()
  snap = await settle('top-d as the top level\'s front', s => same(held(s), oracle().reps) && foreground(s)?.retired_roots_total === truth().roots)
  const t2 = truth()
  p.check('a top-level retire fronts its pile and the top-level count follows',
    same(held(snap), o.reps) && held(snap).get('top-d') === '' && foreground(snap)?.retired_roots_total === t2.roots,
    { held: show(held(snap)), want: show(o.reps), feed: foreground(snap), db: t2 })
  p.check('the counts still cover what is held', countsCover(snap).length === 0, countsCover(snap))

  // a rehire out of a pile front's own nested pile: the representatives stay
  // and the front's count drops (a rehire marked only its new, live parent)
  await hire('front-2', 'lead')
  for (const n of ['fn-1', 'fn-2', 'fn-3']) { await hire(n, 'front-2'); await retire(n) }
  await retire('front-2')
  o = oracle()
  snap = await settle('front-2 fronting lead\'s pile', s => same(held(s), oracle().reps))
  p.check('control: front-2 fronts lead\'s pile and its nested pile holds fn-1 and fn-3, not fn-2',
    same(held(snap), o.reps) && held(snap).get('front-2') === 'lead' && held(snap).get('fn-1') === 'front-2'
      && held(snap).get('fn-3') === 'front-2' && !held(snap).has('fn-2') && agentsOf(snap).get('front-2')?.total === 3,
    { held: show(held(snap)), front: agentsOf(snap).get('front-2') })
  await rig.op({ op: 'rehire', node: 'fn-2' })
  o = oracle()
  const frontTotal = s => agentsOf(s).get('front-2')?.total
  snap = await settle('front-2\'s count after fn-2\'s rehire', s => same(held(s), oracle().reps) && frontTotal(s) === 2)
  p.check('a rehire out of a front\'s nested pile drops the front\'s count; the representatives stay',
    same(held(snap), o.reps) && frontTotal(snap) === 2 && agentsOf(snap).get('fn-2')?.state === 'live',
    { held: show(held(snap)), want: show(o.reps), front_total: frontTotal(snap), fn2: agentsOf(snap).get('fn-2') })
  const after = await rig.api('GET', `/api/orgs/${slug}`)
  p.check('the HTTP tree\'s hidden count under the front follows the rehire', find(after.roots, 'front-2')?.hidden_retired_children === 0,
    { front: find(after.roots, 'front-2')?.hidden_retired_children })

  // a fresh engine builds the same set on its first load
  const kept = held(snap)
  await rig.restart()
  snap = await settle('the first load after a restart', s => same(held(s), kept))
  p.check('after an engine restart the first load holds the same representatives', same(held(snap), kept), { held: show(held(snap)), want: show(kept) })

  // what one shared snapshot costs (the size check at scale is retired-piles-scale.mjs)
  const t = Date.now(); const raw = await fetch(rig.url + `/api/orgs/${slug}/records`, { headers: { [TOKEN_HEADER]: rig.token } }).then(r => r.text())
  p.note('shared snapshot', { bytes: raw.length, ms: Date.now() - t, archived: held(JSON.parse(raw)).size })
  return p.summary()
}
