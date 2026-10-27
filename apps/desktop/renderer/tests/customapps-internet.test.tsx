import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {AppImport,parseAppBundle} from '../src/canvas/apps/portable'
import {PANEL_CSP,PANEL_PROTOCOL,panelDocument} from '../src/canvas/apps/sdk'
import {siteCovers} from '../src/canvas/apps/net-ui'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

// USER 2026-10-26 m95c57abc95fb "build internet access as a permission for the
// apps"; design accepted m232e1d1ccb57: the frame stays offline and asks the
// engine through orgtree.net.fetch; per-site Ask/Allow/Deny; Permission history.
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const b64=(text:string)=>Buffer.from(text).toString('base64')

test('the panel stays offline: orgtree.net.fetch is one engine request returning a real Response',async t=>{
  assert.match(PANEL_CSP,/connect-src 'none'/,'the frame CSP still allows no connection')
  const doc=panelDocument('<p>x</p>','net-channel'),sdk=doc.slice(doc.indexOf('<script>')+8,doc.indexOf('</script>'))
  const posted:Record<string,unknown>[]=[],ports:MessagePort[]=[],win:Record<string,unknown>={}
  const parent={postMessage:(message:Record<string,unknown>,_origin:string,transfer?:MessagePort[])=>{posted.push(message);if(transfer?.[0])ports.push(transfer[0])}}
  const quiet=<T extends (...a:never[])=>unknown>(timer:T)=>((...a:Parameters<T>)=>{const handle=(timer as unknown as (...b:unknown[])=>{unref?:()=>void})(...a);handle?.unref?.();return handle}) as unknown as T
  new Function('window','parent','setTimeout','setInterval',sdk)(win,parent,quiet(setTimeout),quiet(setInterval))
  t.after(()=>{for(const port of ports)port.close()})
  const port=ports[0]!;port.postMessage({protocol:PANEL_PROTOCOL,channel:'net-channel',kind:'ready'})
  await new Promise(r=>setTimeout(r,20))
  const orgtree=win.orgtree as {net:{fetch:(input:string,init?:RequestInit)=>Promise<Response>}}
  const pending=orgtree.net.fetch('https://api.example.com/v1',{method:'post',body:'hello',headers:{'X-App':'1'}})
  await new Promise(r=>setTimeout(r,20))
  const sent=posted.find(m=>m.method==='engine.call')!
  assert.ok(sent,'the request goes to the host as one engine call')
  const args=(sent.args as {action:string;args:{url:string;method:string;headers:[string,string][];body:string}})
  assert.equal(args.action,'net.fetch');assert.equal(args.args.url,'https://api.example.com/v1');assert.equal(args.args.method,'POST')
  assert.equal(args.args.body,b64('hello'));assert.ok(args.args.headers.some(([n,v])=>n==='x-app'&&v==='1'))
  port.postMessage({protocol:PANEL_PROTOCOL,channel:'net-channel',id:sent.id,result:{status:201,headers:[['content-type','text/plain'],['x-reply','2']],body:b64('created'),url:'https://api.example.com/v1/final',redirected:true}})
  const response=await pending
  assert.equal(response instanceof Response,true);assert.equal(response.status,201);assert.equal(await response.text(),'created')
  assert.equal(response.headers.get('x-reply'),'2');assert.equal(response.url,'https://api.example.com/v1/final');assert.equal(response.redirected,true)
})

function fixture(){
  const app={id:'net-app',name:'Feed',description:'',rev:2,permission_rev:5,width:360,height:300,capabilities:['net.fetch'],sites:['api.example.com'],permissions:{},site_permissions:{},created_by:'maker',updated_at:'now',definition:{name:'Feed',description:'',html:'<p>feed</p>',initial_state:{},capabilities:['net.fetch'],sites:['api.example.com'],width:360,height:300}} as CustomApp
  const panel:CustomPanel={id:'feed-copy',app:app.id,label:'Panel 1',open:true,rev:1,state:{},placement:{mode:'float',x:20,y:20,width:360,height:300},updated_at:'now',used_at:'now'}
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[]
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    let out:unknown
    if(url.pathname.endsWith('/apps/bridge')){
      if(input.action==='session_open')out={session:'host-only',app:app.id,app_rev:app.rev,expires_in:1800}
      else if(input.action==='session_close')out={closed:true}
      else if(input.action==='call')out={permission_required:{challenge:'net-challenge',app:app.id,panel:panel.id,name:app.name,label:panel.label,capability:'net.fetch',request:{action:'net.fetch',method:input.request.method,url:input.request.url},site:'api.example.com',host:'api.example.com'}}
      else if(input.action==='decide')out={status:200,headers:[],body:b64('ok'),url:'https://api.example.com/x',redirected:false}
      else throw Error('Unexpected bridge request')
    }else if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=panel
    else if(input.action==='events')out={events:[],next_cursor:null}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{app,panel,calls,restore:()=>{globalThis.fetch=original}}
}

