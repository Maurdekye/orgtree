import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type {ReactNode} from 'react'
import * as appsStore from '../src/canvas/apps/store'
import {AppsRefRoutes} from '../src/canvas/apps/events'
import {PanelSettings} from '../src/canvas/apps/settings'
import {useRefRoutes} from '../src/canvas/reflinks'

// USER 2026-10-27, Panel settings > Connections: m6ca9f88d5812 "should be links to the
// agent and the panel"; md11c3c790acf "actually remove the refresh button, make new or
// disappearing links change in realtime as they're modified"; m8ced6e920f63 "each row
// of the connections list shows an agent link, a panel link, an event name, and can be
// expanded to see a list of recent fires (which is a scrollable and lazily loads more as
// you move, each one expandable like in event history)".
const tick=async()=>{for(let i=0;i<8;i++)await flush()}
const app={id:'caption-placement',name:'Caption placement',description:'',rev:1,width:360,height:280,capabilities:['events.fire'],events:[{name:'placements.submitted'}],permissions:{},created_by:'maker',updated_at:''}
const panel={id:'caption-placement-panel-1',app:'caption-placement',label:'Orgtree School 1 captions',rev:1,open:true,running:true,placement:{mode:'float' as const,x:0,y:0,width:360,height:280},used_at:'',event_seq:0,updated_at:''}
type Sub={id:string;owner:string;name:string;event_name:string;panel:string|null;all_panels:boolean;state:string;once:boolean;notice:boolean;fired:number;reason?:string|null}
const liaison:Sub={id:'liaison-opus/caption-placements-test',owner:'liaison-opus',name:'caption-placements-test',event_name:'placements.submitted',panel:panel.id,all_panels:false,state:'armed',once:false,notice:false,fired:1}
const worker:Sub={id:'worker/every-copy',owner:'worker',name:'every-copy',event_name:'placements.submitted',panel:null,all_panels:true,state:'paused',once:true,notice:true,fired:0,reason:'app event or saved panel was removed'}
type Fire={seq:number;id:string;at:string;event:string;panel:string;panel_label:string;by:string;delivered:boolean;notice:boolean;body:string|null}
const t0=Date.UTC(2026,9,27,12,0,0)
const fire=(seq:number):Fire=>({seq,body:seq===1?null:JSON.stringify({placements:[{line:seq,x:12.5}]}),id:'app-event-'+seq,at:new Date(t0+seq*60000).toISOString(),event:'placements.submitted',panel:panel.id,panel_label:panel.label,by:seq%3===0?'app':seq%3===1?'user':'liaison-opus',delivered:seq!==2,notice:false})
// the live tree's agents, as App's shell routes hold them
const agents=new Map([['liaison-opus',{tier:'opus'}],['worker',{tier:'sonnet'}]])

function serve(t:{after:(fn:()=>void)=>void},state:{subs:Sub[];fires:Fire[]}){
  const calls:Record<string,any>[]=[],methods:string[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);methods.push(init?.method??'GET');let out:unknown
    if(input.action==='listeners'){assert.equal(input.app,app.id);assert.equal(input.panel,panel.id);out={items:state.subs,next_cursor:null}}
    else if(input.action==='listener_fires'){
      // The engine's contract: newest first, before walks back, after follows newer fires oldest first.
      const n=Number(input.limit??100),from=input.after!==undefined?state.fires.filter(f=>f.seq>input.after):state.fires.filter(f=>f.seq<(input.before??Infinity)).reverse(),fires=from.slice(0,n)
      out={listener:input.listener,fires,next_cursor:from.length>n?fires.at(-1)!.seq:null}
    }
    else if(input.action==='refs')out={apps:[],panels:(input.panels??[]).filter((id:string)=>id===panel.id).map((id:string)=>({asked:id,id,app:app.id,app_name:app.name,label:panel.label,open:true,running:true}))}
    else if(input.action==='panel_open')out={...panel}
    else if(input.action==='list')out={items:[],next_cursor:null}
    else if(input.action==='events')out={panel:panel.id,events:[],next_cursor:null}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  return {calls,methods}
}
/** App's shell routes (useShellRefs is useRefRoutes over the tree's agents). */
function Shell({slug,focused,children}:{slug:string;focused:string[];children:ReactNode}){
  const routes=useRefRoutes(slug,agents,{onFocusAgent:id=>{focused.push(id)}})
  return <AppsRefRoutes.Provider value={routes}>{children}</AppsRefRoutes.Provider>
}
async function connections(slug:string,focused:string[],closed:string[]){
  const view=await mountView(<Shell slug={slug} focused={focused}><PanelSettings slug={slug} app={app} panel={panel} close={()=>{closed.push('settings')}}/></Shell>,e=>e);await inAct(tick)
  const tab=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()==='Connections')!
  await inAct(async()=>{tab.click();await tick()})
  return {view,body:document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!}
}
const rows=(body:HTMLElement)=>[...body.querySelectorAll<HTMLElement>('ul[aria-label="Connections"] > li:not(.custom-app-log-more)')]

