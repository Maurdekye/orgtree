import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Proof } from '../proof.mjs'
import { runDesktop } from '../desktop.mjs'
import { TOKEN_HEADER } from '../lib.mjs'
export async function setup() {
  return {fixture:{org:{name:'Local staging'},agents:[{name:'rhea',tier:'luna',grant:4}],scenario:{default:{turns:[{steps:[{text:'OK.'}]}]}}}}
}
export default async function(rig) {
  const proof=new Proof('local-staging')
  const base=()=>`/api/orgs/${rig.org}/org_inbox/staging`
  const start=bytes=>rig.api('POST',base(),{name:'stage.bin',bytes,to:'@org:test'})
  const get=id=>rig.api('GET',`${base()}/${id}`)
  const body=(id,bytes)=>fetch(rig.url+`${base()}/${id}`,{method:'POST',headers:{[TOKEN_HEADER]:rig.token},body:bytes})
  const requests=[]
  const hold=id=>{
    const request=http.request(rig.url+`${base()}/${id}`,{method:'POST',headers:{[TOKEN_HEADER]:rig.token,'Transfer-Encoding':'chunked'}})
    request.on('error',()=>{}); request.on('response',res=>res.resume()); request.write(Buffer.alloc(4,1)); requests.push(request); return request
  }
  const hub=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({max_attachment_bytes:1073741824,features:['uploads']}))})
  await new Promise(resolve=>hub.listen(0,'127.0.0.1',resolve))
  try {
    const t=await start(8)
    proof.check('ticket exists before bytes and cannot be sent as a completed attachment',(await get(t.id)).state==='queued' && rig.sql(`SELECT id FROM ot.uploads WHERE id='${t.id}'`).length===0)
    const early=await rig.api('POST',`/api/orgs/${rig.org}/org_inbox/send`,{to:'@org:test',body:'Held',attachments:[t.id]}).catch(e=>e)
    proof.check('send endpoint refuses an unfinished ticket',early.status===422 && /staged attachment/.test(early.message))
    const excess=await rig.api('POST',`/api/orgs/${rig.org}/org_inbox/send`,{to:'@org:test',body:'Held',attachments:Array(11).fill(t.id)}).catch(e=>e)
    proof.check('too many attachments are refused rather than silently truncated',excess.status===400 && /at most 10/.test(excess.message))
    hold(t.id)
    await rig.waitFor(async()=> (await get(t.id)).state==='uploading',{what:'staging writer',timeout:10000})
    const duplicate=await body(t.id,Buffer.alloc(8))
    proof.check('one writer per local staging ticket',duplicate.status===409)
    await rig.api('DELETE',`${base()}/${t.id}`)
    await rig.waitFor(()=>!fs.existsSync(rig.one(`SELECT path FROM ot.upload_stages WHERE id='${t.id}'`).path),{what:'cancelled partial removed',timeout:10000})
    proof.check('cancel interrupts stalled request and never publishes a partial',(await get(t.id)).state==='cancelled' && rig.sql(`SELECT id FROM ot.uploads WHERE id='${t.id}'`).length===0)
    const done=await start(4)
    const res=await body(done.id,Buffer.from('abcd')); await res.text() // Ignore response contents: recover through GET.
    await rig.restart()
    const complete=await get(done.id)
    const saved=rig.one(`SELECT path,bytes FROM ot.uploads WHERE id='${done.id}'`)
    proof.check('completed ticket survives restart and lost completion response',complete.state==='complete' && saved.bytes===4 && fs.readFileSync(saved.path,'utf8')==='abcd')
    const short=await start(8); const shortRes=await body(short.id,Buffer.alloc(2)); await shortRes.text()
    proof.check('short body fails without exposing an attachment',shortRes.status===400 && (await get(short.id)).state==='failed' && rig.sql(`SELECT id FROM ot.uploads WHERE id='${short.id}'`).length===0)
    const crashed=await start(8); hold(crashed.id)
    await rig.waitFor(async()=> (await get(crashed.id)).state==='uploading',{what:'writer before restart'})
    await rig.restart()
    proof.check('interrupted staging requires re-selection after restart',(await get(crashed.id)).state==='failed' && rig.sql(`SELECT id FROM ot.uploads WHERE id='${crashed.id}'`).length===0)
    await rig.op({op:'halt',nodes:['rhea']})
    const call=args=>rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',address:`http://127.0.0.1:${hub.address().port}`,...args})
    await call({action:'receive',message:{id:'stage-reply',from:'peer.rig',body:'Reply staging target'}})
    await call({action:'workers'})
    const ui=await runDesktop(rig,path.join(path.dirname(fileURLToPath(import.meta.url)),'../desktop/local-staging.cjs'),{out:path.join(proof.dir,'desktop'),timeout:90000})
    proof.file('desktop-result.json',ui)
    proof.check('compose and reply display staging and block premature send',ui.ok,ui.error??ui.value)
    proof.check('premature Enter never queued a message',rig.sql("SELECT id FROM ot.org_inbox WHERE dir='out'").length===0)
    proof.keep(rig,{grep:/staging|ERROR/}); return proof.summary()
  } finally { for(const r of requests) r.destroy(); hub.closeAllConnections(); await new Promise(resolve=>hub.close(resolve)) }
}
