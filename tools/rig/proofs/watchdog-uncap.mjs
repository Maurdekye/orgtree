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
  return p.summary()
}
