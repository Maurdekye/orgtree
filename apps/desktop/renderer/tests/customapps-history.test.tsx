import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as appsStore from '../src/canvas/apps/store'
import {PanelSettings} from '../src/canvas/apps/settings'

// USER 2026-10-27 md2006b10cf40 (Panel settings > History): "make the hidtory tab
// reload in realtime, be more list like wity expandable rows, and lazily losd as you
// sfrollcdown (remof3 th4 refresh button)".
const tick=async()=>{for(let i=0;i<6;i++)await flush()}
type Row={seq:number;name:string;payload:Record<string,unknown>;body?:string|null;actor:string;at:string}
const t0=Date.UTC(2026,9,27,6,0,0),at=(seq:number)=>new Date(t0+seq*1000).toISOString()
const fired=(seq:number):Row=>({seq,name:'event.fired',payload:{event:'e'+seq,id:'fire-'+seq,subscribers:seq%2},body:JSON.stringify({line:seq,text:'caption '+seq}),actor:seq%2?'boss':'app',at:at(seq)})
const bottom=async(list:HTMLElement)=>{
  Object.defineProperties(list,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:400},scrollTop:{configurable:true,value:1600}})
  await inAct(async()=>{list.dispatchEvent(new window.Event('scroll',{bubbles:true}));await tick()})
}

test('History is a live list: compact rows expand, older pages load on scroll, new rows arrive without a Refresh button',async t=>{
  const app={id:'notes',name:'Notes',description:'',rev:1,width:360,height:280,capabilities:['events.fire'],events:[{name:'submitted'}],permissions:{},created_by:'maker',updated_at:''}
  const panel={id:'one',app:'notes',label:'First',rev:1,open:true,running:true,placement:{mode:'float' as const,x:0,y:0,width:360,height:280},used_at:'',event_seq:120,updated_at:''}
  // Seq 1 the copy started on open, 60 a Power off, the rest fires by the app or an agent.
  const rows:Row[]=Array.from({length:120},(_,i)=>i+1).map(seq=>seq===1?{seq,name:'panel.started',payload:{reason:'opened'},actor:'user',at:at(seq)}:seq===60?{seq,name:'panel.stopped',payload:{},actor:'user',at:at(seq)}:fired(seq))
  const calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
    if(input.action==='events'){
      // The engine's contract: newest first, before walks back, after follows new rows oldest first.
      assert.equal(init?.method??'GET','GET','History is a read');assert.equal(input.messages,undefined,'History never reads messages')
      const n=Number(input.limit??100),from=input.after!==undefined?rows.filter(r=>r.seq>input.after):rows.filter(r=>r.seq<(input.before??Infinity)).reverse(),events=from.slice(0,n)
      out={panel:'one',events,next_cursor:from.length>n?events.at(-1)!.seq:null,oldest_retained:rows[0]!.seq}
    }else if(input.action==='list')out={items:[],next_cursor:null}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  const slug='history-list',view=await mountView(<PanelSettings slug={slug} app={app} panel={panel} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const tab=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(b=>b.textContent?.trim()==='History')!
  await inAct(async()=>{tab.click();await tick()})
  const body=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  assert.equal(body.querySelector('p'),null,'no intro line above the list (USER 2026-10-28 m1ebf5e3194c8 "and this one")')
  assert.equal([...body.querySelectorAll('button')].some(b=>/refresh/i.test(b.textContent??'')),false,'no Refresh button: History is live')
  const history=()=>calls.filter(c=>c.action==='events')
  assert.deepEqual(history(),[{action:'events',panel:'one',limit:50}],'the newest page loads first, and only it')
  const list=body.querySelector<HTMLElement>('ol[aria-label="History"]')!;assert.ok(list,'History is a list')
  const items=()=>[...list.querySelectorAll<HTMLButtonElement>(':scope > li > button[aria-expanded]')]
  const texts=()=>items().map(b=>b.textContent??'')
  assert.equal(items().length,50,'one compact row per entry, a page at a time')
  assert.match(texts()[0]!,/Fired e120.*0 listeners.*app/,'a fire: its event, listener count and who fired it, newest first')
  assert.ok(items()[0]!.querySelector('time')?.getAttribute('dateTime')===at(120),'each row starts with its time')
  assert.match(texts()[49]!,/Fired e71/)
  assert.equal(list.querySelectorAll('pre').length,0,'rows start collapsed: no details or payload shown')

  // A row expands to its details and payload, and collapses again.
  const first=items()[0]!
  await inAct(async()=>{first.click();await tick()})
  assert.equal(first.getAttribute('aria-expanded'),'true')
  const details=document.getElementById(first.getAttribute('aria-controls')??'')
  assert.ok(details&&list.contains(details),'the row controls its own details')
  // the fire's body as it was sent (USER 2026-10-27 mc308cabf3c5f), beside its listener count
  assert.match(details!.textContent??'',/"line": 120,\s*"text": "caption 120"/,'the expanded row shows the body');assert.match(details!.textContent??'',/Listeners0/)
  await inAct(async()=>{first.click();await tick()})
  assert.equal(first.getAttribute('aria-expanded'),'false');assert.equal(document.getElementById(first.getAttribute('aria-controls')??''),null,'clicking again collapses it')

  // Live: an app's own fire on this copy arrives through the change feed.
  const feed=(appsStore as unknown as Record<string,unknown>).customAppsFeed as ((slug:string,data:unknown)=>boolean)|undefined
  assert.equal(typeof feed,'function','the live change feed reaches the Apps lists')
  rows.push(fired(121))
  await inAct(async()=>{assert.equal(feed!(slug,{type:'custom_apps_history',org:slug,panel:'one'}),true);await tick()})
  assert.deepEqual(history().at(-1),{action:'events',panel:'one',limit:50,after:120},'a live update reads only rows newer than the newest shown')
  assert.match(texts()[0]!,/Fired e121/);assert.equal(items().length,51)
  const count=history().length
  await inAct(async()=>{feed!(slug,{type:'custom_apps_history',org:slug,panel:'other'});await tick()})
  assert.equal(history().length,count,"another copy's History change reads nothing here")

  // Older pages load as the list scrolls down; a live insert between pages neither repeats nor skips a row.
  const kept=items().find(b=>/Fired e100/.test(b.textContent??''))!
  await inAct(async()=>{kept.click();await tick()})
  await bottom(list)
  assert.deepEqual(history().at(-1),{action:'events',panel:'one',limit:50,before:71})
  assert.equal(items().length,101)
  rows.push({seq:122,name:'panel.stopped',payload:{reason:'stop all'},actor:'user',at:at(122)})
  await inAct(async()=>{feed!(slug,{type:'custom_apps_changed',org:slug});await tick()})
  assert.deepEqual(history().at(-1),{action:'events',panel:'one',limit:50,after:121})
  assert.match(texts()[0]!,/Stopped.*Stop all.*You/,'a stop names its cause and who')
  await bottom(list)
  assert.deepEqual(history().at(-1),{action:'events',panel:'one',limit:50,before:21})
  assert.equal(list.querySelector('.custom-app-log-more'),null,'the list ends at the oldest stored row')
  const before=history().length;await bottom(list);assert.equal(history().length,before,'nothing more to load')
  const seqs=items().map(b=>(Date.parse(b.querySelector('time')?.getAttribute('dateTime')??'')-t0)/1000)
  assert.deepEqual(seqs,Array.from({length:122},(_,i)=>122-i),'every stored row exactly once, newest first')
  assert.equal(kept.getAttribute('aria-expanded'),'true','an expanded row stays open while rows arrive and load')
})