test('a declared site asks natively, names the site and never shows headers or body',async t=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:false});t.after(()=>{delete (document as unknown as Record<string,unknown>).hidden})
  const f=fixture();t.after(f.restore)
  const view=await mountView(<PanelHtml slug="net-prompt" app={f.app} panel={f.panel}/>,el=>el);t.after(()=>view.unmount())
  await inAct(tick);const frame=view.el.querySelector('iframe')!;const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!),win=frame.ownerDocument.defaultView!
  const answers:Record<string,unknown>[]=[]
  const send=async(id:string,method:string,args?:unknown)=>inAct(async()=>{const e=new win.MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id,method,args}});if(method==='host.ready'){const link=new MessageChannel();link.port1.onmessage=m=>answers.push(m.data);t.after(()=>link.port1.close());Object.defineProperty(e,'ports',{value:[link.port2]})}win.dispatchEvent(e);await tick()})
  await send('ready','host.ready')
  await send('get','engine.call',{action:'net.fetch',args:{url:'https://api.example.com/x',method:'GET',headers:[['authorization','Bearer s3cret']]}})
  const call=f.calls.find(x=>x.action==='call') as {request:Record<string,unknown>}
  assert.deepEqual(call.request,{action:'net.fetch',url:'https://api.example.com/x',method:'GET',headers:[['authorization','Bearer s3cret']]},'the request reaches the engine unchanged')
  const prompt=document.querySelector('[role="dialog"][aria-label="App permission"]')!;assert.ok(prompt,'a declared site asks first')
  assert.match(prompt.textContent!,/Allow internet access\?/);assert.match(prompt.textContent!,/connect to api\.example\.com/)
  assert.match(prompt.textContent!,/without your cookies or sign-ins/);assert.equal(prompt.textContent!.includes('s3cret'),false,'the prompt never shows headers')
  const always=[...prompt.querySelectorAll('button')].find(b=>b.textContent==='Always allow this site');assert.ok(always,'Always allow names the site')
  await inAct(async()=>{always!.click();await tick()})
  assert.deepEqual(f.calls.find(x=>x.action==='decide'),{action:'decide',session:'host-only',challenge:'net-challenge',choice:'always'})
  await inAct(async()=>{await new Promise(r=>setTimeout(r,20))})
  assert.deepEqual((answers.find(x=>x.id==='get') as {result:unknown})?.result,{status:200,headers:[],body:b64('ok'),url:'https://api.example.com/x',redirected:false})
  // 1 MiB of body fits; more is refused before anything is sent.
  const before=f.calls.length
  await send('big','engine.call',{action:'net.fetch',args:{url:'https://api.example.com/x',method:'POST',body:'A'.repeat(1600*1024)}})
  assert.match(String((answers.find(x=>x.id==='big') as {error:unknown})?.error),/exceeds 1 MiB/);assert.equal(f.calls.length,before)
})

