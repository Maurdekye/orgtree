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
  const start=(bytes,draft='')=>rig.api('POST',base(),{name:'stage.bin',bytes,to:'@org:test',draft})
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
    proof.check('a fresh browser can reattach a completed ticket without uploading again',ui.ok && ui.value?.recoveredAfterReload)
    const listed=await rig.api('GET',base())
    proof.check('saved listing exposes metadata, never local paths',listed.files.some(f=>f.id===done.id) && listed.files.every(f=>!('path' in f)))
    await rig.api('POST',`${base()}/${done.id}/dismiss`,{})
    proof.check('dismissal hides only the saved entry and keeps published bytes',!(await rig.api('GET',base())).files.some(f=>f.id===done.id) && fs.readFileSync(saved.path,'utf8')==='abcd')
    const group='one-draft-two-failures'
    const a=await start(9,group), b=await start(9,group)
    for(const item of [a,b]) {const r=await body(item.id,Buffer.alloc(1));await r.text();await get(item.id)}
    await rig.api('DELETE',`${base()}/${a.id}`)
    await call({action:'notifications'})
    const failure=rig.one(`SELECT id FROM ot.net_transfer_failures WHERE message_key LIKE '%:${group}'`)
    const failureMail=()=>rig.sql(`SELECT recipient_kind FROM ot.mail WHERE extra->>'transfer_failure'='${failure.id}'`)
    proof.check('two failed draft files create one user notice, no agent mail, and retain their failure',failureMail().length===1 && failureMail()[0].recipient_kind==='user' && (await get(a.id)).state==='failed')
    await rig.restart(); await call({action:'workers'}); await call({action:'notifications'})
    proof.check('failure notice remains deduplicated across restart',failureMail().length===1)
    const pending=await start(8,'active-writer');hold(pending.id)
    await rig.waitFor(async()=> (await get(pending.id)).state==='uploading',{what:'writer for expiry race'})
    rig.exec(`UPDATE ot.upload_stages SET updated_at=now()-interval '25 hours' WHERE id='${pending.id}'`)
    const expired=[]
    for(let i=0;i<36;i++) expired.push(await start(8,'expired-draft'))
    rig.exec(`UPDATE ot.upload_stages SET updated_at=now()-interval '25 hours' WHERE id IN (${expired.map(x=>`'${x.id}'`).join(',')})`)
    const partialPath=rig.one(`SELECT path FROM ot.upload_stages WHERE id='${expired[0].id}'`).path
    fs.writeFileSync(partialPath,Buffer.from('partial'))
    await rig.waitFor(()=>rig.one("SELECT count(*)::int n FROM ot.upload_stages WHERE draft='expired-draft' AND state='failed' AND cleaned_at IS NOT NULL").n===36,{what:'bounded background expiry across pages',timeout:45000})
    proof.check('background cleanup reaches more than one batch without GET and removes partial bytes',!fs.existsSync(partialPath))
    proof.check('expiry never steals a live writer',(await get(pending.id)).state==='uploading')
    await rig.api('DELETE',`${base()}/${pending.id}`)
    await call({action:'notifications'})
    proof.check('explicit cancellation and successful completion stay silent',rig.sql(`SELECT id FROM ot.net_transfer_failures WHERE detail->>'transfer_id' IN ('${pending.id}','${t.id}','${done.id}')`).length===0)
    const pages=[];let after=''
    do {const page=await rig.api('GET',`${base()}?after=${after}`);pages.push(...page.files);after=page.next||''} while(after)
    proof.check('saved tickets remain discoverable beyond the first page',expired.every(x=>pages.some(y=>y.id===x.id)))
    proof.keep(rig,{grep:/staging|ERROR/}); return proof.summary()
  } finally { for(const r of requests) r.destroy(); hub.closeAllConnections(); await new Promise(resolve=>hub.close(resolve)) }
}
