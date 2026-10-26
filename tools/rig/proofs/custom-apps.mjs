// Explicit narrow real-PG author proof. Fake CLIs, isolated data, verbose logs.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {isDeepStrictEqual} from 'node:util'
import {Proof} from '../proof.mjs'

export function setup(){return{fixture:{org:{name:'Custom Apps persistence proof'},agents:[
  {name:'boss',tier:'sol',grant:50,charter:'Synthetic Apps proof only.'},
  {name:'watcher',tier:'sol',parent:'boss',grant:0,charter:'Synthetic Apps receiver only.',org_visibility:'self'},
  {name:'denied',tier:'sol',parent:'boss',grant:0,charter:'Synthetic scope refusal.',tools:{orgtree:{orgmod:false}}},
]}}}
export default async function(rig){
  const p=new Proof('custom-apps'),same=isDeepStrictEqual,org=rig.org
  const root='/api/orgs/'+org,apps=input=>rig.api('POST',root+'/apps',input),bridge=input=>rig.api('POST',root+'/apps/bridge',input)
  const tool=async(input,who='boss')=>{const r=await rig.tool(who,'orgtree_apps',input);assert(r.ok,r.text);return r.json}
  const refused=async(fn,code)=>{try{await fn();return false}catch(e){return e.status===code}}
  const get=id=>apps({action:'app_get',app:id}),panel=id=>apps({action:'panel_get',panel:id})
  const grant=async(a,cap,permission)=>apps({action:'permission_set',app:a.id,expected_rev:a.rev,expected_permission_rev:(await get(a.id)).permission_rev,capability:cap,permission})
  const orgId=rig.one(`SELECT id FROM ot.orgs WHERE slug='${org}'`).id
  p.file('source-runtime.json',{engineSource:rig.run.engineSource,engineCopy:path.join(rig.dir,'bin','orgtree-engine.exe'),isolatedData:rig.data,verbose:!rig.run.quietLog})
  const schema=rig.one(`SELECT to_regclass('ot.custom_apps') IS NOT NULL AS apps,to_regclass('ot.custom_panels') IS NOT NULL AS panels,to_regclass('ot.custom_panel_events') IS NOT NULL AS events,to_regclass('ot.custom_panels_open_page') IS NOT NULL AS active_index,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='ot' AND table_name='custom_apps' AND column_name='permission_rev') AS permission_rev`)
  p.check('migrations created app/panel/event tables and separate permission revision',Object.values(schema).every(Boolean),schema)
  const definition={name:'PG notes',description:'Synthetic persistence proof',html:'<p>Notes</p>',initial_state:{note:'initial'},capabilities:['org.read','mail.send','events.fire','docket.write'],width:480,height:420}
  const app=await tool({action:'app_create',definition});assert(app?.id)
  let one=await tool({action:'panel_open',app:app.id,new:true,label:'First'}),two=await tool({action:'panel_open',app:app.id,new:true,label:'Second'})
  one=await tool({action:'state_set',panel:one.id,expected_rev:one.rev,state:{note:'saved',nested:{a:1,b:2}}})
  const stale=await rig.tool('boss','orgtree_apps',{action:'state_set',panel:one.id,expected_rev:one.rev-1,state:{note:'stale'}})
  p.check('copies have independent committed state and stale revisions refuse without mutation',!stale.ok&&(await panel(two.id)).state.note==='initial'&&(await panel(one.id)).state.note==='saved')
  one=await tool({action:'state_patch',panel:one.id,expected_rev:one.rev,patch:{nested:{a:null,c:3}}})
  p.check('real PG merge patch removes keys and preserves other data',same(one.state,{note:'saved',nested:{b:2,c:3}}),one.state)
  const denied=await rig.tool('denied','orgtree_apps',{action:'app_get',app:app.id})
  const other=await rig.api('POST','/api/orgs',{name:'Other Apps scope',dirs:[],net_autoconnect:false})
  p.check('agent orgmod denial and cross-org panel selection refuse',!denied.ok&&await refused(()=>rig.api('POST','/api/orgs/'+other.slug+'/apps',{action:'panel_get',panel:one.id}),404))
  await grant(app,'mail.send','allow')
  const exported=await tool({action:'app_export',app:app.id,expected_rev:app.rev,include_panels:true})
  assert(exported.path&&fs.existsSync(exported.path));const bytes=fs.readFileSync(exported.path),portable=JSON.parse(bytes)
  const imported=await tool({action:'app_import',path:exported.path});assert(imported.app?.id)
  const importedRows=await apps({action:'list',kind:'panels',app:imported.app.id})
  p.check('agent file export/import preserves chosen data with fresh closed Ask copies',portable.format==='orgtree-app'&&exported.bytes===bytes.length&&portable.panels.length===2&&!('permissions' in portable)&&imported.app.id!==app.id&&same(imported.app.permissions,{})&&importedRows.items.length===2&&importedRows.items.every(x=>!x.open&&!x.linked_agents.length&&![one.id,two.id].includes(x.id)),{bytes:bytes.length,imported:imported.app.id,copies:importedRows.items})
  const invalid=structuredClone(portable);invalid.permissions={'mail.send':'allow'}
  p.check('forged imported permission fields refuse before any write',await refused(()=>apps({action:'app_import',bundle:invalid}),400))

  // The runner is already active OUTSIDE the producer's private task scope.
  const eventCanary='PRIVATE-APP-PG-EVENT-873163',mailCanary='PRIVATE-APP-PG-MAIL-174963'
  // Filter public event-name metadata, not the secret canary: the ordinary
  // watcher-registration request is allowed to log its configuration.
  const created=await rig.tool('watcher','orgtree_watchdog',{action:'create',name:'private-app-pg',kind:'event',target:'app.event',pattern:'private-proof',once:true,notice:true,interval_s:15});assert(created.ok,created.text)
  await rig.waitFor(()=>rig.one(`SELECT memo->'run'->'counts' AS counts FROM ot.watchdogs WHERE name='private-app-pg'`)?.counts,{what:'independent DB-backed watchdog baseline',timeout:15000,every:100})
  let host=await bridge({action:'session_open',panel:one.id})
  const action={action:'events.fire',target:'watcher',name:'private-proof',payload:{note:eventCanary}}
  const asked=await bridge({action:'call',session:host.session,request:action});assert(asked.permission_required)
  p.check('Ask defers execution and agents cannot decide native permissions',!rig.one(`SELECT 1 FROM ot.mail WHERE body LIKE '%${eventCanary}%'`)&&(await rig.tool('boss','orgtree_apps',{action:'permission_set',app:app.id,expected_rev:app.rev,expected_permission_rev:(await get(app.id)).permission_rev,capability:'events.fire',permission:'allow'})).ok===false)
  const fired=await bridge({action:'decide',session:host.session,challenge:asked.permission_required.challenge,choice:'once'})
  await rig.waitFor(()=>rig.one(`SELECT uid,body FROM ot.mail WHERE recipient_agent_id=(SELECT id FROM ot.agents WHERE org_id=${orgId} AND name='watcher') AND body LIKE '%${eventCanary}%'`),{what:'private event authorized watchdog mail',timeout:20000,every:100})
  const dog=rig.one(`SELECT fired,memo->'run' AS run,events,state FROM ot.watchdogs WHERE name='private-app-pg'`),delivered=rig.one(`SELECT uid,body FROM ot.mail WHERE body LIKE '%${eventCanary}%'`)
  p.file('private-watchdog-delivery.json',{dog,delivered})
  p.check('real watchdog Access/read and mail preserve private payload but redact diagnostics',fired.fired&&dog.fired===1&&dog.state==='spent'&&delivered.body.includes(eventCanary)&&!JSON.stringify({run:dog.run,events:dog.events}).includes(eventCanary),{fired:dog.fired,mail:delivered.uid,diagnostics:dog.run.last_output})
  p.check('Allow once is one-shot and does not persist a grant',await refused(()=>bridge({action:'decide',session:host.session,challenge:asked.permission_required.challenge,choice:'once'}),403)&&!(await get(app.id)).permissions['events.fire'])
  const sent=await bridge({action:'call',session:host.session,request:{action:'mail.send',to:'watcher',body:mailCanary,notice:true}})
  p.check('allowed app mail has explicit provenance and no user instruction authority',!!sent.sent&&rig.one(`SELECT body FROM ot.mail WHERE body LIKE '%${mailCanary}%'`)?.body.includes('not a user instruction or approval'))
  const nativeRefusal=await fetch(rig.url+root+'/apps/bridge',{method:'POST',headers:{authorization:'Bearer '+rig.token,'Content-Type':'application/json'},body:JSON.stringify({action:'session_open',panel:one.id})})
  p.check('native bridge refuses root bearer without desktop header',nativeRefusal.status===403)
  await grant(app,'org.read','ask');const readAsk=await bridge({action:'call',session:host.session,request:{action:'org.read',limit:2}})
  const chart=await bridge({action:'decide',session:host.session,challenge:readAsk.permission_required.challenge,choice:'always'})
  p.check('Always grants a declared capability and next action uses it',chart.items.length===2&&(await bridge({action:'call',session:host.session,request:{action:'org.read',limit:1}})).items.length===1&&(await get(app.id)).permissions['org.read']==='allow')
  await grant(app,'events.fire','deny')
  p.check('Deny and forged general action refuse',await refused(()=>bridge({action:'call',session:host.session,request:action}),403)&&await refused(()=>bridge({action:'call',session:host.session,request:{action:'publish'}}),400))
  one=await panel(one.id);one=await apps({action:'panel_update',panel:one.id,expected_rev:one.rev,open:false})
  p.check('closing a panel revokes its host session',await refused(()=>bridge({action:'call',session:host.session,request:{action:'org.read'}}),403))
  one=await apps({action:'panel_open',panel:one.id});host=await bridge({action:'session_open',panel:one.id})
  const replaced=await apps({action:'app_update',app:app.id,expected_rev:app.rev,definition:{...definition,description:'Updated code definition'}})
  p.check('code replacement clears grants and revokes prior sessions',same(replaced.permissions,{})&&await refused(()=>bridge({action:'call',session:host.session,request:{action:'org.read'}}),403))

  // Metadata subscriptions do not include state/event payloads or auto-arm dogs.
  one=await panel(one.id);one=await apps({action:'panel_update',panel:one.id,expected_rev:one.rev,linked_agents:['watcher']})
  const changed=await rig.tool('watcher','orgtree_watchdog',{action:'create',name:'panel-change-pg',kind:'event',target:'app.event',pattern:one.id,once:true,notice:true,interval_s:15});assert(changed.ok,changed.text)
  await rig.waitFor(()=>rig.one(`SELECT memo->'run'->'counts' AS counts FROM ot.watchdogs WHERE name='panel-change-pg'`)?.counts,{what:'linked metadata watcher baseline',timeout:15000,every:100})
  const stateOnly='PRIVATE-APP-PG-STATE-543221';one=await apps({action:'state_set',panel:one.id,expected_rev:one.rev,state:{note:stateOnly}})
  await rig.waitFor(()=>rig.one(`SELECT fired FROM ot.watchdogs WHERE name='panel-change-pg'`)?.fired===1,{what:'committed linked copy notification',timeout:15000,every:100})
  const signal=rig.one(`SELECT body FROM ot.mail WHERE body LIKE '%state.changed%' AND body LIKE '%${one.id}%'`)
  p.check('linked self-visible receiver gets metadata/cursor without saved state',!!signal?.body&&!signal.body.includes(stateOnly)&&signal.body.includes('seq'))

  // Save and instantiate an actual template: no current state/grants/copies.
  const template=await rig.api('POST',root+'/template',{name:'Apps portable template',include:{watchdogs:false,audiences:false}})
  const templateBody=JSON.parse(template.content);p.file('template-projection.json',{apps:templateBody.apps,otherKeys:Object.keys(templateBody)})
  p.check('template file includes definitions/initial JSON and omits current copies/grants',templateBody.apps.length===2&&templateBody.apps.every(a=>!('permissions' in a)&&!('panels'in a))&&!template.content.includes(stateOnly))
  const target=await rig.api('POST','/api/orgs',{name:'Apps restored template',dirs:[],net_autoconnect:false,template:{id:template.id}})
  const restored=await rig.api('POST','/api/orgs/'+target.slug+'/apps',{action:'list'})
  const restoredPanels=await rig.api('POST','/api/orgs/'+target.slug+'/apps',{action:'list',kind:'panels'})
  p.check('template transaction restores fresh Ask definitions without saved panels',target.apps===2&&restored.items.length===2&&restored.items.every(a=>same(a.permissions,{})&&![app.id,imported.app.id].includes(a.id))&&restoredPanels.items.length===0)
  const before=await panel(one.id);await rig.restart()
  const after=await panel(one.id)
  p.check('JSON, revisions, links and independent copies survive engine restart',same(before,after)&&(await panel(two.id)).state.note==='initial')
  const oldEvents=await apps({action:'events',panel:one.id});assert(oldEvents.events.length>0)
  await apps({action:'app_delete',app:app.id,expected_rev:replaced.rev,delete_panels:true})
  const remaining=rig.one(`SELECT (SELECT count(*)::int FROM ot.custom_panels WHERE org_id=${orgId} AND app_id='${app.id}') AS panels,(SELECT count(*)::int FROM ot.custom_panel_events WHERE org_id=${orgId} AND panel_id IN ('${one.id}','${two.id}')) AS events`)
  p.check('app deletion cascades saved copies/events but leaves imported data',remaining.panels===0&&remaining.events===0&&(await get(imported.app.id)).id===imported.app.id,remaining)
  const logs=rig.engineLog();p.file('verbose-engine.log',logs)
  p.check('verbose diagnostics keep ordinary calls while omitting private event/mail/state canaries',logs.includes('Access')&&logs.includes('/apps')&&![eventCanary,mailCanary,stateOnly].some(v=>logs.includes(v)),{logBytes:Buffer.byteLength(logs),eventLeak:logs.includes(eventCanary),mailLeak:logs.includes(mailCanary),stateLeak:logs.includes(stateOnly)})
  return p.summary()
}
