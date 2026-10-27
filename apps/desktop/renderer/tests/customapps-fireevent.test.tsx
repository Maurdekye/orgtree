import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppSettings,PanelSettings} from '../src/canvas/apps/settings'
import {activateApps,customAppsFeed} from '../src/canvas/apps/store'

const tick=async()=>{for(let i=0;i<6;i++)await flush()}
const fired=(seq:number,event:string,subscribers:number,actor:string)=>({seq,name:'event.fired',payload:{event,id:'fire-'+seq,subscribers},actor,at:`2026-10-27T10:0${seq}:00Z`})
const app={id:'notes',name:'Notes',description:'',rev:1,width:360,height:280,capabilities:['events.fire'],events:[{name:'submitted',description:'Notes ready for review'},{name:'cleared',description:''}],permissions:{},created_by:'maker',updated_at:''}
const panel={id:'one',app:'notes',label:'First',rev:1,open:false,placement:{mode:'float' as const,x:0,y:0,width:360,height:280},used_at:'',event_seq:4,updated_at:''}
const type=(el:HTMLTextAreaElement|HTMLSelectElement,value:string,event:string)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')!.set!.call(el,value);el.dispatchEvent(new window.Event(event,{bubbles:true}))}

test('Fire event: the event and Fire on one line, its data, then that event\'s fires from this copy, live',async t=>{
  // This copy's History: a start, two fires of submitted and one of cleared.
  const history=[{seq:1,name:'panel.started',payload:{reason:'opened'},actor:'user',at:'2026-10-27T10:01:00Z'},fired(2,'submitted',2,'worker'),fired(3,'cleared',0,'user'),fired(4,'submitted',1,'user')]
  const original=globalThis.fetch,calls:Record<string,any>[]=[]
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
    if(input.action==='list')out={items:input.kind==='apps'?[app]:[panel],next_cursor:null}
    else if(input.action==='fire_event'){history.push(fired(history.length+1,input.name,3,'user'));out={accepted:true,subscribers:3,event:'fire-new'}}
    else if(input.action==='events'){
      // The engine's name filter: History's fires of that event, newest first, or newer ones oldest first.
      let rows=history.filter(e=>!input.name||(e.name==='event.fired'&&(e.payload as {event:string}).event===input.name))
      rows=input.after!==undefined?rows.filter(e=>e.seq>input.after):rows.filter(e=>input.before===undefined||e.seq<input.before).reverse()
      out={panel:'one',events:rows.slice(0,input.limit??50),next_cursor:null,oldest_retained:null}}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelSettings slug="fire-tab" app={app} panel={panel} close={()=>{}}/>,e=>e);t.after(()=>view.unmount())
  await inAct(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent==='Fire event')!.click();await tick()})
  const tab=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  // USER 2026-10-27 m58d8efef52d9: "clean up this tab, remove redundant or irrelevant information, streamline the interface".
  assert.doesNotMatch(tab.textContent??'',/Opening this tab fires nothing|From First|subscribed to this copy/,'no intro paragraph')
  assert.equal(tab.querySelectorAll('.set-row').length,0,'the picker is not an indented settings row')
  const bar=tab.querySelector('.custom-app-fire-bar'),select=bar?.querySelector<HTMLSelectElement>('select[aria-label="Declared event"]')
  const fire=[...bar?.querySelectorAll<HTMLButtonElement>('button')??[]].find(b=>b.textContent==='Fire')
  assert.ok(select&&fire,'the event and Fire share one line');assert.match(fire!.title,/listening/,'a short tooltip says what Fire does')
  assert.deepEqual([...select!.options].map(o=>o.value),['submitted','cleared'])
  assert.ok([...tab.querySelectorAll('p.dim')].some(p=>p.textContent==='Notes ready for review'),'the declared description is the hint')
  const data=tab.querySelector<HTMLTextAreaElement>('textarea[aria-label="Event JSON data"]')!;assert.equal(data.value,'','the data box starts empty');assert.match(data.placeholder,/JSON/)
  // USER 2026-10-27 m46d1f8a8e39e: the chosen event's fires from this copy, in History's list.
  const rows=(name:string)=>[...tab.querySelectorAll(`ol[aria-label="Fires of ${name}"] > li > button`)].map(b=>b.textContent??'')
  assert.equal(rows('submitted').length,2,'only this event\'s fires');assert.match(rows('submitted')[0]!,/1 listener.*You/);assert.match(rows('submitted')[1]!,/2 listeners.*worker/)
  assert.doesNotMatch(rows('submitted')[0]!,/submitted/,'a row does not repeat the chosen event')
  assert.ok(calls.some(c=>c.action==='events'&&c.panel==='one'&&c.name==='submitted'&&!('messages' in c)),'History is read for the chosen event')
  assert.equal(calls.some(c=>c.action==='fire_event'),false,'opening the tab fires nothing')
  await inAct(async()=>{tab.querySelector<HTMLButtonElement>('ol[aria-label="Fires of submitted"] > li > button')!.click();await tick()})
  assert.match(tab.querySelector('.custom-app-log-details')?.textContent??'',/Listeners.*1.*Event ID.*fire-4/s,'a fire expands to its details as in History')
  // An empty box sends {}; the fire shows at the top once its change arrives.
  await inAct(async()=>{fire!.click();await tick()})
  assert.deepEqual(calls.find(c=>c.action==='fire_event'),{action:'fire_event',panel:'one',name:'submitted',payload:{}})
  await inAct(async()=>{customAppsFeed('fire-tab',{type:'custom_apps_changed'});await tick()})
  assert.equal(rows('submitted').length,3,'the new fire arrives live');assert.match(rows('submitted')[0]!,/3 listeners.*You/)
  assert.ok(calls.some(c=>c.action==='events'&&c.name==='submitted'&&c.after===4),'following reads only newer fires of this event')
  // Malformed data is never sent, and the tab says why.
  await inAct(async()=>{type(data,'{oops','input');await tick()})
  const sent=calls.filter(c=>c.action==='fire_event').length
  await inAct(async()=>{fire!.click();await tick()})
  assert.equal(calls.filter(c=>c.action==='fire_event').length,sent,'malformed data is never sent');assert.ok(tab.querySelector('[role="alert"]'),'and the tab says why')
  // Another event shows its own fires and description, if it has one.
  await inAct(async()=>{type(select!,'cleared','change');await tick()})
  assert.deepEqual(rows('cleared').map(r=>r.match(/\d+ listeners?/)?.[0]),['0 listeners'])
  assert.equal([...tab.querySelectorAll('p.dim')].some(p=>p.textContent==='Notes ready for review'),false,'an event without a description shows no hint')
  assert.equal(tab.querySelector('[role="alert"]'),null,'choosing another event clears the old error')
})

