// Real scheduler must see eligible work beyond disconnected route backlogs.
import http from 'node:http'
import { Proof } from '../proof.mjs'
export async function setup() {
  return {fixture:{org:{name:'Transfer eligibility'},agents:[{name:'rhea',tier:'luna',grant:4}],
    scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}}
}
export default async function(rig) {
  const proof=new Proof('net-transfer-eligibility')
  let uploads=0,downloads=0
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost')
    const reply=data=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(data))}
    if(url.pathname==='/healthz') return reply({features:['uploads'],max_attachment_bytes:1073741824})
    if(url.pathname==='/api/uploads') {for await(const chunk of req){};return reply({id:'eligible',bytes:1024,offset:0,complete:false})}
    if(url.pathname==='/api/uploads/eligible') {
      let bytes=0;for await(const chunk of req) bytes+=chunk.length
      uploads++;return reply({id:'eligible',bytes:1024,offset:bytes,complete:true})
    }
    if(url.pathname==='/api/attachments/eligible') {
      downloads++;res.writeHead(200,{'content-length':1024,etag:'"eligible"'});res.end(Buffer.alloc(1024,120));return
    }
    res.writeHead(404);res.end()
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=`http://127.0.0.1:${server.address().port}`
  const call=args=>rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address,...args})
  try {
    await rig.op({op:'halt',nodes:['rhea']})
    const out=await call({action:'plan',bytes:1024})
    await call({action:'receive',message:{id:'eligible',from:'peer.rig',body:'Eligible download',attachments:[{id:'eligible',name:'proof.bin',bytes:1024}]}})
    // Use the real disposable database to stage route metadata unavailable in
    // the deliberately single-hub rig hook. No live hub or identity involved.
    rig.exec(`INSERT INTO ot.net_transfers(id,org_id,inbox_id,file_no,hub,address,source,total,next_at,created_at,updated_at)
      SELECT 'offline-out-'||n,t.org_id,t.inbox_id,100+n,
        CASE WHEN n<=60 THEN 'disconnected' ELSE t.hub END,
        CASE WHEN n<=60 THEN t.address ELSE 'http://127.0.0.1:1' END,t.source,t.total,
        now()-interval '1 hour',now()-interval '1 hour',now()-interval '1 hour'
      FROM ot.net_transfers t CROSS JOIN generate_series(1,120) n WHERE t.id='${out.id}';
      INSERT INTO ot.net_incoming(id,org_id,hub,address,net_id,envelope,next_at,created_at)
      SELECT 'offline-in-'||n,i.org_id,CASE WHEN n<=60 THEN 'disconnected' ELSE i.hub END,
        CASE WHEN n<=60 THEN i.address ELSE 'http://127.0.0.1:1' END,'offline-'||n,
        jsonb_build_object('id','offline-'||n,'from','offline-peer-'||n,'body','Disconnected'),
        now()-interval '1 hour',now()-interval '1 hour'
      FROM ot.net_incoming i CROSS JOIN generate_series(1,120) n WHERE i.net_id='eligible';`)
    proof.check('each direction has 120 earlier unavailable jobs',rig.one("SELECT count(*)::int AS n FROM ot.net_transfers WHERE id LIKE 'offline-out-%'").n===120 &&
      rig.one("SELECT count(*)::int AS n FROM ot.net_incoming WHERE id LIKE 'offline-in-%'").n===120)
    await call({action:'workers'})
    try {await rig.waitFor(()=>rig.one(`SELECT state FROM ot.net_transfers WHERE id='${out.id}'`).state==='complete' &&
      rig.one("SELECT state FROM ot.net_incoming WHERE net_id='eligible'").state==='complete',{timeout:10000,what:'eligible jobs beyond backlog'})} catch {}
    proof.check('upload progresses beyond disconnected backlog',rig.one(`SELECT state FROM ot.net_transfers WHERE id='${out.id}'`).state==='complete' && uploads===1)
    proof.check('download progresses beyond disconnected backlog',rig.one("SELECT state FROM ot.net_incoming WHERE net_id='eligible'").state==='complete' && downloads===1)
    proof.check('hub and address must match the same registered route',rig.one("SELECT count(*)::int AS n FROM ot.net_transfers WHERE id LIKE 'offline-out-%' AND attempt<>0").n===0 &&
      rig.one("SELECT count(*)::int AS n FROM ot.net_incoming WHERE id LIKE 'offline-in-%' AND attempt<>0").n===0)
    proof.keep(rig,{grep:/transfer|incoming|claim/})
    return proof.summary()
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
}
