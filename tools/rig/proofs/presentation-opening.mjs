import assert from 'node:assert/strict'
import fs from 'node:fs'
import { Proof } from '../proof.mjs'

export default async function(rig){
 const p=new Proof('presentation-opening')
 rig.scenario({default:{turns:[{name:'default',steps:[{text:'OK.'}]}]}})
 const org=rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
 const agent=rig.one(`SELECT id FROM ot.agents WHERE org_id=${org} AND name='boss'`).id
 rig.sql(`INSERT INTO ot.documents(uid,org_id,agent_id,node_name,title,body,at,viewed_at)
   SELECT 'opening-'||n,${org},${agent},'boss','Synthetic presentation '||n,'body '||n,
     '2026-10-01'::timestamptz+n*interval '1 minute','2026-10-01'::timestamptz+n*interval '1 minute'
   FROM generate_series(1,130) n;
   UPDATE ot.documents SET viewed_at=NULL WHERE uid='opening-3';
   UPDATE ot.documents SET at='2026-10-20' WHERE uid='opening-4';`)
 const route=`/api/orgs/${rig.org}/documents?limit=40&opening=1&hired=1`
 const first=await rig.api('GET',route)
 p.check('opening locates oldest unread beyond40 without a prefix read',first.opening_id==='opening-3'&&first.opening_position>=120&&first.documents.length<=40&&first.offset>=120&&first.documents.some(r=>r.id==='opening-3'),first)
 const scoped=await rig.api('GET',route+'&node=boss')
 p.check('agent opening uses same scoped target',scoped.opening_id==='opening-3'&&scoped.documents.length<=40,scoped)
 await rig.api('POST',`/api/orgs/${rig.org}/documents/viewed`,{marks:[{id:'opening-3',at:'2026-10-01T00:03:00Z'}]})
 const changed=await rig.api('GET',route)
 p.check('opening after mark chooses next changed document',changed.opening_id==='opening-4',changed)
 rig.sql(`UPDATE ot.documents SET viewed_at=at WHERE org_id=${org}`)
 const read=await rig.api('GET',route)
 p.check('all-read fallback uses replacement time rather than row identity',read.opening_id==='opening-4',read)
 const explicit=await rig.api('GET',route+'&locate=opening-130')
 p.check('explicit locate overrides auto-open decision',explicit.located==='opening-130'&&explicit.opening_id===undefined,explicit)
 assert.equal(p.summary().passed,true)
 fs.writeFileSync(rig.dir+'/presentation-opening-response.json',JSON.stringify({first,scoped,changed,read,explicit},null,2))
 return p.summary()
}
