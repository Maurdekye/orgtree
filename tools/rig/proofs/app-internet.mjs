// Internet access for apps (USER 2026-10-26 m95c57abc95fb "build internet access
// as a permission for the apps"; design m232e1d1ccb57) through the real engine,
// its isolated PostgreSQL and the real bridge, Apps and tool routes.
//
// NOTHING LEAVES THIS COMPUTER. The declared sites are this machine's own names
// (localhost:9, 127.0.0.1:9), which the engine's address guard refuses only AFTER
// the grant check passes. So a granted request ends in "not a public address",
// an ungranted declared one in a native prompt, and an undeclared one in a
// refusal before any lookup. The successful request path (a TLS server that
// answers) is proven by the engine's own tests through a test-only route.
//
// With APP_BACKGROUND_BUILD set (the output of tools/rig/app-background-ui.mjs),
// the real renderer then shows the native prompt and App settings > Permissions
// in Session 0 (tools/rig/desktop/app-internet.cjs): muted, every permission and
// the clipboard refused, input only through CDP and the app's own frame.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {Proof} from '../proof.mjs'
import {runDesktop} from '../desktop.mjs'
import {REPO} from '../lib.mjs'

const built=process.env.APP_BACKGROUND_BUILD?path.resolve(process.env.APP_BACKGROUND_BUILD):''
export function setup(){
  const fixture={org:{name:'App internet access proof'},agents:[{name:'boss',tier:'sol',grant:40,charter:'Synthetic superior only.'},{name:'writer',tier:'sol',parent:'boss',grant:0,charter:'Synthetic app author only.'}]}
  if(!built)return{fixture}
  if(!fs.existsSync(path.join(built,'ui','index.html')))throw Error('set APP_BACKGROUND_BUILD to the output of tools/rig/app-background-ui.mjs')
  return{ui:path.join(built,'ui'),fixture}
}
const CANARY='PRIVATE_NET_URL_CANARY_4519'