test('Connections rows link their agent and panel, name their event, and follow subscriptions live with no buttons',async t=>{
  const state={subs:[liaison],fires:[] as Fire[]},{calls}=serve(t,state),focused:string[]=[],closed:string[]=[]
  const slug='connections-live',{view,body}=await connections(slug,focused,closed);t.after(()=>view.unmount())
  assert.equal([...body.querySelectorAll('button')].some(b=>/refresh|more connections/i.test((b.textContent??'')+(b.getAttribute('aria-label')??'')+(b.title??''))),false,'no Refresh or More button: the list is live')
  assert.equal(body.querySelector('.usage-refresh-button'),null,'not even a refresh icon')
  const [row]=rows(body);assert.ok(row,'the subscription is listed')
  const agent=row!.querySelector<HTMLButtonElement>('button.ref-chip.ref-agent')
  assert.ok(agent,'the agent is an agent link');assert.match(agent!.textContent??'',/liaison-opus$/)
  const target=row!.querySelector<HTMLButtonElement>('button.ref-chip.ref-panel')
  assert.ok(target,'the panel is a panel link');assert.equal(target!.textContent,'Orgtree School 1 captions',"this copy's link names the copy: its app is the window's")
  assert.equal(row!.querySelector('.custom-app-connection-event')?.textContent,'placements.submitted','the row names its event')
  assert.equal(row!.querySelector('.custom-app-connection-meta')?.textContent,'1 fire','armed and wake are the defaults: only the count shows')
  assert.equal(row!.textContent?.includes('caption-placements-test'),false,'the watchdog handle waits in the expanded row')

  // A new subscription appears, and a removed one disappears, with no user action.
  const reads=()=>calls.filter(c=>c.action==='listeners').length,before=reads(),history=calls.filter(c=>c.action==='events').length
  state.subs=[liaison,worker]
  await inAct(async()=>{assert.equal(appsStore.customAppsFeed(slug,{type:'watchdogs_changed'}),true,'the Apps feed takes the watchdog frame');await tick()})
  assert.equal(reads(),before+1,'one bounded read per change')
  assert.equal(rows(body).length,2,'the new subscription appeared')
  const every=rows(body)[1]!
  assert.equal(every.querySelector('button.ref-chip.ref-panel'),null,'a subscription to every copy names no panel');assert.match(every.textContent??'',/All copies/)
  assert.equal(every.querySelector('.custom-app-connection-meta')?.textContent,'Paused · Notice · Once · 0 fires','paused, notice and once show when they apply')
  state.subs=[worker]
  await inAct(async()=>{appsStore.customAppsFeed(slug,{type:'watchdogs_changed'});await tick()})
  assert.deepEqual(rows(body).map(r=>r.querySelector('button.ref-chip.ref-agent')?.textContent?.replace(/^.*?(worker|liaison-opus)$/,'$1')),['worker'],'the removed subscription disappeared')
  assert.equal(calls.filter(c=>c.action==='events').length,history,'a watchdog change does not reread History')

  // The links open what they name, and a centered settings window gets out of the way first.
  state.subs=[liaison]
  await inAct(async()=>{appsStore.customAppsFeed(slug,{type:'watchdogs_changed'});await tick()})
  await inAct(async()=>{rows(body)[0]!.querySelector<HTMLButtonElement>('button.ref-chip.ref-agent')!.click();await tick()})
  assert.deepEqual(focused,['liaison-opus'],'the agent link focuses that agent, like the shell\'s other agent links');assert.deepEqual(closed,['settings'])
  await inAct(async()=>{rows(body)[0]!.querySelector<HTMLButtonElement>('button.ref-chip.ref-panel')!.click();await tick()})
  assert.deepEqual(calls.filter(c=>c.action==='panel_open').map(c=>c.panel),[panel.id],'the panel link opens that panel, as its Apps row does');assert.deepEqual(closed,['settings','settings'])
})

