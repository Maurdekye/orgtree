// Narrow approved real-PG author proof; synthetic org/fake CLIs, no live data.
import assert from 'node:assert/strict'
import {isDeepStrictEqual as same} from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {Proof} from '../proof.mjs'

export function setup(){return{recover:true,fixture:{org:{name:'Named app event proof'},agents:[
  {name:'boss',tier:'sol',grant:50,charter:'Synthetic event proof only.'},
  {name:'watcher',tier:'sol',parent:'boss',grant:0,charter:'Synthetic listener only.',org_visibility:'self'},
  {name:'second',tier:'sol',parent:'boss',grant:0,charter:'Synthetic listener only.'},
  {name:'denied',tier:'sol',parent:'boss',grant:0,charter:'Synthetic denial.',tools:{orgtree:{orgmod:false}}},
]}}}

// A normal independent transaction blocks delivery, not publication. Keeping a
// committed event queued across graceful restart exercises recovery without
// killing a process, mutating product cursors or manufacturing an outbox row.
async function holdOwner(rig,id){
  const {port,password}=rig.pgConn(),child=spawn(path.join(rig.run.pgBin,'psql.exe'),['-X','-q','-At','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',String(port),'-U','orgtree_admin','-d','orgtree_engine'],{windowsHide:true,env:{...process.env,PGPASSWORD:password,PGCLIENTENCODING:'UTF8'},stdio:['pipe','pipe','pipe']})
  let text='';child.stderr.on('data',()=>{});child.stdin.on('error',()=>{})
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Owner lock timeout')),10000);child.once('error',reject);child.stdout.on('data',data=>{text+=data;if(text.includes('APP_OWNER_LOCK_READY')){clearTimeout(timer);resolve()}});child.stdin.write(`BEGIN; SELECT id FROM ot.agents WHERE id=${Number(id)} FOR UPDATE;\n\\echo APP_OWNER_LOCK_READY\n`)})
  return async()=>{if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('close',resolve));child.stdin.on('error',()=>{});child.stdin.end('ROLLBACK;\n\\q\n');await done}
}

