// Narrow assigned real-PG file-grant proof. Synthetic media, fake CLIs only.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {Proof} from '../proof.mjs'

const fixtureDir=path.join(process.env.ORGTREE_RIG_HOME,'files-fixture')
const video=path.join(fixtureDir,'synthetic-blue.mp4')
export function setup(){
  fs.mkdirSync(fixtureDir,{recursive:true})
  const encoded=spawnSync('C:/ffmpeg/bin/ffmpeg.exe',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=160x90:r=10','-t','2','-c:v','libx264','-threads','1','-pix_fmt','yuv420p','-movflags','+faststart',video],{encoding:'utf8',windowsHide:true,timeout:20000})
  assert.equal(encoded.status,0,encoded.stderr)
  // A valid two-second MP4 with inert padding, testing the large-file path
  // without any personal media. No whole-file read is used by the bridge.
  fs.truncateSync(video,204*1024*1024)
  return {fixture:{org:{name:'Read-only app files proof'},agents:[
    {name:'limited',tier:'sol',grant:0,add_dirs:[],charter:'Synthetic scope refusal only.'},
    {name:'allowed',tier:'sol',grant:0,add_dirs:[{path:fixtureDir,mode:'ro'}],charter:'Synthetic file read only.'},
    {name:'denied',tier:'sol',grant:0,add_dirs:[],tools:{orgtree:{orgmod:false}},charter:'Synthetic tool refusal only.'},
  ]}}
}
export default async function(rig){
  const p=new Proof('app-files'),root='/api/orgs/'+rig.org
  // Native hire's scope shape is distinct from the agent tool's add_dirs.
  // Establish the intended RO grant through the canonical native scope routes,
  // then retain both actual scope and the complete tool verdict as evidence.
  await rig.api('POST',root+'/settings',{org_dirs:[{path:fixtureDir,mode:'ro'}]})
  await rig.api('POST',root+'/nodes/allowed/scope',{add_dirs:[{path:fixtureDir,mode:'ro'}]})
  const apps=input=>rig.api('POST',root+'/apps',input),files=input=>rig.api('POST',root+'/apps/files',input),bridge=input=>rig.api('POST',root+'/apps/bridge',input)
  const refused=async(fn,status)=>{try{await fn();return false}catch(e){return e.status===status}}
  const tool=async(who,input)=>rig.tool(who,'orgtree_apps',input)
  const definition={name:'Synthetic caption file proof',html:'<p>Synthetic only</p>',capabilities:['files.read'],initial_state:{},width:600,height:480}
  let app=await apps({action:'app_create',definition}),panel=await apps({action:'panel_open',app:app.id,new:true})
  let host=await bridge({action:'session_open',panel:panel.id})
  const call=request=>files({action:'call',session:host.session,request})
  const choose=async choice=>{const ask=await call({action:'choose'});assert(ask.permission_required);return files({action:'decide',session:host.session,challenge:ask.permission_required.challenge,choice,path:video})}
  const count=()=>rig.one('SELECT count(*)::int AS n FROM ot.custom_app_file_grants').n
  p.check('new files.read declarations start at Ask with no file grant',count()===0&&!app.permissions['files.read'])
  const once=await choose('once'),onceRead=await call({action:'read',file:once.id,offset:0,limit:32})
  p.check('Allow once reads bounded bytes without a persisted grant or disclosed path',onceRead.length===32&&count()===0&&!JSON.stringify(onceRead).includes(fixtureDir),onceRead)
  await bridge({action:'session_close',session:host.session});host=await bridge({action:'session_open',panel:panel.id})
  p.check('closed Once host cannot reuse its file reference',await refused(()=>call({action:'read',file:once.id}),403))
  const saved=await choose('always');panel=await apps({action:'state_set',panel:panel.id,expected_rev:panel.rev,state:{video:saved.id}})
  let playback=await call({action:'media',file:saved.id})
  const firstTicket=playback.media_path
  let range=await fetch(rig.url+playback.media_path,{headers:{Range:'bytes=0-31'}})
  p.check('asset ticket alone authorizes exact bounded range of synthetic 204MiB MP4',range.status===206&&range.headers.get('content-range')===`bytes 0-31/${204*1024*1024}`&&(await range.arrayBuffer()).byteLength===32,{status:range.status,size:saved.bytes})
  p.check('native file bridge rejects bearer-only and missing desktop authority',await (async()=>{const r=await fetch(rig.url+root+'/apps/files',{method:'POST',headers:{authorization:'Bearer '+rig.token,'Content-Type':'application/json'},body:JSON.stringify({action:'permissions',app:app.id})});return r.status===403})())
  const other=await apps({action:'panel_open',app:app.id,new:true});const otherHost=await bridge({action:'session_open',panel:other.id})
  p.check('copied state reference cannot read from another panel',await refused(()=>files({action:'call',session:otherHost.session,request:{action:'read',file:saved.id}}),403))
  const allowed=await tool('allowed',{action:'file_read',panel:panel.id,file:saved.id,offset:0,length:32})
  const limited=await tool('limited',{action:'file_read',panel:panel.id,file:saved.id,length:32}),denied=await tool('denied',{action:'file_permissions',app:app.id})
  p.file('agent-read-scope.json',{allowed,limited,denied,scopes:rig.sql("SELECT name,scope FROM ot.agents WHERE name IN ('allowed','limited','denied') ORDER BY name")})
  p.check('agent parity intersects real held folders and live orgmod with user app grant',allowed.ok&&allowed.json.length===32&&!limited.ok&&!denied.ok,{allowed:allowed.ok,limited:limited.ok,denied:denied.ok})
  const grants=await tool('limited',{action:'file_permissions',app:app.id})
  p.check('agent grant inspection omits chosen paths outside its scope',grants.ok&&grants.json.grants.length===0&&!JSON.stringify(grants.json).includes(fixtureDir))
  p.check('agents cannot decide file permissions or grant access',!(await tool('allowed',{action:'file_choose',panel:panel.id})).ok&&!(await tool('allowed',{action:'permission_set',app:app.id,expected_rev:app.rev,expected_permission_rev:2,capability:'files.read',permission:'allow'})).ok)
  const exported=await apps({action:'app_export',app:app.id,expected_rev:app.rev,include_panels:true})
  const imported=await apps({action:'app_import',bundle:exported.bundle})
  p.check('exported state can contain an inert id but import carries no grant or native path',!JSON.stringify(exported.bundle).includes(fixtureDir)&&Object.keys(imported.app.permissions).length===0&&count()===1)
  panel=await apps({action:'panel_update',panel:panel.id,expected_rev:panel.rev,open:false})
  p.check('panel close revokes its prior asset ticket',(await fetch(rig.url+firstTicket,{headers:{Range:'bytes=0-31'}})).status===403)
  await rig.restart()
  panel=await apps({action:'panel_open',panel:panel.id});host=await bridge({action:'session_open',panel:panel.id})
  playback=await call({action:'media',file:panel.state.video});range=await fetch(rig.url+playback.media_path,{headers:{Range:'bytes=32-63'}})
  p.check('Always grant and opaque saved reference survive real engine/PG restart and reopen without selection',count()===1&&playback.id===saved.id&&range.status===206&&(await range.arrayBuffer()).byteLength===32)
  const ownFile=path.join(rig.data,'scratch',rig.org,'allowed','notes.txt');fs.mkdirSync(path.dirname(ownFile),{recursive:true});fs.writeFileSync(ownFile,'synthetic org file')
  const orgAsk=await call({action:'open',root:'scratch',path:'allowed/notes.txt'});assert(orgAsk.permission_required)
  const orgFile=await files({action:'decide',session:host.session,challenge:orgAsk.permission_required.challenge,choice:'always'})
  const agentOpen=await tool('allowed',{action:'file_open',panel:panel.id,root:'scratch',path:'allowed/notes.txt'})
  p.check('Orgtree collection grant supports native and scoped agent reads',orgFile.name==='notes.txt'&&agentOpen.ok&&agentOpen.json.id===orgFile.id)
  p.check('traversal and oversized reads refuse',await refused(()=>call({action:'open',root:'scratch',path:'../outside'}),403)&&await refused(()=>call({action:'read',file:saved.id,limit:65537}),400))
  const settings=await files({action:'permissions',app:app.id}),chosen=settings.grants.find(g=>g.scope==='file')
  await files({action:'revoke',app:app.id,expected_rev:settings.rev,expected_permission_rev:settings.permission_rev,grant:chosen.id})
  p.check('native per-file Revoke removes references and denies previous playback URL',(await fetch(rig.url+playback.media_path,{headers:{Range:'bytes=0-31'}})).status===403&&await refused(()=>call({action:'read',file:saved.id}),403))
  app=await apps({action:'app_get',app:app.id});app=await apps({action:'app_update',app:app.id,expected_rev:app.rev,definition:{...definition,description:'New code rev'}})
  p.check('code replacement clears all persisted grants and references',count()===0&&Object.keys(app.permissions).length===0&&rig.one('SELECT count(*)::int AS n FROM ot.custom_app_file_refs').n===0)
  p.file('source.json',{engine:rig.run.engineSource,data:rig.data,media:video,mediaBytes:fs.statSync(video).size})
  return p.summary()
}
