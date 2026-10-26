import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'

// User 2026-10-26 Apps rulings: saved copies keep their creation order ("Fixed order"),
// the app row opens the most recently used copy (provisional, independent of the
// list order) or creates one, + always creates, panel links and screen pins are gone.
const tick=async()=>{for(let i=0;i<5;i++)await flush()}
type Panel={id:string;app:string;label:string;rev:number;open:boolean;state:Record<string,unknown>;event_seq:number;placement:{mode:string;x:number;y:number;width:number;height:number;anchor?:string|null};created_at:string;used_at:string;updated_at:string}
const copy=(id:string,label:string,used:string,open=false,mode='float'):Panel=>({id,app:'notes',label,rev:1,open,state:{},event_seq:0,placement:{mode,x:40,y:40,width:360,height:280},created_at:used,used_at:used,updated_at:''})
function fixture(t:test.TestContext,panels:Panel[]){
 const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:['mail.send'],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{},capabilities:['mail.send'],width:360,height:280}}
 const calls:Record<string,any>[]=[],original=globalThis.fetch
 globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
  if(input.action==='list')out={items:input.kind==='apps'?[app]:panels.filter(p=>input.open===undefined||p.open===input.open),next_cursor:null,new_count:0}
  else if(input.action==='app_get')out=app
  else if(input.action==='panel_get')out=panels.find(p=>p.id===input.panel)
  else if(input.action==='events')out={events:[],next_cursor:null,oldest_retained:null}
  else if(input.action==='session_close')out={}
  else if(input.action==='panel_open'){let p=input.panel?panels.find(p=>p.id===input.panel):undefined;if(!p){p=copy('p'+(panels.length+1),'Panel '+(panels.length+1),'2026-10-27');panels.push(p)}p.open=true;p.rev++;out=p}
  else if(input.action==='panel_update'){const p=panels.find(p=>p.id===input.panel)!;assert.equal(input.expected_rev,p.rev);for(const k of ['label','open','placement'])if(k in input)(p as Record<string,unknown>)[k]=input[k];p.rev++;out=p}
  else throw Error('Unexpected '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
 };t.after(()=>{globalThis.fetch=original})
 return {calls,panels}
}

test('the app row opens the most recently used copy, + always creates one, and neither + nor the gear triggers the row',async t=>{
 const {calls}=fixture(t,[copy('older','Draft','2026-10-25'),copy('newer','Panel 2','2026-10-26')])
 const view=await mountView(<><AppsButton slug="row-case"/><AppsWorkspace slug="row-case"/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 const menu=async()=>{await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()});return document.querySelector<HTMLElement>('.custom-apps-menu')!}
 const opens=()=>calls.filter(c=>c.action==='panel_open')
 let m=await menu()
 assert.equal(!!m.querySelector('.custom-apps-new'),false,'the separate "+ New panel" row is gone')
 assert.equal([...m.querySelectorAll('button')].some(b=>b.textContent?.trim()==='+ New panel'),false)
 assert.deepEqual([...m.querySelectorAll('.custom-apps-saved-row .custom-apps-saved span:nth-child(2)')].map(e=>e.textContent),['Draft','Panel 2'],'saved rows keep their creation order')
 // User 2026-10-26: no Open/Closed word; the light alone shows state, named in the tooltip.
 const rows=()=>[...document.querySelectorAll<HTMLElement>('.custom-apps-menu .custom-apps-saved')].map(b=>[b.textContent,b.title,b.getAttribute('aria-label'),b.querySelector('.custom-app-dot')?.className])
 assert.deepEqual(rows(),[['Draft','Off','Draft, off','custom-app-dot'],['Panel 2','Off','Panel 2, off','custom-app-dot']])
 assert.equal(m.querySelector('.custom-apps-open')!.getAttribute('title'),'Open Panel 2','the app row names the most recently used copy')
 await inAct(async()=>{m.querySelector<HTMLButtonElement>('.custom-apps-open')!.click();await tick()})
 assert.deepEqual(opens().at(-1),{action:'panel_open',panel:'newer'},'the app row opens the most recently used copy, wherever it is listed')
 m=await menu();assert.deepEqual(rows()[1],['Panel 2','Running · visible','Panel 2, running · visible','custom-app-dot open'],'an open copy lights its dot and keeps its place')
 await inAct(async()=>{m.querySelector<HTMLElement>('.custom-apps-menu-app small')!.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await tick()})
 assert.deepEqual(opens().at(-1),{action:'panel_open',panel:'newer'},'a click anywhere on the row opens it')
 const before=opens().length;m=await menu()
 await inAct(async()=>{m.querySelector<HTMLButtonElement>('.custom-apps-menu-app [aria-label="New panel for Notes"]')!.click();await tick()})
 assert.equal(opens().length,before+1,'+ makes exactly one request; the row does not also open');assert.deepEqual(opens().at(-1),{action:'panel_open',app:'notes',new:true})
 m=await menu();await inAct(async()=>{m.querySelector<HTMLButtonElement>('.custom-apps-menu-app [aria-label="Settings for Notes"]')!.click();await tick()})
 assert.equal(opens().length,before+1,'the app gear never opens a panel');assert.ok(document.querySelector('[role="dialog"][aria-label="App settings"]'))
})

test('an app without saved copies creates and opens its first panel from the row',async t=>{
 const {calls,panels}=fixture(t,[])
 const view=await mountView(<><AppsButton slug="first-case"/><AppsWorkspace slug="first-case"/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
 await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('.apps-button')!.click();await tick()})
 const open=document.querySelector<HTMLButtonElement>('.custom-apps-menu .custom-apps-open')!;assert.equal(open.getAttribute('title'),'Create a panel for Notes')
 await inAct(async()=>{open.click();await tick()})
 assert.deepEqual(calls.filter(c=>c.action==='panel_open'),[{action:'panel_open',app:'notes'}],'the engine creates a copy only when none exists')
 assert.ok(document.querySelector(`[data-custom-panel="${panels[0]!.id}"]`),'a user-created panel opens immediately')
})
