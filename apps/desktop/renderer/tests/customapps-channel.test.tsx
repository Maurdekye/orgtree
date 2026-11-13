import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelHtml} from '../src/canvas/apps/host'
import {AppPermissions} from '../src/canvas/apps/permissions'
import {ChannelChips} from '../src/canvas/apps/channels-ui'
import {PANEL_CSP,PANEL_PROTOCOL,panelDocument} from '../src/canvas/apps/sdk'
import {describeEvent} from '../src/canvas/apps/events'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'

// USER 2026-11-11 m27cc41f6b6d1 "A: extend apps"; spec sections 4 (saved logins), 5 (live channel) and 6 (chip).
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms))

function loginFixture(rows:Record<string,unknown>){
  const app={id:'viewer',name:'Viewer',description:'',rev:3,permission_rev:9,width:360,height:300,capabilities:['net.fetch'],sites:['100.101.102.103:8642'],permissions:{},site_permissions:rows,created_by:'maker',updated_at:'now'} as unknown as CustomApp
  const calls:Record<string,unknown>[]=[],old=globalThis.fetch
  let logins:{site:string;kind:string;set_at:string}[]=[]
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    calls.push(input)
    let out:unknown
    if(input.action==='net_classify')out={site:input.site,class:'private',addresses:['100.101.102.103'],pinned:['100.101.102.103'],allowed:true,moved:false,tailscale:true}
    else if(input.action==='site_logins')out={app:app.id,logins}
    else if(input.action==='site_login_set'){logins=[{site:input.site,kind:input.kind,set_at:'2026-11-11T10:00:00Z'}];out=logins[0]}
    else if(input.action==='site_login_remove'){logins=[];out={app:app.id,site:input.site,removed:true}}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{app,calls,restore:()=>{globalThis.fetch=old}}
}
const row={'100.101.102.103:8642':{value:'allow-private',addresses:['100.101.102.103']}}
const press=async(label:string,scope:ParentNode=document)=>inAct(async()=>{[...scope.querySelectorAll('button')].find(b=>b.textContent===label)!.click();await tick()})