export default async function(rig){
  const p=new Proof('app-internet'),root='/api/orgs/'+rig.org
  const apps=v=>rig.api('POST',root+'/apps',v),bridge=v=>rig.api('POST',root+'/apps/bridge',v)
  const tool=async(who,v)=>{const r=await rig.tool(who,'orgtree_apps',v);assert(r.ok,r.text);return r.json}
  const outcome=async fn=>{try{return{ok:true,value:await fn()}}catch(e){return{ok:false,status:e.status,message:String(e.message??e)}}}
  const set=async(app,capability,permission,site)=>{const a=await apps({action:'app_get',app});return apps({action:'permission_set',app,expected_rev:a.rev,expected_permission_rev:a.permission_rev,capability,permission,...(site?{site}:{})})}
  const host=async panel=>{const s=await bridge({action:'session_open',panel});return{s,call:(url,extra={})=>bridge({action:'call',session:s.session,request:{action:'net.fetch',url,...extra}}),decide:(challenge,choice)=>bridge({action:'decide',session:s.session,challenge,choice}),close:()=>bridge({action:'session_close',session:s.session})}}
  const guard=r=>!r.ok&&r.status===403&&/non-public address|not a public address/.test(r.message)

  // An agent declares the capability and its sites; that grants nothing.
  const definition={name:'Synthetic feed',html:'<p>feed</p>',capabilities:['net.fetch'],sites:['localhost:9','127.0.0.1:9','*.invalid'],width:520,height:420}
  let app=await tool('writer',{action:'app_create',definition})
  p.check('an agent declares net.fetch and its sites; nothing is granted, not even by default',JSON.stringify(app.sites)===JSON.stringify(definition.sites)&&app.permissions['net.fetch']===undefined&&app.default_permissions?.['net.fetch']===undefined&&JSON.stringify(app.site_permissions)==='{}',app)
  const one=await apps({action:'panel_open',app:app.id,new:true,label:'Visible copy'})
  let a=await host(one.id)

  const undeclared=await outcome(()=>a.call('https://example.com/'+CANARY))
  p.check('an undeclared site is refused without a prompt or a lookup',!undeclared.ok&&undeclared.status===403&&/does not declare the site example\.com/.test(undeclared.message),undeclared)
  const asked=await a.call('https://localhost:9/'+CANARY+'?q=1',{method:'POST',headers:[['Authorization','Bearer '+CANARY]],body:Buffer.from(CANARY).toString('base64')})
  const pr=asked.permission_required
  p.check('no grant: a declared site asks natively, naming its row, never its headers or body',pr?.capability==='net.fetch'&&pr.site==='localhost:9'&&pr.host==='localhost:9'&&pr.request?.method==='POST'&&JSON.stringify(Object.keys(pr.request).sort())==='["action","method","url"]',pr)
  const once=await outcome(()=>a.decide(pr.challenge,'once'))
  p.check('Allow once passes the grant check; the address guard then refuses this machine',guard(once),once)
  const again=await outcome(()=>a.call('https://localhost:9/again'))
  p.check('Allow once holds for this running copy: no second prompt',guard(again),again)

  // A hidden running copy cannot ask, and another copy does not share Allow once.
  let two=await apps({action:'panel_open',app:app.id,new:true,label:'Hidden copy'})
  two=await apps({action:'panel_update',panel:two.id,expected_rev:two.rev,open:false})
  const b=await host(two.id),hidden=await outcome(()=>b.call('https://localhost:9/'))
  p.check('a hidden copy gets interaction_required, and Allow once belongs to the other copy',!hidden.ok&&hidden.status===409&&/interaction_required/.test(hidden.message)&&two.running===true&&two.open===false,{hidden,two:{open:two.open,running:two.running}})

  // Agents restrict, never grant.
  const agentAllow=await rig.tool('writer','orgtree_apps',{action:'permission_set',app:app.id,expected_rev:app.rev,expected_permission_rev:(await apps({action:'app_get',app:app.id})).permission_rev,capability:'net.fetch',permission:'allow',site:'127.0.0.1:9'})
  p.check('an agent cannot allow internet access',!agentAllow.ok&&/never allow/.test(agentAllow.text),agentAllow.text)
  let current=await apps({action:'app_get',app:app.id})
  await tool('writer',{action:'permission_set',app:app.id,expected_rev:current.rev,expected_permission_rev:current.permission_rev,capability:'net.fetch',permission:'deny',site:'*.invalid'})
  current=await apps({action:'app_get',app:app.id})
  const lift=await rig.tool('writer','orgtree_apps',{action:'permission_set',app:app.id,expected_rev:current.rev,expected_permission_rev:current.permission_rev,capability:'net.fetch',permission:'ask',site:'*.invalid'})
  const other=await rig.tool('writer','orgtree_apps',{action:'permission_set',app:app.id,expected_rev:current.rev,expected_permission_rev:current.permission_rev,capability:'org.read',permission:'deny'})
  p.check('an agent may set a site to Deny but not lift it, and decides no other permission',current.site_permissions['*.invalid']==='deny'&&!lift.ok&&/lift/.test(lift.text)&&!other.ok&&/only the user/.test(other.text),{rows:current.site_permissions,lift:lift.text,other:other.text})

  // The user's Always allow, then a revoke that takes effect without a restart.
  const ask2=await a.call('https://127.0.0.1:9/')
  const always=await outcome(()=>a.decide(ask2.permission_required.challenge,'always'))
  current=await apps({action:'app_get',app:app.id})
  p.check('Always allow this site stores that row and the request passes the grant check',ask2.permission_required?.site==='127.0.0.1:9'&&guard(always)&&current.site_permissions['127.0.0.1:9']==='allow',{always,rows:current.site_permissions})
  await set(app.id,'net.fetch','deny','127.0.0.1:9')
  const revoked=await outcome(()=>a.call('https://127.0.0.1:9/'))
  const onceGone=await a.call('https://localhost:9/')
  p.check('revoke takes effect at once, no restart: Deny refuses, and the copy\'s Allow once is gone',!revoked.ok&&revoked.status===403&&/denied/.test(revoked.message)&&!!onceGone.permission_required,{revoked,onceGone:!!onceGone.permission_required})
  await a.close();a=await host(one.id)
  await set(app.id,'net.fetch','deny')
  const capDeny=await outcome(()=>a.call('https://localhost:9/'))
  p.check('capability Deny wins over every site',!capDeny.ok&&/internet access is denied for this app/.test(capDeny.message),capDeny)

  // Any site needs its own Allow; "Allow listed sites" never covers it.
  let any=await tool('writer',{action:'app_create',definition:{...definition,name:'Any-site feed',sites:['*']}})
  const anyCopy=await apps({action:'panel_open',app:any.id,new:true,label:'Any'})
  await set(any.id,'net.fetch','allow')
  let c=await host(anyCopy.id)
  const anyAsk=await c.call('https://localhost:9/')
  p.check('Allow listed sites does not cover Any site: it still asks',!!anyAsk.permission_required&&anyAsk.permission_required.site==='localhost:9',anyAsk)
  await c.close();await set(any.id,'net.fetch','allow','*');c=await host(anyCopy.id)
  p.check('Any site allowed on its own row passes the grant check',guard(await outcome(()=>c.call('https://localhost:9/'))))

  // A code change clears every Allow; Ask and Deny stay.
  await set(app.id,'net.fetch','allow');await set(app.id,'net.fetch','allow','localhost:9')
  current=await apps({action:'app_get',app:app.id})
  const updated=await tool('writer',{action:'app_update',app:app.id,expected_rev:current.rev,definition:{...definition,description:'Edited code'}})
  p.check('a code change clears every Allow, capability and site rows; Deny rows stay',updated.permissions['net.fetch']===undefined&&updated.site_permissions['localhost:9']===undefined&&updated.site_permissions['127.0.0.1:9']==='deny'&&updated.site_permissions['*.invalid']==='deny',{permissions:updated.permissions,rows:updated.site_permissions})

  // Permission history, read as an agent.
  const history=await tool('writer',{action:'permission_history',app:app.id})
  const has=(f)=>history.entries.some(f),e=history.entries
  p.file('permission-history.json',history)
  p.check('Permission history records prompt answers, changes, agents and code resets, newest first',
    has(x=>x.via==='prompt'&&x.permission==='once'&&x.site==='localhost:9'&&x.actor==='user'&&x.panel===one.id)&&
    has(x=>x.via==='prompt'&&x.permission==='allow'&&x.site==='127.0.0.1:9')&&
    has(x=>x.via==='change'&&x.permission==='deny'&&x.site==='*.invalid'&&x.actor==='writer')&&
    has(x=>x.via==='change'&&x.permission==='deny'&&x.site===null&&x.actor==='user')&&
    has(x=>x.via==='code'&&x.permission==='default'&&x.site==='localhost:9'&&x.actor==='writer')&&
    has(x=>x.via==='code'&&x.permission==='default'&&x.capability==='net.fetch'&&x.site===null)&&
    e.every((x,i)=>i===0||e[i-1].seq>x.seq),e.length)

  // Sites travel; grants never do.
  const exported=await tool('writer',{action:'app_export',app:app.id,expected_rev:updated.rev,as_file:false})
  const imported=await apps({action:'app_import',bundle:exported.bundle})
  p.check('exports carry the sites but no choice; an import starts with none',JSON.stringify(exported.bundle.definition.sites)===JSON.stringify(definition.sites)&&!JSON.stringify(exported.bundle).includes('site_permissions')&&JSON.stringify(imported.app.sites)===JSON.stringify(definition.sites)&&JSON.stringify(imported.app.site_permissions)==='{}'&&imported.app.permissions['net.fetch']===undefined,{exported:exported.bundle.definition.sites,imported:imported.app.site_permissions})

  // The bridge admits a 1 MiB internet body; every other action keeps its bound.
  const anyHost=await host(anyCopy.id)
  const bigBody=await outcome(()=>anyHost.call('https://localhost:9/',{method:'POST',body:Buffer.alloc(1024*1024,65).toString('base64')}))
  const tooBig=await outcome(()=>anyHost.call('https://localhost:9/',{method:'POST',body:Buffer.alloc(1024*1024+1,65).toString('base64')}))
  const event=await outcome(()=>bridge({action:'call',session:anyHost.s.session,request:{action:'events.fire',name:'x',payload:{pad:'x'.repeat(100*1024)}}}))
  p.check('a 1 MiB body reaches the grant check; more is refused; other actions keep their 72 KiB bound',guard(bigBody)&&!tooBig.ok&&tooBig.status===400&&/1 MiB/.test(tooBig.message)&&!event.ok&&event.status===400&&/limit/.test(event.message),{bigBody,tooBig,event})

  // Positive control as app-authority.mjs: a marker in a logged request line shows
  // the log is read and current; the canary sat in URLs, headers and bodies.
  await rig.api('GET','/api/orgs?net_privacy_positive=visible')
  const log=rig.engineLog()
  p.check('URLs, headers and bodies stay out of engine diagnostics',!log.includes(CANARY)&&log.includes('net_privacy_positive'),{canary:log.includes(CANARY),control:log.includes('net_privacy_positive')})

  if(built){
    // Only the capture's copy is on screen: earlier copies are powered off.
    for(const id of [one.id,two.id,anyCopy.id])await apps({action:'panel_stop',panel:id})
    const desk=await tool('writer',{action:'app_create',definition:{name:'Weather board',description:'Synthetic internet app for the capture',html:'<p id="out">idle</p>',capabilities:['net.fetch','events.fire'],sites:['api.example.com','*.example.org','localhost:9','*'],width:520,height:360}})
    const deskCopy=await apps({action:'panel_open',app:desk.id,new:true,label:'Panel 1'})
    const run=await runDesktop(rig,path.join(REPO,'tools','rig','desktop','app-internet.cjs'),{preset:'1000x700',out:path.join(p.dir,'desktop'),timeout:240000,args:{app:desk.id,panel:deskCopy.id,name:'Weather board'}})
    p.file('desktop-result.json',run)
    const R=run.value??{}
    p.check('the capture ran in Session 0, muted, permissions and clipboard refused',run.ok&&R.session?.sessionId===0&&R.muted===true&&JSON.stringify(R.clipboard)==='[]',{error:run.error,session:R.session,muted:R.muted,clipboard:R.clipboard,output:run.electronOutput?.slice(-800)})
    p.check('the real prompt names the site and offers Always allow this site',/Allow internet access\?/.test(R.prompt?.text??'')&&/connect to localhost:9/.test(R.prompt?.text??'')&&(R.prompt?.buttons??[]).includes('Always allow this site'),R.prompt)
    p.check('the app\'s orgtree.net.fetch reached the engine after Always allow and got the address guard\'s refusal',/not a public address|non-public address/.test(R.fetch?.error??''),R.fetch)
    p.check('the Permissions tab shows Internet access, the allowed site, Any site with its warning and Permission history',/Internet access/.test(R.permissions?.text??'')&&R.permissions?.rows?.['localhost:9']==='allow'&&/Lets the app connect to any website/.test(R.permissions?.text??'')&&/localhost:9: allowed at a prompt/.test(R.permissions?.text??''),R.permissions)
  }else p.note('no APP_BACKGROUND_BUILD: the Session 0 capture of the prompt and the Permissions tab did not run')
  p.file('runtime.json',{engine:rig.run.engineSource,run:rig.run.id,limits:'Isolated PG/bridge/tool proof; nothing left this computer. The successful request path is the engine test net::tls_tests.'})
  return p.summary()
}