test('App settings: an Events tab lists every declared event with its description, live',async t=>{
  let current={...app,description:'Saved notes'}
  const original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
    if(input.action!=='list')throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify({kind:input.kind,items:input.kind==='apps'?[current]:[],next_cursor:null}),{headers:{'Content-Type':'application/json'}})}
  t.after(()=>{globalThis.fetch=original})
  const stop=activateApps('events-tab');t.after(stop)
  const view=await mountView(<AppSettings slug="events-tab" app={current} close={()=>{}}/>,e=>e);t.after(()=>view.unmount())
  await inAct(tick)
  // USER 2026-10-27 me1e204ce94e4: "add an "events" tab to the custom app settings panel that lists all of an app's declared events".
  assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map(e=>e.textContent),['General','Events','Permissions','Permission history'],'Events follows General; Permission history stays last')
  await inAct(async()=>{[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent==='Events')!.click();await tick()})
  const tab=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  const listed=()=>[...tab.querySelectorAll('ul[aria-label="Declared events"] > li')].map(li=>[li.querySelector('.custom-app-event-name')?.textContent,li.querySelector('.custom-app-event-description')?.textContent??null])
  assert.deepEqual(listed(),[['submitted','Notes ready for review'],['cleared',null]],'every declared event in declaration order; no empty description line')
  assert.equal(tab.querySelectorAll('button,input,select,textarea').length,0,'read-only')
  current={...current,rev:2,events:[{name:'submitted',description:'Notes ready for review'},{name:'archived',description:'Moved to the archive'}]}
  await inAct(async()=>{customAppsFeed('events-tab',{type:'custom_apps_changed'});await tick()})
  assert.deepEqual(listed(),[['submitted','Notes ready for review'],['archived','Moved to the archive']],'the list follows the app\'s declarations live')
  current={...current,rev:3,events:[]}
  await inAct(async()=>{customAppsFeed('events-tab',{type:'custom_apps_changed'});await tick()})
  assert.equal(tab.querySelector('ul[aria-label="Declared events"]'),null);assert.match(tab.textContent??'',/declares no events/)
})
