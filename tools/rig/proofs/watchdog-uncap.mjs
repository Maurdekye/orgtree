// Synthetic-only regression for uncapped creation and bounded desktop reads.
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'

export async function setup() { return { recover: true } }
export default async function(rig) {
  const p = new Proof('watchdog-uncap')
  rig.scenario({default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
  await rig.op({op:'hire',name:'watcher',parent:'boss',tier:'sol',title:'Synthetic watchdog owner'})
  const folder=path.join(rig.data,'scratch',rig.org,'watcher')
  fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'quiet.log'),'quiet\n')
  const made=[]
  for(let i=1;i<=9;i++) made.push(await rig.tool('watcher','orgtree_watchdog',{
    action:'create',name:'watch-'+i,kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true,
  }))
  p.check('control: the first eight real creates succeed',made.slice(0,8).every(r=>r.ok))
  p.check('the ninth create succeeds',made[8].ok,{result:made[8].text})
  // Isolate the former ORG cap: on the red engine these four owners have
  // exactly eight each, so a fifth owner's first dog must hit 32/org.
  const fillers=[]
  for(let a=0;a<3;a++) {
    const name='filler-'+a
    await rig.op({op:'hire',name,parent:'boss',tier:'sol',title:'Synthetic watchdog owner'})
    const dir=path.join(rig.data,'scratch',rig.org,name)
    fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'quiet.log'),'quiet\n')
    for(let i=0;i<8;i++)fillers.push(await rig.tool(name,'orgtree_watchdog',{
      action:'create',name:'watch-'+i,kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true,
    }))
  }
  p.check('control: three other owners can each keep eight',fillers.every(r=>r.ok))
  await rig.op({op:'hire',name:'beyond-org',parent:'boss',tier:'sol',title:'Synthetic watchdog owner'})
  const beyond=path.join(rig.data,'scratch',rig.org,'beyond-org')
  fs.mkdirSync(beyond,{recursive:true});fs.writeFileSync(path.join(beyond,'quiet.log'),'quiet\n')
  const orgCount=rig.one("SELECT count(*)::int AS n FROM ot.watchdogs WHERE state IN ('armed','paused','exited')").n
  const over=await rig.tool('beyond-org','orgtree_watchdog',{action:'create',name:'over-org',kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true})
  p.check('a fifth owner creates beyond the old 32/org limit',over.ok,{before:orgCount,result:over.text})
  for(let i=10;i<=33;i++)made.push(await rig.tool('watcher','orgtree_watchdog',{
    action:'create',name:'watch-'+i,kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true,
  }))
  const rows=rig.sql("SELECT w.uid FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id WHERE a.name='watcher' AND w.state='armed' ORDER BY w.id")
  p.check('all 33 watchdogs persist armed',rows.length===33,{count:rows.length})
  if(!made[8].ok||!over.ok)return p.summary()
  const toolRows=[];let cursor,toolPages=0
  do {
    const r=await rig.tool('watcher','orgtree_watchdog',{action:'list',limit:7,...(cursor?{cursor}:{})})
    if(!r.ok)throw Error(r.text)
    p.check('tool page '+(++toolPages)+' is bounded',r.json.watchdogs.length<=7)
    toolRows.push(...r.json.watchdogs);cursor=r.json.next_cursor
  }while(cursor&&toolPages<20)
  p.check('tool cursor reaches every dog exactly once',!cursor&&toolRows.length===33&&new Set(toolRows.map(w=>w.id)).size===33,{count:toolRows.length,pages:toolPages})
  const foreign=await rig.tool('carol','orgtree_watchdog',{action:'list',limit:7,cursor:'0'})
  p.check('list rechecks caller reach',foreign.ok&&foreign.json.watchdogs.length===0,foreign.json)
  const badCursor=await rig.tool('watcher','orgtree_watchdog',{action:'list',cursor:'not-a-cursor'})
  const badLimit=await rig.tool('watcher','orgtree_watchdog',{action:'list',limit:101})
  p.check('invalid tool cursor and limit are refused',!badCursor.ok&&!badLimit.ok)
  const pages=[];let next='0',pageCount=0
  do {
    const page=await rig.api('GET',`/api/orgs/${rig.org}/watchdogs?owner=watcher&cursor=${next}&limit=7`)
    p.check('desktop page '+(++pageCount)+' is bounded and counts all dogs',page.watchdogs.length<=7&&page.total===33)
    pages.push(...page.watchdogs);next=page.next_cursor
  }while(next&&pageCount<20)
  p.check('desktop cursor reaches every qualified handle exactly once',!next&&pages.length===33&&new Set(pages.map(w=>w.id)).size===33&&pages.every(w=>w.id.startsWith('watcher/')))
  const exact=await rig.api('GET',`/api/orgs/${rig.org}/watchdogs?id=watcher%2Fwatch-33`)
  p.check('exact detail opens a dog outside the preview',exact.watchdogs.length===1&&exact.watchdogs[0].id==='watcher/watch-33'&&!exact.watchdogs[0].metadata_only)
  const other=await rig.api('POST','/api/orgs',{name:'Other watchdog inventory',net_autoconnect:false})
  const isolated=await rig.api('GET',`/api/orgs/${other.slug}/watchdogs?id=watcher%2Fwatch-33`)
  p.check('exact read never crosses orgs',isolated.watchdogs.length===0)
  // The existing one-per-owner/project/kind rule gives operational metadata
  // a separate topology bound, even when generic watcher previews are full.
  await rig.op({op:'create_project',name:'pipeline',parent:'watcher',description:'Synthetic listener target'})
  const listener=await rig.tool('watcher','orgtree_watchdog',{action:'create',name:'after-preview',kind:'project_listener',target:'pipeline',notice:true})
  p.check('project watcher beyond the preview creates',listener.ok,listener.text)
  const snap=await rig.waitFor(async()=>{
    const s=await rig.api('GET',`/api/orgs/${rig.org}/records`)
    const group=(s.records??[]).find(r=>r.entity==='org'&&r.id==='watchdogs')?.body
    return group?.watchdog_counts?.watcher?.total===34?group:null
  },{what:'bounded watchdog preview',timeout:10000})
  const preview=snap.watchdogs.filter(w=>w.owner==='watcher')
  p.check('tree first-eight preview has the authoritative complete count',preview.length===8&&snap.watchdog_counts.watcher.kept===34,{preview:preview.length,counts:snap.watchdog_counts.watcher})
  const linked=(snap.watchdog_project_links??[]).find(w=>w.id==='watcher/after-preview')
  p.check('project operational metadata survives outside generic previews',!!linked&&linked.metadata_only===true&&linked.kind==='project_listener'&&!preview.some(w=>w.id===linked.id))
  // SQL name allocation must retain the first-free suffix contract.
  const createClash=()=>rig.tool('watcher','orgtree_watchdog',{action:'create',name:'collision',kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true})
  const clash1=await createClash(),clash2=await createClash(),clash3=await createClash()
  await rig.tool('watcher','orgtree_watchdog',{action:'remove',id:'collision-2'})
  const reused=await createClash()
  p.check('bounded id allocation retains suffix order and fills gaps',clash1.ok&&clash2.json?.id==='collision-2'&&clash3.json?.id==='collision-3'&&reused.json?.id==='collision-2',{ids:[clash1.json?.id,clash2.json?.id,clash3.json?.id,reused.json?.id]})
  return p.summary()
}
