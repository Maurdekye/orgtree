import http from 'node:http'
import fs from 'node:fs'
import { Proof } from '../proof.mjs'

export async function setup() {
  return { fixture: { org: { name: 'Transfer downloads' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }],
    scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } }
}
export default async function(rig) {
  const proof=new Proof('net-transfer-download')
  const cases=new Map()
  const size=9*1024*1024
  const checkpoint=8*1024*1024
  const server=http.createServer((req,res)=>{
    const id=req.url.split('/').at(-1)
    const c=cases.get(id)
    if(!c){res.writeHead(404);res.end();return}
    c.calls.push({range:req.headers.range,validator:req.headers['if-range']})
    if(c.calls.length===1){
      res.writeHead(200,{'content-length':size,etag:'"original"'})
      c.response=res
      res.write(Buffer.alloc(checkpoint,120))
      return // withhold final MiB; checkpoint must survive restart/interruption
    }
    const ranged=!c.change && req.headers.range===`bytes=${checkpoint}-`
    res.writeHead(ranged?206:200,{'content-length':ranged?size-checkpoint:size,
      etag:c.change||c.bad?'"replacement"':'"original"',...(ranged?{'content-range':`bytes ${checkpoint}-${size-1}/${size}`}:{})})
    res.end(Buffer.alloc(ranged?size-checkpoint:size,c.change?121:120))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const address=`http://127.0.0.1:${server.address().port}`
  const call=args=>rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address,...args})
  const inbox=id=>rig.sql(`SELECT * FROM ot.org_inbox WHERE net_id='${id}' AND dir='in'`)
  const file=id=>rig.one(`SELECT d.* FROM ot.net_downloads d JOIN ot.net_incoming i ON i.id=d.incoming_id WHERE i.net_id='${id}'`)
  try {
    await rig.op({op:'halt',nodes:['rhea']})
    for(const change of [false,true,'cancel','bad-range']) {
      const id=change==='bad-range'?'bad-range':change==='cancel'?'cancel-bytes':change?'changed-bytes':'resume-bytes'
      const c={change:change===true,bad:change==='bad-range',calls:[]};cases.set(id,c)
      const message={id,from:'peer.rig',body:'Download proof',attachments:[{id,name:'proof.bin',bytes:size}]}
      const result=await call({action:'receive',message})
      proof.check(`${id}: durable custody acknowledged without early message delivery`,result.ack===id && inbox(id).length===0)
      await call({action:'workers'})
      await rig.waitFor(()=>file(id)?.confirmed===checkpoint,{what:`${id} download checkpoint`,timeout:30000})
      proof.check(`${id}: bytes stay hidden until every file is ready`,inbox(id).length===0 && rig.sql(`SELECT id FROM ot.mail WHERE net_id='${id}'`).length===0)
      if(!change) {
        await call({action:'receive',message:{id:'ordinary',from:'other.rig',body:'Ordinary mail while download waits'}})
        proof.check('ordinary text mail remains responsive during a stalled download',inbox('ordinary').length===1)
        await call({action:'receive',message:{id:'same-peer-later',from:'peer.rig',body:'Ordered after file'}})
        proof.check('later text from the same peer waits behind its unfinished file',inbox('same-peer-later').length===0)
        await rig.restart()
        c.response.destroy()
        await call({action:'workers'})
      } else if(change==='cancel') {
        proof.check('successful downloads produce no failure notifications',rig.sql('SELECT id FROM ot.net_transfer_failures').length===0)
        const job=rig.one(`SELECT id FROM ot.net_incoming WHERE net_id='${id}'`)
        const tool=await rig.tool('rhea','orgtree_transfers',{action:'get',id:job.id})
        proof.check('outside inbox holder can inspect incoming checkpoint',tool.ok && tool.json.transfers[0].files[0].confirmed===checkpoint,tool)
        const stopped=await rig.tool('rhea','orgtree_transfers',{action:'cancel',id:job.id})
        proof.check('holder cancellation persists intent without exposing partial mail',stopped.ok && stopped.json.transfers[0].state==='cancelled' && inbox(id).length===0,stopped)
        await rig.waitFor(async()=>{
          const retried=await rig.tool('rhea','orgtree_transfers',{action:'retry',id:job.id})
          return retried.ok
        },{what:'stopped download available for explicit retry',timeout:10000})
        c.response.destroy()
      } else if(change==='bad-range') {
        c.response.destroy()
        await rig.waitFor(()=>rig.one(`SELECT state FROM ot.net_incoming WHERE net_id='${id}'`).state==='failed',{what:'reject changed validator on partial response',timeout:30000})
        proof.check('changed validator in 206 never exposes mixed bytes',inbox(id).length===0 && file(id).confirmed===0)
        c.bad=false
        const job=rig.one(`SELECT id FROM ot.net_incoming WHERE net_id='${id}'`)
        await rig.api('POST',`/api/orgs/${rig.org}/transfers/${job.id}`,{action:'retry'})
      } else c.response.destroy()
      await rig.waitFor(()=>inbox(id).length===1,{what:`${id} delivered after completed bytes`,timeout:30000})
      if(!change) {
        await rig.waitFor(()=>inbox('same-peer-later').length===1,{what:'same peer ordering after download',timeout:30000})
        proof.check('later same-peer message delivers after original file message',inbox(id)[0].id<inbox('same-peer-later')[0].id)
      }
      const f=file(id)
      const bytes=fs.readFileSync(f.path)
      proof.check(`${id}: Range and If-Range reconcile checkpoint`,c.calls[1]?.range===`bytes=${checkpoint}-` && c.calls[1]?.validator==='"original"',c.calls)
      proof.check(`${id}: final contents and completed state match`,bytes.length===size && bytes.every(v=>v===(change===true?121:120)) && f.complete && f.confirmed===size)
      proof.check(`${id}: inbox has usable file and holder mail only after completion`,inbox(id)[0].attachments[0].path===f.path && rig.sql(`SELECT id FROM ot.mail WHERE net_id='${id}'`).length===1)
      await call({action:'receive',message})
      proof.check(`${id}: repeated envelope does not duplicate delivery`,inbox(id).length===1 && rig.sql(`SELECT id FROM ot.mail WHERE net_id='${id}'`).length===1)
    }
    proof.keep(rig,{grep:/incoming|download|transfer/})
    proof.note('Real engine, PostgreSQL, streamed loopback HTTP and engine restart. Incoming holder inspection/cancel/retry measured; renderer/failure notifications and device/1GiB/hard-kill proof remain.')
    return proof.summary()
  } finally {
    server.closeAllConnections()
    await new Promise(resolve=>server.close(resolve))
  }
}
