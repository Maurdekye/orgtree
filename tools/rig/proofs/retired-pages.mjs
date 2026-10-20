// Real HTTP paging/search, seeded synthetic rows only. No live data.
import { Proof } from '../proof.mjs'
export async function setup() { return { fixture: { org: { name: 'Retired pages' }, agents: [{ name: 'boss', tier: 'sol', grant: 10 }] } } }
export default async function(rig) {
  const p = new Proof('retired-pages'), slug = rig.org
  await rig.op({ op: 'hire', name: 'template', parent: 'boss', tier: 'sol', grant: 0 })
  await rig.op({ op: 'retire', node: 'template' })
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${slug}'`).id
  const boss = rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='boss'`).id
  const cols = rig.sql(`SELECT column_name FROM information_schema.columns WHERE table_schema='ot' AND table_name='agents' AND is_generated='NEVER' AND identity_generation IS NULL AND column_name NOT IN ('name','sibling_order') ORDER BY ordinal_position`).map(r => r.column_name)
  rig.exec(`INSERT INTO ot.agents(name,sibling_order,${cols.join(',')}) SELECT 'old-'||lpad(g::text,4,'0'),g,${cols.map(c=>'a.'+c).join(',')} FROM ot.agents a,generate_series(1,1400) g WHERE a.org_id=${org} AND a.name='template'`)
  const route = `/api/orgs/${slug}/retired?parent=boss`
  let first
  try { first = await rig.api('GET', route) } catch(e) { p.check('retired list has a dedicated paged HTTP route',false,String(e)); return p.summary() }
  p.check('first page is 50 with a cursor, no full cohort', first.agents.length===50 && !!first.next_cursor, first.agents.length)
  const seen = new Set(first.agents.map(a=>a.id)); let cursor=first.next_cursor, pages=1
  while(cursor && pages<35) { const page=await rig.api('GET',route+'&cursor='+encodeURIComponent(cursor)); for(const a of page.agents){if(seen.has(a.id))p.check('no repeated identity',false,a.id);seen.add(a.id)} cursor=page.next_cursor;pages++ }
  p.check('all 1401 appear exactly once over bounded pages',seen.size===1401 && !cursor,{size:seen.size,pages})
  const search=await rig.api('GET',route+'&q=OLD-0001')
  p.check('case-insensitive substring search finds an agent outside the first page', search.agents.length===1 && search.agents[0].id==='old-0001',search)
  const empty=await rig.api('GET',route+'&q=does-not-exist')
  p.check('no matches terminates',empty.agents.length===0 && !empty.next_cursor)
  const id=rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='old-0001'`).id
  rig.exec(`INSERT INTO ot.turns(agent_id,started_at,ended_at) VALUES(${id},'2026-01-01Z','2026-01-02Z')`)
  const touched=await rig.api('GET',route)
  p.check('latest completed turn leads the list with its timestamp',touched.agents[0].id==='old-0001' && touched.agents[0].turns[0].at.startsWith('2026-01-02'),touched.agents[0])
  rig.exec(`UPDATE ot.agents SET state='live' WHERE id=${id}`)
  const rehired=await rig.api('GET',route+'&q=old-0001')
  p.check('rehired agent leaves the directory',rehired.agents.length===0)
  rig.exec(`UPDATE ot.agents SET state='archived' WHERE id=${id}`)
  p.check('retirement restores the latest turn ordering',(await rig.api('GET',route)).agents[0].id==='old-0001')
  const roots=await rig.api('GET',`/api/orgs/${slug}/retired?parent=`)
  p.check('parent scope excludes another pile',roots.agents.length===0)
  const plan=rig.sql(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT agent_id FROM ot.retired_picker WHERE org_id=${org} AND parent_key=${boss} ORDER BY touched DESC,sibling_order DESC,agent_id DESC LIMIT 51`)
  p.file('plan.json',plan)
  p.check('unfiltered page seeks the directory index',JSON.stringify(plan).includes('retired_picker_page'),plan)
  return p.summary()
}
