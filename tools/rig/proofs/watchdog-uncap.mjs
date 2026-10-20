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
  for(let i=1;i<=33;i++) made.push(await rig.tool('watcher','orgtree_watchdog',{
    action:'create',name:'watch-'+i,kind:'file',target:'quiet.log',pattern:'NEVER',interval_s:600,notice:true,
  }))
  p.check('control: the first eight real creates succeed',made.slice(0,8).every(r=>r.ok))
  p.check('the ninth create succeeds',made[8].ok,{result:made[8].text})
  p.check('the thirty-third create succeeds beyond both former limits',made[32].ok,{result:made[32].text})
  const rows=rig.sql("SELECT w.uid FROM ot.watchdogs w JOIN ot.agents a ON a.id=w.owner_agent_id WHERE a.name='watcher' AND w.state='armed' ORDER BY w.id")
  p.check('all 33 watchdogs persist armed',rows.length===33,{count:rows.length})
  return p.summary()
}