export default async function(rig){
  const p=new Proof('app-events'),root='/api/orgs/'+rig.org,apps=input=>rig.api('POST',root+'/apps',input),bridge=input=>rig.api('POST',root+'/apps/bridge',input)
  const tool=async(agent,name,args)=>{const r=await rig.tool(agent,name,args);assert(r.ok,r.text);return r.json}
  const dog=(agent,args)=>tool(agent,'orgtree_watchdog',args),appTool=args=>tool('boss','orgtree_apps',args)
  const reject=async(fn,status)=>{try{await fn();return false}catch(e){return e.status===status}}
  const get=id=>apps({action:'app_get',app:id}),panel=id=>apps({action:'panel_get',panel:id})
  const count=event=>Number(rig.one(`SELECT count(*) AS n FROM ot.mail WHERE extra->'app_event'->>'event'='${event}'`).n)
  const wait=async(event,n)=>rig.waitFor(()=>count(event)===n,{what:'exact committed app event recipient mail',timeout:20000,every:100})
  p.check('actual migrations create declarations and durable fire/recipient tables',!!rig.one("SELECT to_regclass('ot.app_event_fires') AS f,to_regclass('ot.app_event_recipients') AS r").f&&!!rig.one("SELECT to_regclass('ot.app_event_recipients') AS r").r)
  const definition={name:'Named notes',description:'Synthetic event source',html:'<p>Notes</p>',initial_state:{},events:[{name:'submitted',description:'Ready'},{name:'paused-event'},{name:'unobserved'}],capabilities:['events.fire','docket.write'],width:420,height:360}
  let app=await appTool({action:'app_create',definition}),a=await appTool({action:'panel_open',app:app.id,new:true,label:'First'}),b=await appTool({action:'panel_open',app:app.id,new:true,label:'Second'})
  a=await appTool({action:'panel_update',panel:a.id,expected_rev:a.rev,open:false})
  const exported=await appTool({action:'app_export',app:app.id,expected_rev:app.rev,as_file:false,include_panels:true}),imported=await appTool({action:'app_import',bundle:exported.bundle})
  const expected=definition.events.map(e=>({description:'',...e})),actual=(await get(app.id)).events;p.file('manifest-roundtrip.json',{expected,actual,imported:imported.app.events})
  p.check('declarations round-trip through real PG/portable bundles with fresh Ask and no connections',same(actual,expected)&&same(imported.app.events,expected)&&Object.keys(imported.app.permissions).length===0&&(await apps({action:'listeners',app:imported.app.id})).items.length===0)
  const specific=await dog('watcher',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',panel:a.id,name:'first-copy',notice:true,fire_actions:[{tool:'orgtree_apps',args:{action:'fire_event',panel:a.id,name:'unobserved',payload:{nested:true}}}]}),all=await dog('second',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',all_panels:true,name:'all-copies',notice:true,once:true})
  const denied=await rig.tool('denied','orgtree_watchdog',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',panel:a.id}),duplicate=await rig.tool('second','orgtree_watchdog',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',panel:a.id})
  const unknown=await rig.tool('boss','orgtree_watchdog',{action:'create',kind:'app_listener',target:app.id,event_name:'missing',panel:a.id})
  p.check('subscription requires current owner authority, declared source and nonoverlapping selector',!denied.ok&&!duplicate.ok&&!unknown.ok)
  const canary='PRIVATE_NAMED_APP_PAYLOAD_962174',fired=await appTool({action:'fire_event',panel:a.id,name:'submitted',payload:{note:canary,nested:{exact:17}}});assert.equal(fired.subscribers,2);await wait(fired.event,2)
  await rig.waitFor(()=>rig.one(`SELECT done FROM ot.app_event_fires WHERE uid='${fired.event}'`)?.done,{what:'post-commit actions complete',timeout:20000,every:100})
  const delivered=rig.sql(`SELECT uid,body,extra,ev FROM ot.mail WHERE extra->'app_event'->>'event'='${fired.event}'`),dogs=rig.sql("SELECT name,state,fired,events,memo->'run' AS run FROM ot.watchdogs WHERE name IN ('first-copy','all-copies') ORDER BY name")
  p.file('private-delivery.json',{fired,delivered,dogs})
  p.check('closed-copy fire reaches every subscribed listener with exact private JSON and provenance',delivered.length===2&&delivered.every(m=>m.body.includes(canary)&&m.body.includes('not a user instruction or approval')&&m.extra.app_event.panel===a.id&&m.extra.app_event.producer.kind==='agent'))
  p.check('one-shot spend and payload-free diagnostic ring commit with mail',dogs.find(d=>d.name==='all-copies').state==='spent'&&dogs.every(d=>d.fired===1&&!JSON.stringify({events:d.events,run:d.run}).includes(canary)))
  p.check('nested same-app fire action completes after gate/DB release exactly once',Number(rig.one(`SELECT count(*) AS n FROM ot.app_event_fires WHERE app_id='${app.id}' AND name='unobserved'`).n)===1&&delivered.some(m=>m.body.includes('Fire-time tool calls')||JSON.stringify(m.ev).includes('fire_actions')))
  const paused=await dog('watcher',{action:'create',kind:'app_listener',target:app.id,event_name:'paused-event',panel:a.id,name:'paused-copy',notice:true});await dog('watcher',{action:'pause',id:paused.id})
  const old=await apps({action:'fire_event',panel:a.id,name:'paused-event',payload:{}});await dog('watcher',{action:'resume',id:paused.id})
  const resumed=await apps({action:'fire_event',panel:a.id,name:'paused-event',payload:{}});await wait(resumed.event,1)
  p.check('paused-at-fire listener never joins the earlier snapshot after resuming',old.subscribers===0&&count(old.event)===0&&resumed.subscribers===1)
  const secondCopy=await dog('watcher',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',panel:b.id,name:'second-copy',notice:true})
  const secondAll=await dog('second',{action:'create',kind:'app_listener',target:app.id,event_name:'submitted',all_panels:true,name:'all-new',notice:true})
  const fromB=await apps({action:'fire_event',panel:b.id,name:'submitted',payload:{source:'second'}});await wait(fromB.event,2)
  p.check('specific-copy and explicit all-copy subscriptions select independent saved copies',fromB.subscribers===2&&rig.sql(`SELECT recipient_name FROM ot.mail WHERE extra->'app_event'->>'event'='${fromB.event}'`).length===2&&rig.one("SELECT fired FROM ot.watchdogs WHERE name='first-copy'").fired===1)
  const connections=await apps({action:'listeners',app:app.id,panel:b.id,limit:1})
  p.check('bounded connection page reports real agent-owned registrations',connections.items.length===1&&typeof connections.next_cursor==='number'&&connections.items[0].id.includes('/'))
  p.check('wrong panel, undeclared event, oversized payload and forged HTML target refuse',await reject(()=>apps({action:'fire_event',panel:a.id,name:'missing',payload:{}}),409)&&await reject(()=>apps({action:'fire_event',panel:'other-copy',name:'submitted',payload:{}}),404)&&await reject(()=>apps({action:'fire_event',panel:a.id,name:'submitted',payload:'x'.repeat(65537)}),400))
  app=await get(app.id)
  for(const capability of ['events.fire','docket.write']){app=await apps({action:'permission_set',app:app.id,expected_rev:app.rev,expected_permission_rev:app.permission_rev,capability,permission:'allow'})}
  const beforeGrant=app.permission_rev
  // Exercise the exact data transition from0063 against real grants. The full
  // DDL was applied at startup; this is a data-migration regression, not a claim
  // that a previous-release binary was upgraded in this proof.
  rig.exec(fs.readFileSync(new URL('../../../engine/rs/orgtree-engine/migrations/0063_custom_app_event_delivery.sql',import.meta.url),'utf8').split('CREATE TABLE')[0])
  app=await get(app.id)
  p.check('legacy target-specific grant reset SQL requires fresh Ask and preserves other grants',!app.permissions['events.fire']&&app.permissions['docket.write']==='allow'&&app.permission_rev===beforeGrant+1)
  const host=await bridge({action:'session_open',panel:b.id}),action={action:'events.fire',name:'submitted',payload:{native:canary}}
  p.check('old target-selector HTML vocabulary is refused',await reject(()=>bridge({action:'call',session:host.session,request:{...action,target:'watcher'}}),400))
  const asked=await bridge({action:'call',session:host.session,request:action});assert(asked.permission_required)
  p.check('native Ask is required and agents cannot grant execution',asked.permission_required.capability==='events.fire'&&!(await rig.tool('boss','orgtree_apps',{action:'permission_set',app:app.id,expected_rev:app.rev,expected_permission_rev:app.permission_rev,capability:'events.fire',permission:'allow'})).ok)
  const once=await bridge({action:'decide',session:host.session,challenge:asked.permission_required.challenge,choice:'once'});await wait(once.event,2)
  p.check('bound native broadcast reaches listeners and Once remains one-shot',once.accepted&&await reject(()=>bridge({action:'decide',session:host.session,challenge:asked.permission_required.challenge,choice:'once'}),403)&&!(await get(app.id)).permissions['events.fire'])
  const deniedAsk=await bridge({action:'call',session:host.session,request:action});assert(deniedAsk.permission_required)
  p.check('native Deny prevents publication',await reject(()=>bridge({action:'decide',session:host.session,challenge:deniedAsk.permission_required.challenge,choice:'deny'}),403))
  const boss=rig.one("SELECT id FROM ot.agents WHERE name='boss'").id,release=await holdOwner(rig,boss);let queued
  try{queued=await apps({action:'fire_event',panel:b.id,name:'submitted',payload:{restart:canary}});p.check('accepted fire remains durable while a normal owner transaction blocks delivery',queued.subscribers===2&&count(queued.event)===0&&!rig.one(`SELECT done FROM ot.app_event_fires WHERE uid='${queued.event}'`).done);await rig.restart()}finally{await release()}
  await wait(queued.event,2);await rig.waitFor(()=>rig.one(`SELECT done FROM ot.app_event_fires WHERE uid='${queued.event}'`)?.done,{what:'recovered dispatch complete',timeout:20000,every:100})
  const before=rig.one("SELECT sum(fired) AS n FROM ot.watchdogs WHERE kind='app_listener'").n;await rig.restart()
  p.check('graceful restart recovers accepted work without duplicate mail or spend',count(queued.event)===2&&rig.one("SELECT sum(fired) AS n FROM ot.watchdogs WHERE kind='app_listener'").n===before)
  app=await get(app.id);app=await apps({action:'app_update',app:app.id,expected_rev:app.rev,definition:{...definition,events:[{name:'unobserved'}]}})
  const invalidated=await apps({action:'listeners',app:app.id})
  p.check('removing declarations pauses affected listeners with a visible reason',invalidated.items.length>=3&&invalidated.items.every(d=>d.state==='paused'&&d.reason))
  p.check('removed declaration cannot be silently resumed',!(await rig.tool('watcher','orgtree_watchdog',{action:'resume',id:specific.id})).ok)
  const logs=rig.engineLog();p.file('verbose-engine.log',logs)
  p.check('independent durable worker preserves authorized payload but logs remain opaque',logs.includes('Access')&&logs.includes('/apps')&&!logs.includes(canary),{logBytes:Buffer.byteLength(logs),payloadLeak:logs.includes(canary)})
  p.file('runtime-source.json',{engine:rig.run.engineSource,run:rig.run.id,restarts:rig.run.restarts,limits:'Actual isolated engine/PG/tool/bridge. No native UI or installed-alpha claim.'})
  return p.summary()
}
