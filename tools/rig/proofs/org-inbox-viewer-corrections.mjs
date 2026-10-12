// Bounded legacy upload-log/cleanup proof: no renderer, provider or live hub.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { Proof } from '../proof.mjs'
import { retainedInboxUpload } from './fixtures/retained-inbox-upload.mjs'
export function setup() { return { fixture: { org: { name: 'Viewer corrections' }, agents: [{ name: 'rhea', tier: 'luna', grant: 4 }], scenario: { default: { turns: [{ steps: [{ text: 'OK.' }] }] } } } } }
export default async function(rig) {
  const p = new Proof('org-inbox-viewer-corrections')
  await rig.op({op:'halt',nodes:['rhea']})
  const start = rig.engineLog().length
  const run = crypto.randomUUID()
  const uploadMarkers = []
  for (const [index, type] of ['text/plain','image/png','application/pdf','application/octet-stream'].entries()) {
    const marker = `LEGACY_UPLOAD_PRIVATE_${index}_${run}`
    uploadMarkers.push(marker)
    const r = await fetch(`${rig.url}/api/orgs/${rig.org}/org_inbox/staging/retired-${index}`, {
      method:'POST',headers:{'X-Orgtree-Desktop-Token':rig.token,'Content-Type':type},body:marker,
    })
    p.check(`retired ${type} upload still404`, r.status===404, {status:r.status,bytes:marker.length})
  }
  const unauthorized = 'LEGACY_UPLOAD_UNAUTHORIZED_'+run
  uploadMarkers.push(unauthorized)
  const denied = await fetch(`${rig.url}/api/orgs/${rig.org}/org_inbox/staging/retired-denied`, {
    method:'POST',headers:{'Content-Type':'text/plain'},body:unauthorized,
  })
  p.check('missing-token legacy upload remains403',denied.status===403)
  const safe = 'ORDINARY_SAFE_BODY_CONTROL_'+run
  const control = await fetch(`${rig.url}/api/orgs/${rig.org}/ordinary-log-control`,{
    method:'POST',headers:{'X-Orgtree-Desktop-Token':rig.token,'Content-Type':'text/plain'},body:safe,
  })
  p.check('ordinary nonexistent route still404',control.status===404)
  await rig.waitFor(()=>rig.engineLog().includes(safe),{what:'safe request log control',timeout:5000})
  const log = rig.engineLog().slice(start)
  for (const marker of uploadMarkers) p.check('upload payload absent from logs: '+marker.split('_')[3],!log.includes(marker))
  p.check('retired upload REQUEST has explicit body omission',/REQUEST.*org_inbox\/staging\/retired-0.*\[body omitted\]/.test(log))
  p.check('ordinary non-upload body logging remains',log.includes(safe))
  p.file('request-interval.log',log)

  // Safe-start rigs do not start the transfer scheduler automatically. Its
  // existing offline worker adapter starts the actual sweep/dispatcher. There
  // are no transport jobs and the synthetic loopback address is never used.
  await rig.api('POST','/api/rig/hub-mail',{org:rig.org,op:'transfer',action:'workers',address:'http://127.0.0.1:1'})
  // Settle legacy interrupted/expired rows, with one draft notice and a
  // completed custody control, through those unchanged production functions.
  const org = rig.one(`SELECT id FROM ot.orgs WHERE slug='${rig.org}'`).id
  const quote = value => "'"+String(value).replaceAll("'","''")+"'"
  const complete = retainedInboxUpload(rig,rig.org,'completed.txt','COMPLETED_LEGACY_BYTES')
  rig.exec(`INSERT INTO ot.upload_stages(id,org_id,name,path,total,received,state,draft) VALUES(${quote(complete.id)},${org},'completed.txt',${quote(complete.path)},${complete.bytes},${complete.bytes},'complete','completed-control')`)
  const files = ['uploading','queued'].map((state,index)=>{
    const id='legacy-correction-'+index+'-'+run
    const file=path.join(rig.data,'uploads',rig.org,'@org-inbox',id+'-partial.txt')
    fs.writeFileSync(file,'PARTIAL_LEGACY_BYTES')
    rig.exec(`INSERT INTO ot.upload_stages(id,org_id,name,path,total,received,state,draft,updated_at) VALUES(${quote(id)},${org},${quote('legacy-'+state+'.txt')},${quote(file)},100,20,${quote(state)},${quote('one-draft-'+run)},now()-interval '25 hours')`)
    return {id,file}
  })
  await rig.waitFor(()=>files.every(f=>rig.one(`SELECT state,cleaned_at FROM ot.upload_stages WHERE id=${quote(f.id)}`)?.cleaned_at),{what:'legacy partial cleanup',timeout:15000})
  await rig.waitFor(()=>rig.one(`SELECT count(*) AS n FROM ot.mail m JOIN ot.net_transfer_failures f ON m.extra->>'transfer_failure'=f.id WHERE f.message_key=${quote('stage:'+org+':one-draft-'+run)}`)?.n===1,{what:'one legacy draft failure notice',timeout:15000})
  const notices=rig.sql(`SELECT m.body,m.recipient_kind,m.notice FROM ot.mail m JOIN ot.net_transfer_failures f ON m.extra->>'transfer_failure'=f.id WHERE f.message_key=${quote('stage:'+org+':one-draft-'+run)}`)
  p.check('legacy failures notify user once without agent copies',notices.length===1&&notices[0].recipient_kind==='user'&&notices[0].notice===true,notices)
  p.check('legacy notice names canonical human retry and actual upload outcome',notices.every(m=>/Hubchat/.test(m.body)&&/interrupted|expired/i.test(m.body)),notices)
  p.check('legacy notice no longer names removed controls or asserts message admission',notices.every(m=>!/(Saved local files|mail composer|No message was sent)/i.test(m.body)))
  p.check('interrupted and expired stages keep failure/cleanup outcomes',files.every(f=>rig.one(`SELECT state FROM ot.upload_stages WHERE id=${quote(f.id)}`).state==='failed'&&!fs.existsSync(f.file)))
  p.check('completed legacy custody untouched',fs.readFileSync(complete.path,'utf8')==='COMPLETED_LEGACY_BYTES'&&rig.one(`SELECT state,cleaned_at FROM ot.upload_stages WHERE id=${quote(complete.id)}`).state==='complete'&&rig.one(`SELECT id FROM ot.uploads WHERE id=${quote(complete.id)}`)?.id===complete.id)
  p.file('notices.json',notices)
  return p.summary()
}
