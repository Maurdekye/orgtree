// Proof: retired piles at the live org's scale (user 2026-10-20 11:00Z; the
// coordinator asked for the measured snapshot size and time at 1400 retired
// agents). The shape of the live org: about 1321 retired agents directly
// under one top-level agent, 78 at the top level, 3 under one project and 1
// under another, and a nested pile under a pile's front. The shared set must
// hold only each visible parent's first and last retired child, whatever the
// history: two records for the 1321, not 1321.
//
// Seeding: the first retirees of each parent come through the real ops
// (hire, retire, create_project); the bulk is copied from one of them in
// SQL (every column but the name, parent, order and dates), then the engine
// restarts so the feed's first load reads it all.
//
// Measured: the shared snapshot (`/records`) and the HTTP tree read, size
// and time over five reads each; the pile-edge statements' plans and times
// (EXPLAIN ANALYZE, the engine's own SQL); a retire under the big parent
// until the snapshot shows its new front.
// Run: node tools/rig/rig.mjs run tools/rig/proofs/retired-piles-scale.mjs

import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { TOKEN_HEADER } from '../lib.mjs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Retired piles at scale' }, agents: [{ name: 'coord', tier: 'sol', grant: 400 }] } }
}

const COORD = 1321, TOP = 78

export default async function (rig) {
  const p = new Proof('retired-piles-scale')
  rig.scenario({ default: { turns: [{ name: 'default', steps: [{ text: 'OK.' }] }] } })
  const slug = rig.org
  const orgId = rig.one(`SELECT id FROM ot.orgs WHERE slug = '${slug}'`).id
  const hire = (name, parent) => rig.op({ op: 'hire', name, tier: 'sol', grant: 0, ...(parent ? { parent } : {}) })
  const retire = node => rig.op({ op: 'retire', node })
  const id = name => rig.one(`SELECT id FROM ot.agents WHERE org_id = ${orgId} AND name = '${name}' AND state <> 'deleted'`).id

  // ------------------------------------------------------------ seed
  const t0 = Date.now()
  await rig.op({ op: 'create_project', name: 'slots', parent: 'coord' })
  await rig.op({ op: 'create_project', name: 'committee', parent: 'coord' })
  for (const n of ['coord-t1', 'coord-t2', 'coord-t3']) { await hire(n, 'coord'); await retire(n) }
  for (const n of ['top-t1', 'top-t2']) { await hire(n); await retire(n) }
  for (const n of ['slot-1', 'slot-2', 'slot-3']) { await hire(n, 'slots'); await retire(n) }
  await hire('cmt-1', 'committee'); await retire('cmt-1')
  const template = id('coord-t1')
  const cols = rig.sql(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'ot' AND table_name = 'agents' AND is_generated = 'NEVER' AND identity_generation IS NULL
      AND column_name NOT IN ('name', 'parent_id', 'sibling_order', 'created_at', 'archived_at', 'scratch_dir', 'session_id')
    ORDER BY ordinal_position`).map(r => r.column_name)
  const order = rig.one(`SELECT sibling_order FROM ot.agents WHERE id = ${template}`).sibling_order
  const copy = (prefix, count, parent) => rig.exec(`INSERT INTO ot.agents (name, parent_id, sibling_order, created_at, archived_at, ${cols.join(', ')})
    SELECT '${prefix}' || g, ${parent ?? 'NULL'}, ${order}, now() - interval '2 days' + g * interval '1 second', now(), ${cols.map(c => 't.' + c).join(', ')}
      FROM ot.agents t, generate_series(1, ${count}) g WHERE t.id = ${template}`)
  copy('coord-r-', COORD - 3, id('coord'))
  copy('top-r-', TOP - 2, null)
  // a nested pile under the big pile's front (the last copy), and retired
  // reports under a buried member, which must stay out
  copy('nest-r-', 5, id(`coord-r-${COORD - 3}`))
  copy('buried-r-', 3, id('coord-r-10'))
  p.note('seeded', { ms: Date.now() - t0 })
  await rig.restart()

  // ------------------------------------------------------------ the oracle (as retired-piles.mjs)
  const oracle = () => {
    const all = rig.sql(`SELECT id, name, parent_id, state, sibling_order FROM ot.agents WHERE org_id = ${orgId} AND state <> 'deleted' ORDER BY id`)
    const byId = new Map(all.map(r => [r.id, r]))
    const kids = new Map()
    for (const r of all) { const k = r.parent_id ?? 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r) }
    const reps = new Map()
    const visit = [0, ...all.filter(r => r.state === 'live').map(r => r.id)]
    const seen = new Set()
    while (visit.length) {
      const parent = visit.shift()
      if (seen.has(parent)) continue
      seen.add(parent)
      const retired = (kids.get(parent) ?? []).filter(r => r.state === 'archived').sort((a, b) => a.sibling_order - b.sibling_order || a.id - b.id)
      if (!retired.length) continue
      const parentName = parent === 0 ? '' : byId.get(parent).name
      for (const r of [retired[0], retired[retired.length - 1]]) reps.set(r.name, parentName)
      visit.push(retired[retired.length - 1].id)
    }
    return { reps, all }
  }
  const o = oracle()
  const retiredCount = o.all.filter(r => r.state === 'archived').length
  p.check(`control: ${COORD} under coord, ${TOP} at the top level, 3 and 1 under projects, a nested pile of 5 (1411 retired)`,
    retiredCount === 1411 && o.all.filter(r => r.state === 'archived' && r.parent_id === id('coord')).length === COORD
      && o.all.filter(r => r.state === 'archived' && r.parent_id === null).length === TOP,
    { retired: retiredCount, reps: Object.fromEntries(o.reps) })

  // ------------------------------------------------------------ the feed
  const timed = async (route, n = 5) => {
    const runs = []
    let text = ''
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      text = await fetch(rig.url + route, { headers: { [TOKEN_HEADER]: rig.token } }).then(r => r.text())
      runs.push(Math.round((performance.now() - t) * 10) / 10)
    }
    runs.sort((a, b) => a - b)
    return { bytes: Buffer.byteLength(text), ms: { min: runs[0], median: runs[Math.floor(n / 2)], max: runs[n - 1] }, json: JSON.parse(text) }
  }
  const held = snap => {
    const byKey = new Map(snap.records.filter(r => r.entity === 'agent').map(r => [r.id, r.body]))
    return new Map([...byKey.values()].filter(b => b.state === 'archived')
      .map(b => [b.id, b.parent_id == null ? '' : byKey.get(b.parent_id)?.id ?? `?${b.parent_id}`]))
  }
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)
  let snap
  try {
    snap = await rig.waitFor(async () => { const s = await rig.api('GET', `/api/orgs/${slug}/records`); return same(held(s), o.reps) ? s : null },
      { timeout: 30000, every: 500, what: 'the representatives after the first load' })
  } catch { snap = await rig.api('GET', `/api/orgs/${slug}/records`) }
  p.check(`the shared set holds ${o.reps.size} representatives out of ${retiredCount} retired agents`, same(held(snap), o.reps),
    { held: Object.fromEntries(held(snap)), want: Object.fromEntries(o.reps) })
  const records = await timed(`/api/orgs/${slug}/records`)
  const tree = await timed(`/api/orgs/${slug}`)
  const agentRecords = records.json.records.filter(r => r.entity === 'agent').length
  p.note('shared snapshot /records at scale', { bytes: records.bytes, ms: records.ms, agent_records: agentRecords, retired_records: held(records.json).size, retired_in_db: retiredCount })
  p.note('HTTP tree read at scale', { bytes: tree.bytes, ms: tree.ms })
  p.file('snapshot.json', records.json)
  const coordNode = (function find(nodes) { for (const n of nodes ?? []) { if (n.id === 'coord') return n; const hit = find(n.children); if (hit) return hit } return null })(tree.json.roots)
  p.check('the HTTP tree hides the rest of each count', coordNode?.hidden_retired_children === COORD - 2 && tree.json.foreground?.hidden_retired_roots === TOP - 2,
    { coord: coordNode?.hidden_retired_children, roots: tree.json.foreground?.hidden_retired_roots })

  // ------------------------------------------------------------ the statements' cost (the engine's SQL)
  const EDGES = parents => `SELECT p.parent, f.id, l.id
    FROM ${parents} AS p(parent)
    CROSS JOIN LATERAL (SELECT c.id FROM ot.agents c WHERE c.org_id = ${orgId} AND c.parent_id = p.parent AND c.state = 'archived' ORDER BY c.sibling_order, c.id LIMIT 1) f
    CROSS JOIN LATERAL (SELECT c.id FROM ot.agents c WHERE c.org_id = ${orgId} AND c.parent_id = p.parent AND c.state = 'archived' ORDER BY c.sibling_order DESC, c.id DESC LIMIT 1) l`
  const ROOTS = `SELECT (SELECT id FROM ot.agents WHERE org_id = ${orgId} AND parent_id IS NULL AND state = 'archived' ORDER BY sibling_order, id LIMIT 1),
    (SELECT id FROM ot.agents WHERE org_id = ${orgId} AND parent_id IS NULL AND state = 'archived' ORDER BY sibling_order DESC, id DESC LIMIT 1)`
  // EXPLAIN cannot sit inside rig.sql's json_agg wrapper: psql directly
  const plan = sql => {
    const { port, password } = rig.pgConn()
    const r = spawnSync(path.join(rig.run.pgBin, 'psql.exe'), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(port),
      '-U', 'orgtree_admin', '-d', 'orgtree_engine', '-c', `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, PGPASSWORD: password, PGCLIENTENCODING: 'UTF8' } })
    if (r.status !== 0) throw new Error(`explain failed: ${r.stderr}`)
    const j = JSON.parse(r.stdout)[0]
    const indexes = new Set()
    const walk = n => { if (n['Index Name']) indexes.add(`${n['Node Type']} ${n['Index Name']}`); (n.Plans ?? []).forEach(walk) }
    walk(j.Plan)
    return { ms: j['Execution Time'], planning_ms: j['Planning Time'], indexes: [...indexes], shared_hit: j.Plan['Shared Hit Blocks'], read: j.Plan['Shared Read Blocks'] }
  }
  const live = plan(EDGES(`(SELECT id FROM ot.agents WHERE org_id = ${orgId} AND state = 'live')`))
  const roots = plan(ROOTS)
  const fronts = plan(EDGES(`unnest(ARRAY[${id(`coord-r-${COORD - 3}`)}]::bigint[])`))
  p.note('pile-edge statements (EXPLAIN ANALYZE)', { live_parents: live, roots, fronts_round: fronts })
  const usesIndex = q => q.indexes.some(i => i.includes('agents_retired_pile_edges'))
  p.check('each pile edge is an index probe of agents_retired_pile_edges, not a scan of the retired history',
    usesIndex(live) && usesIndex(roots) && usesIndex(fronts), { live: live.indexes, roots: roots.indexes, fronts: fronts.indexes })

  // ------------------------------------------------------------ a live retire under the big parent
  await hire('coord-new', 'coord')
  const t = performance.now()
  await retire('coord-new')
  const next = oracle().reps
  let moved = null
  try {
    moved = await rig.waitFor(async () => { const s = await rig.api('GET', `/api/orgs/${slug}/records`); return same(held(s), next) ? s : null },
      { timeout: 15000, every: 50, what: 'the new front' })
  } catch { /* checked below */ }
  const ms = Math.round(performance.now() - t)
  p.check('a retire under the big parent fronts its pile', !!moved && held(moved).get('coord-new') === 'coord', { ms, held: moved && Object.fromEntries(held(moved)) })
  p.note('retire to new front in the shared snapshot', { ms })
  return p.summary()
}