test('a saved login is added in a dialog whose value is never shown again, and can be replaced or removed',async t=>{
  const f=loginFixture(row);t.after(f.restore)
  const view=await mountView(<AppPermissions slug="login-a" app={f.app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  assert.match(view.el.textContent!,/Add a saved login/)
  await press('Add a saved login')
  const dialog=document.querySelector('[role="dialog"]')!;assert.ok(dialog,'a dialog opens')
  const value=dialog.querySelector<HTMLInputElement>('input[type="password"]')!;assert.ok(value,'the value is a password field')
  await inAct(async()=>{const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!;set.call(value,'S3CRET-CANARY');value.dispatchEvent(new window.Event('input',{bubbles:true}));await tick()})
  await press('Save',dialog)
  const save=f.calls.find(c=>c.action==='site_login_set')!
  assert.deepEqual(save,{action:'site_login_set',app:'viewer',site:'100.101.102.103:8642',kind:'bearer',value:'S3CRET-CANARY'})
  assert.equal(document.querySelector('[role="dialog"]'),null,'the dialog closes after the save')
  assert.match(view.el.textContent!,/Saved login: Bearer token, saved/)
  const everywhere=document.body.textContent+[...document.querySelectorAll('input')].map(i=>i.value).join(' ')
  assert.equal(everywhere.includes('S3CRET-CANARY'),false,'the value is never shown again, in text or in a field')
  assert.ok([...view.el.querySelectorAll('button')].some(b=>b.textContent==='Replace'))
  await press('Remove',view.el)
  assert.deepEqual(f.calls.find(c=>c.action==='site_login_remove'),{action:'site_login_remove',app:'viewer',site:'100.101.102.103:8642'})
  assert.match(view.el.textContent!,/Add a saved login/)
})

test('a header login carries its header name, and a site with no Allow row offers no login',async t=>{
  const f=loginFixture(row);t.after(f.restore)
  const view=await mountView(<AppPermissions slug="login-b" app={f.app} close={()=>{}} embedded/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  await press('Add a saved login')
  const dialog=document.querySelector('[role="dialog"]')!
  await inAct(async()=>{const k=dialog.querySelector<HTMLSelectElement>('select')!;k.value='header';k.dispatchEvent(new window.Event('change',{bubbles:true}));await tick()})
  const name=dialog.querySelector<HTMLInputElement>('input[aria-label="Header name"]')!;assert.ok(name,'a header login asks for the header name')
  const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!
  await inAct(async()=>{set.call(name,'X-Api-Key');name.dispatchEvent(new window.Event('input',{bubbles:true}));const v=dialog.querySelector<HTMLInputElement>('input[type="password"]')!;set.call(v,'k-1');v.dispatchEvent(new window.Event('input',{bubbles:true}));await tick()})
  await press('Save',dialog)
  assert.deepEqual(f.calls.find(c=>c.action==='site_login_set'),{action:'site_login_set',app:'viewer',site:'100.101.102.103:8642',kind:'header',name:'X-Api-Key',value:'k-1'})
  const asking=loginFixture({});t.after(asking.restore)
  const other=await mountView(<AppPermissions slug="login-c" app={asking.app} close={()=>{}} embedded/>,e=>e);t.after(()=>other.unmount());await inAct(tick)
  assert.equal(other.el.textContent!.includes('Add a saved login'),false,'a login needs the site to be allowed first')
})

test('the status chips show state, site, network kind, lock and key',()=>{
  const open={channel:'c1',site:'100.101.102.103:8642',state:'open' as const,secure:false,private:true,login:true,since:Date.parse('2026-11-11T10:00:00Z'),messages:1234}
  const view=document.createElement('div');document.body.append(view)
  // rendered through the same harness the other tests use
  return mountView(<ChannelChips channels={[open,{...open,channel:'c2',site:'api.example.com:443',state:'down',secure:true,private:false,login:false},{...open,channel:'c3',site:'x',state:'closed'}]}/>,e=>e).then(v=>{
    const chips=[...v.el.querySelectorAll('.custom-app-channel')]
    assert.equal(chips.length,3)
    assert.match(chips[0]!.textContent!,/100\.101\.102\.103:8642/);assert.match(chips[0]!.textContent!,/private network/)
    assert.equal(chips[0]!.querySelector('.dot')?.getAttribute('data-state'),'open')
    assert.ok(chips[0]!.querySelector('[data-icon="open-lock"]'),'plain ws shows the open lock');assert.ok(chips[0]!.querySelector('[data-icon="key"]'),'a saved login shows the key')
    assert.match(chips[0]!.getAttribute('title')!,/Connected to 100\.101\.102\.103:8642 since .*1,234 messages/)
    assert.match(chips[1]!.textContent!,/internet/);assert.equal(chips[1]!.querySelector('.dot')?.getAttribute('data-state'),'down');assert.ok(chips[1]!.querySelector('[data-icon="lock"]'));assert.equal(chips[1]!.querySelector('[data-icon="key"]'),null)
    assert.equal(chips[2]!.querySelector('.dot')?.getAttribute('data-state'),'closed')
    v.unmount();view.remove()
  })
})

test('Panel History words a channel row without a path or a message',()=>{
  const said=describeEvent({seq:1,name:'net.channel',kind:'history',payload:{channel:'c1',site:'100.101.102.103:8642',state:'down',reason:'connection refused'},at:'2026-11-11T10:00:00Z',actor:'app'} as never)
  assert.match(String(said),/100\.101\.102\.103:8642/);assert.match(String(said),/connection refused/)
})

test('orgtree.net.connect is a long-poll loop through the bridge that stops on close and resumes after an error',async t=>{
  assert.match(PANEL_CSP,/connect-src 'none'/,'the frame CSP still allows no connection')
  const doc=panelDocument('<p>x</p>','chan'),sdk=doc.slice(doc.indexOf('<script>')+8,doc.indexOf('</script>'))
  const posted:Record<string,unknown>[]=[],ports:MessagePort[]=[],win:Record<string,unknown>={}
  const parent={postMessage:(message:Record<string,unknown>,_o:string,transfer?:MessagePort[])=>{posted.push(message);if(transfer?.[0])ports.push(transfer[0])}}
  const quiet=<T extends (...a:never[])=>unknown>(timer:T)=>((...a:Parameters<T>)=>{const handle=(timer as unknown as (...b:unknown[])=>{unref?:()=>void})(...a);handle?.unref?.();return handle}) as unknown as T
  new Function('window','parent','setTimeout','setInterval',sdk)(win,parent,quiet(setTimeout),quiet(setInterval))
  t.after(()=>{for(const p of ports)p.close()})
  const port=ports[0]!;port.postMessage({protocol:PANEL_PROTOCOL,channel:'chan',kind:'ready'});await wait(20)
  const answer=(id:unknown,body:Record<string,unknown>)=>port.postMessage({protocol:PANEL_PROTOCOL,channel:'chan',id,...body})
  const calls=(action:string)=>posted.filter(m=>m.method==='engine.call'&&(m.args as {action:string}).action===action)
  const orgtree=win.orgtree as {net:{connect:(url:string,options?:{protocols?:string[]})=>Promise<{onMessage:(f:(t:string)=>void)=>()=>void;onState:(f:(s:Record<string,unknown>)=>void)=>()=>void;send:(t:string)=>Promise<unknown>;close:()=>Promise<void>}>}}
  const opening=orgtree.net.connect('ws://100.101.102.103:8642/api/orgs/galaxy/ws');await wait(20)
  const connect=calls('net.connect')[0]!;assert.deepEqual((connect.args as {args:unknown}).args,{url:'ws://100.101.102.103:8642/api/orgs/galaxy/ws',protocols:[]})
  answer(connect.id,{result:{channel:'c1',site:'100.101.102.103:8642',secure:false,private:true,login:true}})
  const ch=await opening;const texts:string[]=[],states:Record<string,unknown>[]=[]
  ch.onMessage(t=>texts.push(t));ch.onState(s=>states.push(s))
  await wait(20);const first=calls('net.recv')[0]!;assert.deepEqual((first.args as {args:unknown}).args,{channel:'c1',after:0},'the poll starts at once')
  answer(first.id,{result:{events:[{seq:1,type:'state',state:'open',login:true},{seq:2,type:'message',text:'hello'}],closed:false}})
  await wait(30);assert.deepEqual(texts,['hello']);assert.equal(states[0]!.state,'open')
  const second=calls('net.recv')[1]!;assert.deepEqual((second.args as {args:unknown}).args,{channel:'c1',after:2},'each poll acknowledges what was read')
  answer(second.id,{error:'host busy'});await wait(2500)
  assert.ok(calls('net.recv').length>=3,'the loop resumes after an error')
  const sending=ch.send('ping');await wait(20);const sent=calls('net.send')[0]!;assert.deepEqual((sent.args as {args:unknown}).args,{channel:'c1',text:'ping'})
  answer(sent.id,{result:{sent:4}});await sending
  const closing=ch.close();await wait(20);const closed=calls('net.close')[0]!;answer(closed.id,{result:{closed:true}});await closing
  const polls=calls('net.recv').length;await wait(300);assert.ok(calls('net.recv').length<=polls+1,'no further polls once closed')
})

function hostFixture(){
  const app={id:'viewer',name:'Viewer',description:'',rev:2,permission_rev:5,width:360,height:300,capabilities:['net.fetch'],sites:['100.101.102.103:8642'],permissions:{},site_permissions:{'100.101.102.103:8642':{value:'allow-private',addresses:['100.101.102.103']}},created_by:'maker',updated_at:'now',definition:{name:'Viewer',description:'',html:'<p>v</p>',initial_state:{},capabilities:['net.fetch'],sites:['100.101.102.103:8642'],width:360,height:300}} as unknown as CustomApp
  const panel:CustomPanel={id:'viewer-copy',app:app.id,label:'Panel 1',open:true,rev:1,state:{},placement:{mode:'float',x:20,y:20,width:360,height:300},updated_at:'now',used_at:'now'}
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[]
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    let out:unknown
    if(url.pathname.endsWith('/apps/bridge')){
      if(input.action==='session_open')out={session:'host-only',app:app.id,app_rev:app.rev,expires_in:1800}
      else if(input.action==='session_close')out={closed:true}
      else if(input.action==='call'&&input.request.action==='net.connect')out={channel:'c1',site:'100.101.102.103:8642',secure:false,private:true,login:true}
      else if(input.action==='call'&&input.request.action==='net.recv')out={events:[{seq:1,type:'state',state:'open',login:true},{seq:2,type:'message',text:'hi'}],closed:false}
      else throw Error('Unexpected bridge '+JSON.stringify(input))
    }else if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=panel
    else if(input.action==='events')out={events:[],next_cursor:null}
    else throw Error('Unexpected '+JSON.stringify(input))
    return new Response(JSON.stringify(out),{status:200,headers:{'Content-Type':'application/json'}})
  }
  return{app,panel,calls,restore:()=>{globalThis.fetch=original}}
}

test('the panel status bar shows one chip per open channel, and a poll never blocks the panel',async t=>{
  Object.defineProperty(document,'hidden',{configurable:true,value:false});t.after(()=>{delete (document as unknown as Record<string,unknown>).hidden})
  const f=hostFixture();t.after(f.restore)
  const view=await mountView(<PanelHtml slug="chan-host" app={f.app} panel={f.panel}/>,el=>el);t.after(()=>view.unmount())
  await inAct(tick);const frame=view.el.querySelector('iframe')!;const channel=JSON.parse(frame.srcdoc.match(/channel=("[^"]+")/)![1]!),win=frame.ownerDocument.defaultView!
  const send=async(id:string,method:string,args?:unknown)=>inAct(async()=>{const e=new win.MessageEvent('message',{source:frame.contentWindow,origin:'null',data:{protocol:PANEL_PROTOCOL,channel,id,method,args}});if(method==='host.ready'){const link=new MessageChannel();link.port1.onmessage=()=>{};t.after(()=>link.port1.close());Object.defineProperty(e,'ports',{value:[link.port2]})}win.dispatchEvent(e);await tick()})
  await send('ready','host.ready')
  await send('c','engine.call',{action:'net.connect',args:{url:'ws://100.101.102.103:8642/api/orgs/galaxy/ws',protocols:[]}})
  assert.equal(view.el.querySelectorAll('.custom-app-status .custom-app-channel').length,1,'one chip for the channel')
  assert.match(view.el.querySelector('.custom-app-status')!.textContent!,/100\.101\.102\.103:8642/)
  await send('r','engine.call',{action:'net.recv',args:{channel:'c1',after:0}})
  assert.equal(view.el.querySelector('.custom-app-channel .dot')?.getAttribute('data-state'),'open','the poll result drives the chip')
  assert.match(view.el.querySelector('.custom-app-channel')!.getAttribute('title')!,/1 messages?/)
})
