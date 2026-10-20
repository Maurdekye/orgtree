// Real HTTP paging/search, seeded synthetic rows only. No live data.
import { Proof } from '../proof.mjs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
export async function setup() { return { fixture: { org: { name: 'Retired pages' }, agents: [{ name: 'boss', tier: 'sol', grant: 10 }] } } }
export default async function(rig) {
  const p = new Proof('retired-pages'), slug = rig.org
  // rig.sql wraps a SELECT; EXPLAIN must go directly to the synthetic psql.
  const explain = sql => {
    const {port,password}=rig.pgConn()
    const r=spawnSync(path.join(rig.run.pgBin,'psql.exe'),['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','orgtree_admin','-d','orgtree_engine','-c',`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`],
      {encoding:'utf8',windowsHide:true,env:{...process.env,PGPASSWORD:password,PGCLIENTENCODING:'UTF8'}})
    if(r.status!==0)throw Error(r.stderr)
    return JSON.parse(r.stdout.trim())
  }
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
  p.check('equal or missing last turns retain reverse sibling order',first.agents[0].id==='old-1400' && first.agents[49].id==='old-1351',first.agents.map(a=>a.id))
  const seen = new Set(first.agents.map(a=>a.id)); let cursor=first.next_cursor, pages=1
  while(cursor && pages<35) { const page=await rig.api('GET',route+'&cursor='+encodeURIComponent(cursor)); for(const a of page.agents){if(seen.has(a.id))p.check('no repeated identity',false,a.id);seen.add(a.id)} cursor=page.next_cursor;pages++ }
  p.check('all 1401 appear exactly once over bounded pages',seen.size===1401 && !cursor,{size:seen.size,pages})
  const search=await rig.api('GET',route+'&q=OLD-0001')
  p.check('case-insensitive substring search finds an agent outside the first page', search.agents.length===1 && search.agents[0].id==='old-0001',search)
  const empty=await rig.api('GET',route+'&q=does-not-exist')
  p.check('no matches terminates',empty.agents.length===0 && !empty.next_cursor)
  const id=rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='old-0001'`).id
  rig.exec(`INSERT INTO ot.turns(agent_id,started_at,ended_at) VALUES(${id},'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`)
  const touched=await rig.api('GET',route)
  p.check('latest completed turn leads the list with its timestamp',touched.agents[0].id==='old-0001' && touched.agents[0].turns[0].at.startsWith('2026-01-02'),touched.agents[0])
  rig.exec(`INSERT INTO ot.turns(agent_id,started_at) VALUES(${id},'2026-01-03T00:00:00Z')`)
  p.check('new last turn updates its ordering',(await rig.api('GET',route+'&q=old-0001')).agents[0].turns[0].at.startsWith('2026-01-03'))
  rig.exec(`DELETE FROM ot.turns WHERE id=(SELECT max(id) FROM ot.turns WHERE agent_id=${id})`)
  p.check('removing an unsent last turn restores the previous last turn',(await rig.api('GET',route+'&q=old-0001')).agents[0].turns[0].at.startsWith('2026-01-02'))
  rig.exec(`UPDATE ot.agents SET state='live' WHERE id=${id}`)
  const rehired=await rig.api('GET',route+'&q=old-0001')
  p.check('rehired agent leaves the directory',rehired.agents.length===0)
  rig.exec(`UPDATE ot.agents SET state='archived' WHERE id=${id}`)
  p.check('retirement restores the latest turn ordering',(await rig.api('GET',route)).agents[0].id==='old-0001')
  const roots=await rig.api('GET',`/api/orgs/${slug}/retired?parent=`)
  p.check('parent scope excludes another pile',roots.agents.length===0)
  await rig.op({op:'create_project',name:'project',parent:'boss'})
  await rig.op({op:'hire',name:'project-old',parent:'project',tier:'sol',grant:0})
  await rig.op({op:'retire',node:'project-old'})
  p.check('ordinary pile stays direct-parent scoped',(await rig.api('GET',route+'&q=project-old')).agents.length===0)
  p.check('desk reports include retired members through live projects',(await rig.api('GET',route+'&reports=true&q=project-old')).agents[0]?.id==='project-old')
  rig.exec(`UPDATE ot.agents SET name='renamed-retiree' WHERE id=${id}`)
  p.check('renaming refreshes name search',(await rig.api('GET',route+'&q=renamed-retiree')).agents[0]?.id==='renamed-retiree')
  rig.exec(`UPDATE ot.agents SET parent_id=NULL WHERE id=${id}`)
  p.check('moving a retiree removes it from its old pile',(await rig.api('GET',route+'&q=renamed-retiree')).agents.length===0)
  p.check('moving a retiree puts it in the root pile',(await rig.api('GET',`/api/orgs/${slug}/retired?parent=&q=renamed-retiree`)).agents[0]?.id==='renamed-retiree')
  let bad=false
  try{await rig.api('GET',route+'&q=other&cursor='+encodeURIComponent(first.next_cursor))}catch(e){bad=/400/.test(String(e))}
  p.check('a cursor from a different search is refused',bad)
  rig.exec('ANALYZE ot.retired_picker')
  const plan=explain(`SELECT agent_id FROM ot.retired_picker WHERE org_id=${org} AND parent_key=${boss} ORDER BY touched DESC,sibling_order DESC,agent_id DESC LIMIT 51`)
  p.file('plan.json',plan)
  p.check('unfiltered page seeks the directory index',JSON.stringify(plan).includes('retired_picker_page'),plan)
  // Measurements exclude client launch/DDL. Alternate enabled/disabled runs
  // on the SAME disposable database, 500 rows per run, median of seven.
  rig.exec(`INSERT INTO ot.turns(agent_id,started_at,ended_at) SELECT ${boss},'2026-01-01T00:00:00Z'::timestamptz,'2026-01-02T00:00:00Z'::timestamptz FROM generate_series(1,500)`)
  const median=a=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)]
  const samples={baseline:[],enabled:[],accounting:[]}
  try {
    for(let round=0;round<8;round++)for(const enabled of round%2?[true,false]:[false,true]){
      rig.exec(`ALTER TABLE ot.turns ${enabled?'ENABLE':'DISABLE'} TRIGGER retired_picker_turn_time`)
      const run=explain(`UPDATE ot.turns SET ended_at=ended_at+interval '1 millisecond' WHERE agent_id=${boss}`)[0]
      if(round>0)samples[enabled?'enabled':'baseline'].push(run['Execution Time'])
      if(enabled)p.file('live-end-plan.json',run)
    }
  } finally {rig.exec('ALTER TABLE ot.turns ENABLE TRIGGER retired_picker_turn_time')}
  const accounting=explain(`UPDATE ot.turns SET ms=coalesce(ms,0)+1 WHERE agent_id=${boss}`)[0]
  p.check('hot accounting writes invoke no picker trigger',!(accounting.Triggers??[]).some(t=>t['Trigger Name'].startsWith('retired_picker')),accounting.Triggers)
  const unchanged=explain(`UPDATE ot.turns SET ended_at=ended_at WHERE agent_id=${boss}`)[0]
  p.check('writing the unchanged last-turn timestamp invokes no picker trigger',!(unchanged.Triggers??[]).some(t=>t['Trigger Name'].startsWith('retired_picker')),unchanged.Triggers)
  const cost={rows:500,samples,baseline_ms:median(samples.baseline),enabled_ms:median(samples.enabled),accounting_ms:accounting['Execution Time']}
  cost.added_us_per_end=(cost.enabled_ms-cost.baseline_ms)*1000/500
  p.file('turn-write-cost.json',cost);p.note('measured live turn-end write cost',cost)
  // A live turn owns no directory entry, so its trigger cannot take a
  // directory row lock or acquire an agent/org revision lock.
  p.check('live agent never enters the retired directory',rig.one(`SELECT count(*)::int n FROM ot.retired_picker WHERE agent_id=${boss}`).n===0)
  return p.summary()
}
