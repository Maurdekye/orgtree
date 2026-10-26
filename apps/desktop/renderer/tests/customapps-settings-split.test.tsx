import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const dialog=(name:string)=>document.querySelector<HTMLElement>('[role="dialog"][aria-label="'+name+'"]')
const button=(root:ParentNode,name:string)=>[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===name)!
async function setup(t:test.TestContext,slug:string,open=false){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:['events.fire','files.read','files.write'],events:[{name:'submitted'}],permissions:{'events.fire':'deny'},created_by:'maker',updated_at:''}
 const copy=(id:string,label:string,isOpen:boolean)=>({id,app:'notes',label,rev:1,open:isOpen,state:{note:id},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},linked_agents:[],used_at:id==='one'?'2026-10-26':'2026-10-25',updated_at:''})
 const panels=[copy('one','First notes',open),copy('two','Closed notes',false)],calls:Record<string,any>[]=[]
 const original=globalThis.fetch
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
   if(url.pathname.endsWith('/files')){
    if(input.action==='permissions')out={rev:1,permission_rev:1,grants:[{id:'grant',mode:'read',scope:'orgtree',name:'Orgtree files'}]}
    else if(input.action==='confirmations')out={items:[{challenge:'change',agent:'worker',detail:{path:'Synthetic.txt',operation:'create',previous_bytes:null,bytes:4,sha256:'digest'}}]}
    else if(input.action==='revoke')out={rev:1,permission_rev:2,grants:[]}
    else if(input.action==='confirm')out={}
    else throw Error('Unexpected files '+input.action)
   }else if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>!input.open||p.open),next_cursor:null,new_count:0}
   else if(input.action==='panel_get')out=panels.find(p=>p.id===input.panel)
   else if(input.action==='app_get')out=app
   else if(input.action==='session_close')out={}
   else if(input.action==='permission_set'){app.permissions[input.capability as 'events.fire']=input.permission;app.permission_rev++;out=app}
   else if(input.action==='panel_update'){const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);Object.assign(p,input);p.rev++;out=p}
   else if(input.action==='events')out={events:[],next_cursor:null}
   else if(input.action==='listeners')out={items:[],next_cursor:null}
   else throw Error('Unexpected '+input.action)
   return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
 const view=await mountView(<><AppsButton slug={slug}/><AppsWorkspace slug={slug}/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 return{view,calls,panels,openMenu:async()=>{await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})}}
}

test('app-list gear opens only app-wide settings and preserves Files and event permissions',async t=>{
 const {openMenu,calls}=await setup(t,'settings-app');await openMenu()
 await inAct(async()=>{document.querySelector<HTMLButtonElement>('[aria-label="Settings for Notes"]')!.click();await tick()})
 const app=dialog('App settings')!;assert.ok(app?.classList.contains('settings'))
 assert.equal(!!app.querySelector('[aria-label="Saved panel"]'),false,'app settings must not choose or edit a panel')
 assert.equal(!!button(app,'State…'),false,'panel actions do not belong in App settings')
 for(const name of ['Created by','Permissions…','Export app','Delete app…'])assert.ok(app.textContent?.includes(name))
 await inAct(async()=>{button(app,'Permissions…').click();await tick()})
 const permissions=dialog('App permissions')!;assert.ok(permissions.textContent?.includes('Files'));assert.ok(button(permissions,'Revoke'));assert.ok(button(permissions,'Confirm change'))
 const event=permissions.querySelector<HTMLSelectElement>('[aria-label="events.fire permission"]')!;assert.equal(event.value,'deny')
 await inAct(async()=>{event.value='allow';event.dispatchEvent(new Event('change',{bubbles:true}));await tick()})
 assert.ok(calls.some(c=>c.action==='permission_set'&&c.app==='notes'&&c.capability==='events.fire'&&c.permission==='allow'))
 assert.equal(calls.some(c=>c.action==='panel_open'||c.action==='panel_update'),false,'app management never opens or mutates a copy')
})

test('closed saved-panel row has its own gear and edits exactly that copy without opening HTML',async t=>{
 const {openMenu,calls}=await setup(t,'settings-closed');await openMenu()
 const gear=document.querySelector<HTMLButtonElement>('.custom-apps-saved-row [aria-label="Settings for Closed notes"]');assert.equal(!!gear,true,'each closed panel needs an independent settings gear')
 await inAct(async()=>{gear!.click();await tick()});const settings=dialog('Panel settings')!;assert.ok(!!settings)
 assert.match(settings.textContent!,/Closed notes/);assert.equal(!!button(settings,'Export app'),false);assert.equal(!!button(settings,'Delete app…'),false);assert.equal(!!button(settings,'Permissions…'),false)
 await inAct(async()=>{button(settings,'State…').click();await tick()})
 assert.equal(JSON.parse(document.querySelector<HTMLTextAreaElement>('[aria-label="Panel JSON state"]')!.value).note,'two')
 await inAct(async()=>{button(document.querySelector('[aria-label="Closed notes: state"]')!,'Cancel').click();await tick();button(settings,'Rename…').click();await tick()})
 const input=document.querySelector<HTMLTextAreaElement>('[aria-label="Panel label"]')!;await inAct(async()=>{const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!;setter.call(input,'Renamed closed copy');input.dispatchEvent(new Event('input',{bubbles:true}));button(document.querySelector('[aria-label="Rename panel"]')!,'Save').click();await tick()})
 assert.ok(calls.some(c=>c.action==='panel_update'&&c.panel==='two'))
 assert.equal(calls.some(c=>c.action==='panel_open'||c.action==='session_open'||c.action==='session_init'),false,'closed-panel settings never instantiate app HTML')
})

test('open-panel header gear opens panel-only settings with every retained copy action',async t=>{
 const {view,calls}=await setup(t,'settings-open',true)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('[data-custom-panel="one"] [aria-label="Settings for First notes"]')!.click();await tick()})
 const settings=dialog('Panel settings');assert.equal(!!settings,true,'header gear must open per-panel settings')
 for(const name of ['State…','Rename…','Linked agents…','Activity…','Events…','Duplicate','Float','Pin to screen','Pin to canvas','Delete panel…'])assert.ok(!!button(settings!,name),'missing '+name)
 assert.equal(!!button(settings!,'Permissions…'),false);assert.equal(!!button(settings!,'Delete app…'),false)
 await inAct(async()=>{button(settings!,'Events…').click();await tick()})
 assert.ok(calls.some(c=>c.action==='listeners'&&c.panel==='one'))
 assert.equal(calls.some(c=>c.action==='fire_event'),false,'viewing connections never fires')
})