test('A Connections row expands to its fires: newest first, older ones on scroll, each expands like History, new ones arrive live',async t=>{
  const state={subs:[liaison],fires:Array.from({length:60},(_,i)=>fire(i+1))},{calls,methods}=serve(t,state)
  const slug='connections-fires',{view,body}=await connections(slug,[],[]);t.after(()=>view.unmount())
  const [row]=rows(body),toggle=row!.querySelector<HTMLButtonElement>('button.custom-app-connection-toggle')!
  assert.equal(toggle.getAttribute('aria-expanded'),'false');assert.equal(calls.some(c=>c.action==='listener_fires'),false,'fires load only when a row expands')
  await inAct(async()=>{toggle.click();await tick()})
  assert.equal(toggle.getAttribute('aria-expanded'),'true')
  const region=document.getElementById(toggle.getAttribute('aria-controls')??'')!;assert.ok(region&&row!.contains(region),'the chevron controls its row\'s fires')
  assert.match(region.querySelector('p')?.textContent??'',/^Watchdog liaison-opus\/caption-placements-test: armed, wakes its agent on each fire\./)
  const firesRead=()=>calls.filter(c=>c.action==='listener_fires')
  assert.deepEqual(firesRead(),[{action:'listener_fires',app:app.id,listener:liaison.id,limit:50}],'the newest page of that subscription\'s fires')
  assert.equal(methods[calls.indexOf(firesRead()[0]!)],'GET','reading fires is a read')
  const list=region.querySelector<HTMLElement>('ol[aria-label="Fires of liaison-opus/caption-placements-test"]')!;assert.ok(list,'the fires are a list')
  const items=()=>[...list.querySelectorAll<HTMLButtonElement>(':scope > li > button[aria-expanded]')]
  assert.equal(items().length,50);assert.match(items()[0]!.textContent??'',/Fired placements\.submitted.*Delivered.*app/,'newest first: event, delivery and who fired it')
  assert.match(items()[49]!.textContent??'',/Delivered.*liaison-opus/)

  // Older fires load as the list's end scrolls into view.
  Object.defineProperties(list,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:240},scrollTop:{configurable:true,value:1760}})
  await inAct(async()=>{list.dispatchEvent(new window.Event('scroll',{bubbles:true}));await tick()})
  assert.deepEqual(firesRead().at(-1),{action:'listener_fires',app:app.id,listener:liaison.id,limit:50,before:11})
  assert.equal(items().length,60,'the list ends at the oldest fire kept');assert.match(items()[58]!.textContent??'',/Not delivered/)

  // A fire expands like a History row.
  const first=items()[0]!
  await inAct(async()=>{first.click();await tick()})
  const details=document.getElementById(first.getAttribute('aria-controls')??'')!
  assert.match(details.textContent??'',/Delivery.*Woke the agent with the event in its mail/);assert.match(details.textContent??'',/Event IDapp-event-60/)
  // the fire's body as it was sent, as its History entry keeps it (USER 2026-10-27 mc308cabf3c5f)
  assert.equal(details.querySelector('pre[aria-label="Event body"]')?.textContent,'{\n  "placements": [\n    {\n      "line": 60,\n      "x": 12.5\n    }\n  ]\n}')
  assert.match(details.textContent??'',/Body37 bytes as sent/)

  // A newly delivered fire arrives without any action.
  state.fires.push({...fire(61),by:'user'})
  await inAct(async()=>{appsStore.customAppsFeed(slug,{type:'watchdogs_changed'});await tick()})
  assert.deepEqual(firesRead().at(-1),{action:'listener_fires',app:app.id,listener:liaison.id,limit:50,after:60},'it reads only fires newer than the newest shown')
  assert.match(items()[0]!.textContent??'',/Fired placements\.submitted.*You/);assert.equal(items().length,61)
  await inAct(async()=>{toggle.click();await tick()})
  assert.equal(row!.querySelector('ol'),null,'the row collapses again')
})
