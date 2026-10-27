import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {AppActionClient} from '../src/canvas/apps/actions'
import {panelDocument} from '../src/canvas/apps/sdk'
import {PanelSettings} from '../src/canvas/apps/settings'

test('named broadcast API refuses chosen recipients before opening a host session',async t=>{
  const original=globalThis.fetch,calls:unknown[]=[];globalThis.fetch=async(_raw,init)=>{const input=JSON.parse(String(init?.body));calls.push(input);return new Response(JSON.stringify(input.action==='session_open'?{session:'bound-secret',app:'notes',app_rev:1,expires_in:1800}:{accepted:true}))};t.after(()=>{globalThis.fetch=original})
  const client=new AppActionClient('events','notes',1,'one',async()=>null);t.after(()=>client.dispose())
  await assert.rejects(()=>client.call({action:'events.fire',args:{target:'chosen-agent',name:'submitted',payload:{}}}))
  assert.equal(calls.length,0,'refused identity selectors make no authenticated request')
  assert.deepEqual(await client.call({action:'events.fire',args:{name:'submitted',payload:{note:'data'}}}),{accepted:true})
})

test('named event SDK exposes broadcast separately from panel activity',async()=>{
  const sent:Record<string,unknown>[]=[],ports:{onmessage?:(e:{data:unknown})=>void}[]=[]
  const context={window:{} as Record<string,any>,parent:{postMessage:(m:Record<string,unknown>)=>sent.push(m)},setInterval:()=>1,setTimeout:()=>1,clearInterval:()=>{},clearTimeout:()=>{},MessageChannel:class{port1={close(){},start(){},onmessage:undefined as undefined|((e:{data:unknown})=>void)};port2={};constructor(){ports.push(this.port1)}}}
  vm.runInNewContext(panelDocument('<p>App</p>','test-channel').match(/<script>([\s\S]*?)<\/script>/)![1],context)
  ports[0].onmessage!({data:{protocol:'orgtree-panel-v1',channel:'test-channel',kind:'ready'}})
  assert.equal(typeof context.window.orgtree.events?.fire,'function','the SDK must offer named broadcasts')
  const pending=context.window.orgtree.events.fire('submitted',{note:'data'}),message=sent.at(-1)!
  assert.equal(message.method,'engine.call');assert.deepEqual(JSON.parse(JSON.stringify(message.args)),{action:'events.fire',args:{name:'submitted',payload:{note:'data'}}})
  ports[0].onmessage!({data:{protocol:'orgtree-panel-v1',channel:'test-channel',id:message.id,result:{accepted:true}}});assert.equal((await pending).accepted,true)
  context.window.orgtree.emit('activity',{});assert.equal(sent.at(-1)?.method,'event.emit')
})

test('Panel settings lists connections and fires only the selected saved copy event',async t=>{
  const app={id:'notes',name:'Notes',description:'',rev:1,width:360,height:280,capabilities:['events.fire'],events:[{name:'submitted',description:'Notes ready'}],permissions:{},created_by:'maker',updated_at:''}
  const panel={id:'one',app:'notes',label:'First',rev:1,open:false,placement:{mode:'float' as const,x:0,y:0,width:360,height:280},used_at:'',event_seq:2,updated_at:''}
  const original=globalThis.fetch,calls:Record<string,unknown>[]=[]
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
    if(input.action==='list')out={items:input.kind==='apps'?[app]:[panel],next_cursor:null}
    else if(input.action==='listeners')out={items:[{id:'worker/notes',owner:'worker',name:'notes',event_name:'submitted',panel:'one',state:'armed',once:false,notice:true,fired:0}],next_cursor:null}
    else if(input.action==='fire_event')out={accepted:true,subscribers:1,event:'accepted-event'}
    else if(input.action==='events')out={panel:'one',events:[{seq:1,name:'panel.started',payload:{reason:'opened'},actor:'user',at:'2026-10-26T10:00:00Z'},{seq:2,name:'event.fired',payload:{event:'submitted',id:'accepted-event',subscribers:1},actor:'user',at:'2026-10-26T10:01:00Z'},{seq:3,name:'panel.stopped',payload:{reason:'stop all'},actor:'user',at:'2026-10-26T10:02:00Z'}],next_cursor:null,oldest_retained:1}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelSettings slug="events-settings" app={app} panel={panel} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(async()=>{for(let i=0;i<5;i++)await flush()})
  assert.equal([...document.querySelectorAll('button')].some(b=>['Events…','Activity…'].includes(b.textContent?.trim()??'')),false,'events moved to their own History tab')
  // User 2026-10-26: "put connections and fire event on their own tabs"; History keeps only the copy's log.
  const tab=async(name:string)=>{const button=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()===name);assert.ok(!!button,name+' has its own settings tab');await inAct(async()=>{button!.click();for(let i=0;i<5;i++)await flush()});return document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!}
  const connections=await tab('Connections')
  assert.ok(connections.textContent?.includes('worker/notes'),'actual agent-owned connection is listed')
  const log=await tab('History')
  const entries=[...log.querySelectorAll('ol[aria-label="History"] > li > button')].map(e=>e.textContent??'')
  // User 2026-10-26 md6edfebc1975: only fired events agents can listen to, and the copy starting and stopping.
  assert.equal(entries.length,3,'History lists the copy log');assert.match(entries[0]!,/Stopped.*Stop all.*You/,'newest first; a stop names its cause');assert.match(entries[1]!,/Fired submitted.*1 listener.*You/,'fire metadata');assert.match(entries[2]!,/Started.*Opened.*You/,'opening a stopped copy starts it')
  assert.match(log.querySelector('.set-group > p.dim:first-child')?.textContent??'',/^Fired events agents can listen to, and this copy starting and stopping, newest first\./,'the lead line says what History records, in the lead-line style of the other tabs')
  assert.ok(calls.filter(c=>c.action==='events').every(c=>!('messages' in c)),'History reads the History listing, never messages')
  assert.equal(log.textContent?.includes('worker/notes'),false,'connections are not on the History tab');assert.equal(!!log.querySelector('[aria-label="Declared event"]'),false,'Fire event is not on the History tab')
  const fireTab=await tab('Fire event')
  const fire=[...fireTab.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()==='Fire event');assert.ok(fire)
  assert.equal(calls.some(c=>c.action==='fire_event'),false,'opening settings never fires')
  await inAct(async()=>{fire.click();for(let i=0;i<5;i++)await flush()})
  assert.deepEqual(calls.find(c=>c.action==='fire_event'),{action:'fire_event',panel:'one',name:'submitted',payload:{}})
})

// USER 2026-10-26: agents hear apps only through events ("Remove; import, never grant").
test('mail.send was removed: the action fails with directions to events before any request',async t=>{
  const original=globalThis.fetch,calls:unknown[]=[];globalThis.fetch=async(_raw,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({session:'bound',app:'notes',app_rev:1,expires_in:1800}))};t.after(()=>{globalThis.fetch=original})
  const client=new AppActionClient('mail-removed','notes',1,'one',async()=>null);t.after(()=>client.dispose())
  await assert.rejects(()=>client.call({action:'mail.send',args:{to:'worker',body:'notes'}}),/apps notify agents only through events.*orgtree\.events\.fire/)
  assert.equal(calls.length,0,'a removed action opens no host session and sends nothing')
})
