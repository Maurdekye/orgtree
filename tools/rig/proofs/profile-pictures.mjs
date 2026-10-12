// Real isolated engine + hosted hub; no provider, live identity or message.
import crypto from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { Proof } from '../proof.mjs'
export function setup(flags) { return { hub: flags.hub ?? true, fixture: { org: { name: 'Picture proof' }, agents: [] } } }
function crc(bytes) { let c=0xffffffff; for(const b of bytes) {c^=b; for(let i=0;i<8;i++) c=(c>>>1)^((c&1)?0xedb88320:0)} return (c^0xffffffff)>>>0 }
function chunk(name,bytes) {const type=Buffer.from(name),n=Buffer.alloc(4),sum=Buffer.alloc(4);n.writeUInt32BE(bytes.length);sum.writeUInt32BE(crc(Buffer.concat([type,bytes])));return Buffer.concat([n,type,bytes,sum])}
function png() {const h=Buffer.alloc(13);h.writeUInt32BE(2);h.writeUInt32BE(2,4);h[8]=8;h[9]=6;return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0,255,0,255,0,255,0,0,0,255,255,30,50,70,255]))),chunk('IEND',Buffer.alloc(0))])}
export default async function(rig) {
  const p=new Proof('profile-pictures')
  const route=`/api/orgs/${rig.org}/profile-picture`
  const first=await rig.api('GET',route), owner=first.owner
  const call=(path,body)=>rig.api('POST',path,body)
  const attempt=(path,body)=>call(path,body).then(value=>({ok:true,value}),e=>({ok:false,status:e.status}))
  const raw=png().toString('base64')
  const counts=()=>rig.one('SELECT (SELECT count(*) FROM ot.mail) AS mail,(SELECT count(*) FROM ot.org_inbox) AS inbox')
  const initialCounts=counts()
  p.check('fresh organization has owner-bound absence',Number.isInteger(owner)&&first.picture===null)
  const preview=await call(route+'/preview',{data:raw})
  p.check('native preview returns bounded PNG',preview.width===2&&preview.height===2&&Buffer.from(preview.data,'base64').subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))
  const saved=await call(route,{owner,data:raw,crop:{x:.5,y:.5,size:1}})
  p.check('native crop stored normalized square and valid digest',saved.width===2&&saved.height===2&&saved.bytes<=256*1024&&saved.sha256===crypto.createHash('sha256').update(Buffer.from(saved.data,'base64')).digest('hex'))
  p.check('GET reads exact durable record',JSON.stringify((await rig.api('GET',route)).picture)===JSON.stringify(saved))
  const wrong=await attempt(route,{owner:owner+100,data:null})
  p.check('wrong numeric org owner cannot remove picture',!wrong.ok&&wrong.status===409)
  const marker='PICTURE_PRIVATE_BODY_'+crypto.randomBytes(12).toString('hex')
  const bad=await attempt(route+'/preview',{data:marker})
  p.check('malformed input refused',!bad.ok&&bad.status===422)
  const badCrop=await attempt(route,{owner,data:raw,crop:{x:2,y:0,size:1}})
  p.check('invalid crop cannot modify stored picture',!badCrop.ok&&(await rig.api('GET',route)).picture.revision===saved.revision)
  const big=await attempt(route+'/preview',{data:'A'.repeat(Math.ceil(5*1024*1024/3)*4+4)})
  p.check('oversized encoded input refused',!big.ok&&[413,422].includes(big.status))
  const removed=await call(route,{owner,data:null})
  p.check('removal retains higher canonical tombstone',removed.revision>saved.revision&&removed.data===null&&removed.sha256===null&&removed.bytes===0)
  const concurrent=await Promise.all(Array.from({length:4},()=>call(route,{owner,data:null})))
  const revisions=concurrent.map(x=>x.revision).sort()
  p.check('concurrent explicit edits serialize counter without loss',new Set(revisions.map(r=>r.slice(0,20))).size===4&&(await rig.api('GET',route)).picture.revision===revisions.at(-1))
  p.check('profile work creates no mail or inbox records',JSON.stringify(counts())===JSON.stringify(initialCounts))
  const logged=rig.engineLog()
  p.check('positive wire diagnostic control exists',logged.includes('profile-picture')&&logged.includes('[body omitted]'))
  p.check('wire logs omit accepted and refused original/image bytes',!logged.includes(marker)&&!logged.includes(raw)&&!logged.includes(saved.data))
  const on=`/api/orgs/${rig.org}/settings`
  await call(on,{net_autoconnect:true})
  const net=await rig.waitFor(async()=>{const t=await rig.api('GET',`/api/orgs/${rig.org}`);return t.net?.hubs?.some(h=>h.connected)?t.net:null},{what:'picture org registered',timeout:60000})
  const identity=rig.one(`SELECT net->'identity' AS identity FROM ot.orgs WHERE id=${owner}`).identity
  const hub=async(method,body)=>{
    const r=await fetch(rig.hubUrl+'/api/profile-picture'+(method==='GET'?'?slug='+encodeURIComponent(identity.slug):''),{method,headers:{'X-Org-Auth':identity.slug+':'+identity.secret,'Content-Type':'application/json'},body:body&&JSON.stringify({slug:identity.slug,picture:body}),signal:AbortSignal.timeout(10000)})
    if(!r.ok)throw Error('fixture hub status '+r.status)
    return (await r.json()).picture
  }
  await rig.waitFor(async()=> (await hub('GET'))?.revision===revisions.at(-1),{what:'initial tombstone published',timeout:35000})
  p.check('actual engine publisher sends durable tombstone to hosted hub',(await hub('GET')).data===null)
  const shown=await call(route,{owner,data:raw})
  await rig.waitFor(async()=> (await hub('GET'))?.revision===shown.revision,{what:'edited picture published',timeout:35000})
  p.check('actual engine publishes normalized bytes',(await hub('GET')).sha256===shown.sha256)
  await call(on,{org_inbox_enabled:false})
  const offlineRemoval=await call(route,{owner,data:null})
  // Wait beyond dispatch throttle: the enabled control above proves this hub works.
  await new Promise(r=>setTimeout(r,11000))
  p.check('outside isolation allows local edit but blocks picture publication',(await hub('GET')).revision===shown.revision)
  await call(on,{org_inbox_enabled:true})
  await rig.waitFor(async()=> (await hub('GET'))?.revision===offlineRemoval.revision,{what:'removal after re-enable',timeout:35000})
  p.check('re-enable publishes retained removal',(await hub('GET')).data===null)
  const replay=await hub('POST',shown)
  p.check('stale remote replay cannot resurrect removed bytes',replay.revision===offlineRemoval.revision&&replay.data===null)
  const newer={...offlineRemoval,revision:(BigInt(offlineRemoval.revision.slice(0,20))+1n).toString().padStart(20,'0')+'-'+crypto.randomBytes(16).toString('hex')}
  await hub('POST',newer)
  // Legacy roster polling may spend 25 s parked plus the 10 s picture
  // dispatch floor. Include pass scheduling instead of racing that boundary.
  const learnStarted=Date.now()
  const learned=await rig.waitFor(async()=> (await rig.api('GET',route)).picture.revision===newer.revision,{what:'newer linked identity revision learned',timeout:50000}).then(()=>true,()=>false)
  p.check('newer linked identity revision converges within bounded poll window',learned,{elapsedMs:Date.now()-learnStarted})
  p.check('remote winner is adopted without a new local revision',(await rig.api('GET',route)).picture.revision===newer.revision)
  p.check('ordinary network projection includes revision but no image data',(await rig.api('GET',`/api/orgs/${rig.org}`)).net.picture_revision===newer.revision&&!JSON.stringify(net).includes(raw))
  p.keep(rig,{grep:/profile-picture|profile_pictures|ERROR/})
  p.note('Measured actual isolated HTTP/store/hub publication; no device/pixel/WebView proof. Concurrent org-inbox disable after remote acceptance is not a recall guarantee.')
  return p.summary()
}