test('Permissions shows internet access per site, Any site with a warning, prompt rows and Permission history',async t=>{
  const app={id:'feed',name:'Feed',description:'',rev:3,permission_rev:9,width:400,height:300,capabilities:['net.fetch','docket.write'],sites:['api.example.com','*.example.org','*'],permissions:{},site_permissions:{'news.example.org':'allow','gone.example.net':'deny'},default_permissions:{'docket.write':'allow'},origin:'created',created_by:'maker',updated_at:''} as CustomApp
  const history=[{seq:4,capability:'net.fetch',site:'news.example.org',permission:'allow',via:'prompt',actor:'user',panel:'p1',at:'2026-10-27T01:00:00Z'},{seq:3,capability:'net.fetch',site:'api.example.com',permission:'default',via:'code',actor:'builder',panel:null,at:'2026-10-27T00:59:00Z'},{seq:2,capability:'net.fetch',site:null,permission:'deny',via:'change',actor:'builder',panel:null,at:'2026-10-27T00:58:00Z'}]
  const sets:Record<string,unknown>[]=[]
  const old=globalThis.fetch;globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    if(input.action==='permission_history'){assert.equal(init?.method??'GET','GET','history is a read');return new Response(JSON.stringify({app:app.id,entries:history}))}
    if(input.action==='permission_set'){sets.push(input);return new Response(JSON.stringify({...app,permission_rev:10}))}
    throw Error('Unexpected '+JSON.stringify(input))
  };t.after(()=>{globalThis.fetch=old})
  const view=await mountView(<AppPermissions slug="net-settings" app={app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const select=(label:string)=>document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)
  assert.equal(select('net.fetch permission'),null,'internet access has its own group, not a generic row')
  assert.equal(select('Internet access permission')!.value,'ask','off until allowed: the capability asks by default')
  assert.deepEqual([...select('Internet access permission')!.options].map(o=>o.textContent),['Ask','Allow listed sites','Deny'])
  assert.equal(select('api.example.com internet permission')!.value,'ask')
  assert.equal(select('Any site internet permission')!.value,'ask')
  assert.match(view.el.textContent!,/Lets the app connect to any website/)
  assert.match(view.el.textContent!,/Any subdomain of example\.org/)
  assert.equal(select('news.example.org internet permission')!.value,'allow','a host answered at a prompt keeps its own row')
  await inAct(async()=>{const s=select('api.example.com internet permission')!;s.value='deny';s.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  assert.deepEqual(sets.at(-1),{action:'permission_set',app:'feed',expected_rev:3,expected_permission_rev:9,capability:'net.fetch',permission:'deny',site:'api.example.com'})
  await inAct(async()=>{document.querySelector<HTMLButtonElement>('button[aria-label="Remove gone.example.net"]')!.click();await tick()})
  assert.deepEqual(sets.at(-1),{action:'permission_set',app:'feed',expected_rev:3,expected_permission_rev:10,capability:'net.fetch',permission:'default',site:'gone.example.net'})
  const rows=[...document.querySelectorAll('[aria-label="Permission history"] li')].map(li=>li.textContent)
  assert.equal(rows.length,3)
  assert.match(rows[0]!,/news\.example\.org: allowed at a prompt/);assert.match(rows[0]!,/You/)
  assert.match(rows[1]!,/api\.example\.com: Allow cleared by a code change/);assert.match(rows[1]!,/builder/)
  assert.match(rows[2]!,/Internet access: denied/)
})

test('import accepts declared sites, names them, and Any site needs its own row',async t=>{
  const definition={name:'Feed',description:'',html:'<p>feed</p>',initial_state:{},capabilities:['net.fetch'],sites:['api.example.com','*'],width:400,height:300}
  const raw=(def:Record<string,unknown>)=>JSON.stringify({format:'orgtree-app',version:1,definition:def})
  assert.deepEqual(parseAppBundle(raw(definition)).definition.sites,['api.example.com','*'])
  assert.throws(()=>parseAppBundle(raw({...definition,sites:['a.example.com','a.example.com']})),/32 unique/)
  assert.throws(()=>parseAppBundle(raw({...definition,sites:Array.from({length:33},(_,i)=>`s${i}.example.com`)})),/32 unique/)
  assert.throws(()=>parseAppBundle(raw({...definition,site_permissions:{'api.example.com':'allow'}})),/Unexpected app bundle field/)
  const view=await mountView(<AppImport slug="net-import" bundle={{format:'orgtree-app',version:1,definition,panels:[]}} close={()=>{}}/>,e=>e);t.after(()=>view.unmount())
  assert.match(view.el.textContent!,/asks before connecting to the internet, and it asks to reach any site: api\.example\.com, any site/)
  assert.equal(siteCovers('*.example.org','news.example.org'),true);assert.equal(siteCovers('*.example.org','example.org'),false)
  assert.equal(siteCovers('api.example.com','api.example.com:8443'),false);assert.equal(siteCovers('*','anything.net:8443'),true)
})
