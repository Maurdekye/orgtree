// Regression boundaries identified by independent review of f9c6fd9.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Transfer recovery review',settings:{org_inbox_multi_holder:true}},
    agents:[{name:'rhea',tier:'luna',grant:4},{name:'bob',tier:'luna',grant:4}],
    scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}}
}
export default async function(rig) {
  const proof=new Proof('net-transfer-review')
  const calls=[], size=8*1024*1024
  const server=http.createServer(async(req,res)=>{
    calls.push({url:req.url,range:req.headers.range,validator:req.headers['if-range']})
    const json=data=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data))}
    if(req.url==='/api/attachments/eof') {
      if(req.headers.range===`bytes=${size-1}-`) {
        res.writeHead(206,{'content-length':1,'content-range':`bytes ${size-1}-${size-1}/${size}`,etag:'"original"'});res.end('x')
      } else {res.writeHead(416,{'content-range':`bytes */${size}`});res.end()}
      return
    }
    if(req.url==='/api/attachments/fanout') {res.writeHead(200,{'content-length':1024,etag:'"fanout"'});res.end(Buffer.alloc(1024,120));return}
    if(req.url==='/healthz') return json({features:['uploads'],max_attachment_bytes:1073741824})
    if(req.url==='/api/uploads' && req.method==='POST') {for await(const chunk of req){};return json({id:'healthy',bytes:1024,offset:0,complete:false})}
    if(req.url.startsWith('/api/uploads/healthy')) {
      if(req.method==='GET') return json({id:'healthy',bytes:1024,offset:0,complete:false})
      let n=0;for await(const chunk of req) n+=chunk.length
      return json({id:'healthy',bytes:1024,offset:n,complete:true})
    }
    if(req.url==='/api/send') {for await(const chunk of req){};return json({id:'sent'})}
    res.writeHead(404);res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=`http://127.0.0.1:${server.address().port}`
  const call=args=>rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address,...args})
  try {
    await rig.op({op:'halt',nodes:['rhea','bob']})
    const sender=rig.one("SELECT id,generation FROM ot.agents WHERE name='rhea'")
    const other=rig.one("SELECT id FROM ot.agents WHERE name='bob'")
    const plan=await call({action:'plan',by:'rhea',missing:true,unbound:true})
    proof.check('other existing agent cannot inspect sender transfer',!(await rig.tool('bob','orgtree_transfers',{action:'get',id:plan.id})).ok)
    await rig.op({op:'rename',node:'rhea',name:'old-rhea'})
    await rig.op({op:'rename',node:'bob',name:'rhea'})
    proof.check('taking the sender name grants neither inspection nor cancellation',
      !(await rig.tool('rhea','orgtree_transfers',{action:'get',id:plan.id})).ok &&
      !(await rig.tool('rhea','orgtree_transfers',{action:'cancel',id:plan.id})).ok)
    proof.check('renamed original sender retains control', (await rig.tool('old-rhea','orgtree_transfers',{action:'cancel',id:plan.id})).ok)
    await call({action:'notifications'})
    const notices=rig.sql(`SELECT recipient_kind,recipient_agent_id FROM ot.mail WHERE extra->>'transfer_id'='${plan.id}'`)
    proof.check('failure follows stable sender identity, never its former name',notices.length===2 && notices.some(m=>m.recipient_agent_id===sender.id) && !notices.some(m=>m.recipient_agent_id===other.id),notices)
    rig.exec(`UPDATE ot.org_inbox SET peer='@net:held-sender.rig' WHERE id=${plan.inbox}`)
    await call({action:'receive',message:{id:'review-eof',from:'eof.rig',body:'EOF checkpoint',attachments:[{id:'eof',name:'eof.bin',bytes:size}]}})
    const eof=rig.one("SELECT d.* FROM ot.net_downloads d JOIN ot.net_incoming n ON n.id=d.incoming_id WHERE n.net_id='review-eof'")
    fs.mkdirSync(path.dirname(eof.path),{recursive:true});fs.writeFileSync(eof.path,Buffer.alloc(size,120))
    rig.exec(`UPDATE ot.net_downloads SET confirmed=${size},processed=${size},validator='"original"',complete=false WHERE id='${eof.id}'`)
    // Inject failure on the second holder after the first insert in the same
    // publication. Both mail copies AND the org inbox must roll back.
    rig.exec(`INSERT INTO ot.audiences(org_id,grantee,grantor) SELECT org_id,name,'@extern' FROM ot.agents WHERE id IN (${sender.id},${other.id}) AND NOT EXISTS(SELECT 1 FROM ot.audiences x WHERE x.org_id=ot.agents.org_id AND x.grantee=ot.agents.name AND x.grantor='@extern' AND x.revoked_at IS NULL);
      ALTER TABLE ot.mail ADD CONSTRAINT proof_fanout CHECK(net_id IS DISTINCT FROM 'review-fanout' OR recipient_agent_id<>${other.id})`)
    await call({action:'receive',message:{id:'review-fanout',from:'fanout.rig',body:'Atomic holder delivery',attachments:[{id:'fanout',name:'fanout.bin',bytes:1024}]}})
    await call({action:'workers'})
    await rig.waitFor(()=>rig.one("SELECT state FROM ot.net_incoming WHERE net_id='review-fanout'").state==='retry_wait',{what:'fanout storage failure',timeout:15000})
    proof.check('holder insert failure rolls back inbox and every holder copy',rig.sql("SELECT id FROM ot.org_inbox WHERE net_id='review-fanout'").length===0 && rig.sql("SELECT id FROM ot.mail WHERE net_id='review-fanout'").length===0)
    rig.exec('ALTER TABLE ot.mail DROP CONSTRAINT proof_fanout')
    await rig.restart()
    await call({action:'workers'})
    await rig.waitFor(()=>rig.one("SELECT state FROM ot.net_incoming WHERE net_id='review-fanout'").state==='complete' && rig.one("SELECT state FROM ot.net_incoming WHERE net_id='review-eof'").state==='complete',{what:'restart finishes fanout and EOF checkpoint',timeout:15000})
    proof.check('restart publishes inbox and both holders exactly once',rig.sql("SELECT id FROM ot.org_inbox WHERE net_id='review-fanout'").length===1 && rig.sql("SELECT id FROM ot.mail WHERE net_id='review-fanout'").length===2)
    const recovered=rig.one(`SELECT * FROM ot.net_downloads WHERE id='${eof.id}'`)
    const eofCalls=calls.filter(c=>c.url==='/api/attachments/eof')
    proof.check('EOF checkpoint revalidates final byte and finishes without 416 loop',recovered.complete && recovered.confirmed===size && eofCalls.length===1 && eofCalls[0].range===`bytes=${size-1}-` && eofCalls[0].validator==='"original"',eofCalls)
    proof.check('EOF recovery preserves exact file contents',fs.readFileSync(eof.path).every(b=>b===120) && fs.statSync(eof.path).size===size)
    // Stage a crash after publication but before the transport's final marker.
    rig.exec("UPDATE ot.net_incoming SET state='delivering' WHERE net_id='review-fanout'")
    await rig.restart();await call({action:'workers'})
    await rig.waitFor(()=>rig.one("SELECT state FROM ot.net_incoming WHERE net_id='review-fanout'").state==='complete',{what:'replay committed fanout',timeout:15000})
    proof.check('replay after publication never duplicates either holder',rig.sql("SELECT id FROM ot.mail WHERE net_id='review-fanout'").length===2)
    // More than one page of distinct held/disconnected peers, BEFORE a new
    // healthy peer's unbound jobs. Exercise admission, not only worker claim.
    rig.exec(`WITH made AS (
      INSERT INTO ot.org_inbox(uid,org_id,dir,peer,body,state,net_id,attachments,hub)
      SELECT 'held-'||n,i.org_id,'out','@net:held-'||n,'Held','queued','held-net-'||n,i.attachments,
        CASE WHEN n%2=0 THEN 'unavailable' ELSE NULL END
      FROM ot.org_inbox i CROSS JOIN generate_series(1,150) n WHERE i.id=${plan.inbox} RETURNING id,org_id,uid)
      INSERT INTO ot.net_transfers(id,org_id,inbox_id,file_no,hub,address,source,total,state)
      SELECT m.uid,m.org_id,m.id,0,'','',t.source,t.total,'cancelled' FROM made m CROSS JOIN ot.net_transfers t WHERE t.id='${plan.id}'`)
    const healthy=await call({action:'plan',bytes:1024,unbound:true})
    proof.check('healthy transfer starts unbound behind 150 held peer heads',rig.one(`SELECT hub,address FROM ot.net_transfers WHERE id='${healthy.id}'`).hub==='')
    for(let n=0;n<3;n++) await call({action:'drain'})
    proof.check('bounded admission advances beyond held and unavailable peers',rig.one(`SELECT hub FROM ot.net_transfers WHERE id='${healthy.id}'`).hub==='rig-transfer')
    await call({action:'workers'})
    await rig.waitFor(async()=>{await call({action:'drain'});return rig.one(`SELECT state FROM ot.org_inbox WHERE id=${healthy.inbox}`).state==='sent'},{what:'healthy later peer sends',timeout:15000})
    proof.check('healthy later peer sends while earlier held messages stay queued',rig.one("SELECT count(*)::int AS n FROM ot.org_inbox WHERE uid LIKE 'held-%' AND state='queued'").n===150)
    proof.keep(rig,{grep:/transfer|incoming|fanout/})
    proof.note('Four review findings exercised through real engine/DB/HTTP. Restart boundaries staged, not a physical power-loss test. No live sign-ins or real hub.')
    return proof.summary()
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
