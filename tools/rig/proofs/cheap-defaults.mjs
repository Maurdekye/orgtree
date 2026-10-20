// Synthetic database only. Restart replays migration 0045 over legacy rows.
import {Proof} from '../proof.mjs'
import fs from 'node:fs'
import path from 'node:path'
export async function setup() { return {name:'cheap-defaults',fixture:'none'} }
export default async function(rig) {
 const p=new Proof('cheap-defaults')
 const same=(a,b)=>a?.enabled===b.enabled&&a?.occ===b.occ
 const create=async name=>(await rig.api('POST','/api/orgs',{name,net_autoconnect:false})).slug
 const cfg=async slug=>(await rig.api('GET',`/api/orgs/${slug}`)).auto_cheap_compact
 p.check('fresh data root defaults ON', (await rig.api('GET','/api/defaults')).auto_cheap_compact?.enabled===true)
 const fresh=await create('Fresh default')
 p.check('new org defaults ON at 25%',same(await cfg(fresh),{enabled:true,occ:0.25}))
 await rig.waitFor(async()=>!(await rig.api('GET','/api/templates')).loading,{what:'synthetic sign-in check',timeout:30000})
 const templateDir=path.join(rig.data,'rig-home','.orgtree','templates')
 fs.mkdirSync(templateDir,{recursive:true})
 for(const [id,settings,want] of [
  ['cheap-inherit',{},true],['cheap-off',{auto_cheap_compact:{enabled:false,occ:0.4}},false],
 ]){
  fs.writeFileSync(path.join(templateDir,id+'.json'),JSON.stringify({id,name:id,agents:[{name:'template-agent',tier:'sol'}],settings}))
  const made=await rig.api('POST','/api/orgs',{name:id,net_autoconnect:false,template:{id}})
  p.check('template '+id+' preserves default or explicit choice',(await cfg(made.slug))?.enabled===want)
 }
 // Explicit org choices, partial/absent legacy settings and inactive orgs.
 const names=[]
 for(const name of ['Legacy absent','Legacy on','Legacy off','Legacy partial','Legacy null','Legacy inherited'])names.push(await create(name))
 const set=(slug,settings)=>rig.exec(`UPDATE ot.orgs SET settings='${JSON.stringify(settings)}'::jsonb WHERE slug='${slug}'`)
 set(names[0],{});set(names[1],{auto_cheap_compact:{enabled:true,occ:0.6}})
 set(names[2],{auto_cheap_compact:{enabled:false,occ:0.7}})
 set(names[3],{auto_cheap_compact:{occ:0.45}});set(names[4],{auto_cheap_compact:null});set(names[5],{})
 // First upgrade: no app default. Existing absent stays OFF, including trash.
 rig.exec(`UPDATE ot.orgs SET state='trashed' WHERE slug='${names[0]}';
   UPDATE ot.kv SET value=value-'defaults' WHERE key='app_settings';
   DELETE FROM public.ot_migrations WHERE name='0045_cheap_compact_default'`)
 await rig.restart()
 p.check('migration0045 registered and applied',rig.one("SELECT count(*)::int AS n FROM public.ot_migrations WHERE name='0045_cheap_compact_default'").n===1)
 const stored=slug=>rig.one(`SELECT settings->'auto_cheap_compact' AS cfg FROM ot.orgs WHERE slug='${slug}'`).cfg
 p.check('legacy absent pinned OFF even in trash',same(stored(names[0]),{enabled:false,occ:0.25}))
 p.check('legacy explicit ON preserved',same(stored(names[1]),{enabled:true,occ:0.6}))
 p.check('legacy explicit OFF preserved',same(stored(names[2]),{enabled:false,occ:0.7}))
 p.check('legacy partial preserves OFF and occupancy',same(stored(names[3]),{enabled:false,occ:0.45}))
 p.check('legacy null preserves OFF',stored(names[4])?.enabled===false)
 p.check('absent app default remains absent',!rig.one("SELECT value AS v FROM ot.kv WHERE key='app_settings'").v.defaults?.auto_cheap_compact)
 const after=await create('After upgrade')
 p.check('new org after upgrade defaults ON',(await cfg(after))?.enabled===true)
 // App default explicitly ON before upgrade must be snapshotted for unset orgs.
 await rig.api('POST','/api/defaults',{auto_cheap_compact:{enabled:true,occ:0.55}})
 set(names[5],{})
 rig.exec("DELETE FROM public.ot_migrations WHERE name='0045_cheap_compact_default'")
 await rig.restart()
 p.check('legacy inherited app ON and threshold preserved',same(stored(names[5]),{enabled:true,occ:0.55}))
 await rig.api('POST','/api/defaults',{auto_cheap_compact:{enabled:false,occ:0.35}})
 const off=await create('Explicit app off')
 p.check('explicit app OFF wins for new org',(await cfg(off))?.enabled===false)
 p.check('existing pinned ON ignores later app changes',(await cfg(names[5]))?.enabled===true)
 await rig.restart()
 p.check('repeated startup preserves explicit and migrated choices',stored(names[5])?.enabled===true&&stored(names[0])?.enabled===false)
 p.keep(rig,{grep:/migration|cheap.compact/})
 return p.summary()
}
