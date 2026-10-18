import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { CurrentOrg } from '../src/popout'
import { BulkCompactConfirm } from '../src/canvas/bulkcompact'
import type { CanvasNode, OpFn } from '../src/canvas/shared'
const agent=(id:string,extra:Partial<CanvasNode>={}):CanvasNode=>({
 id,state:'live',tier:'sonnet',children:[],session_id:'session-'+id,
 occupancy:40000,context_window:200000,...extra,
} as CanvasNode)
const reply=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
const oldFetch=globalThis.fetch
test.beforeEach(()=>{globalThis.fetch=(async()=>reply({supported:true,started:true})) as typeof fetch})
test.afterEach(()=>{globalThis.fetch=oldFetch})
const modal=(targets:CanvasNode[],op:OpFn=async()=>({} as never),close=()=>{})=>
 <CurrentOrg.Provider value="fixture"><BulkCompactConfirm title="Compact subtree?" scope="subtree"
 targets={targets} op={op} toast={()=>{}} close={close}/></CurrentOrg.Provider>
const dialog=()=>document.querySelector<HTMLElement>('[role="dialog"]')!
const buttons=()=>[...dialog().querySelectorAll<HTMLButtonElement>('.row > button')]
const action=(normal=false)=>buttons().find(b=>b.textContent?.startsWith(normal?'compact ':'cheap-compact '))!
const settled=()=>inAct(async()=>{await flush(5)})

test('both counted actions and both target/skip previews are visible without a radio or selection',async()=>{
 const requests:string[]=[],ops:unknown[]=[]
 globalThis.fetch=(async(url,init)=>{
  requests.push((init?.method??'GET')+' '+url)
  const id=String(url).split('/nodes/')[1]!.split('/')[0]
  return reply(id==='unsupported'?{supported:false,reason:'Unsupported harness'}:{supported:true})
 }) as typeof fetch
 const view=await mountView(modal([agent('one'),agent('unsupported'),agent('sessionless',{session_id:null}),agent('busy',{busy:true})],
 async b=>{ops.push(b);return {} as never}),el=>el)
 try{
  await settled()
  assert.equal(dialog().querySelector('input[type="radio"]')===null,true)
  assert.deepEqual(buttons().map(b=>b.textContent),['compact 1 agent','cheap-compact 3 agents','cancel'])
  assert.equal(action().disabled,false);assert.equal(action(true).disabled,false)
  const cheap=dialog().querySelector('[data-compact-preview="cheap"]')
  const normal=dialog().querySelector('[data-compact-preview="normal"]')
  assert.ok(cheap);assert.ok(normal)
  assert.match(cheap.textContent??'',/one, unsupported, sessionless/)
  assert.match(cheap.textContent??'',/busy.*mid-turn/)
  for(const word of ['one','unsupported','Unsupported harness','sessionless','no conversation session','busy','mid-turn'])
    assert.ok(normal.textContent?.includes(word),word)
  assert.equal(requests.length,2,'capability reads start on opening for session-bearing candidates only')
  assert.equal(requests.every(r=>r.startsWith('GET ')),true)
  assert.deepEqual(ops,[])
 }finally{await view.unmount()}
})

test('a zero-target type is greyed out while the other action keeps its own count',async()=>{
 globalThis.fetch=(async()=>reply({supported:false,reason:'No normal support'})) as typeof fetch
 const view=await mountView(modal([agent('one')]),el=>el)
 try{await settled();assert.equal(action(true)?.textContent,'compact 0 agents');assert.equal(action(true)?.disabled,true)
  assert.equal(action()?.textContent,'cheap-compact 1 agent');assert.equal(action()?.disabled,false)
 }finally{await view.unmount()}
})

test('pending normal capability disables only normal, leaving cheap ready with no request sent',async()=>{
 let release!:(v:Response)=>void
 const pending=new Promise<Response>(resolve=>{release=resolve})
 let ops=0,posts=0
 globalThis.fetch=(async(_url,init)=>{if(init?.method==='POST')posts++;return pending}) as typeof fetch
 const view=await mountView(modal([agent('one')],async()=>{ops++;return {} as never}),el=>el)
 try{
  assert.equal(action()?.disabled,false);assert.equal(action(true)?.disabled,true)
  assert.match(dialog().textContent??'',/checking/i)
  assert.equal(ops,0);assert.equal(posts,0)
 }finally{release(reply({supported:true}));await settled();await view.unmount()}
})

test('all skipped selection disables both actions and keeps per-type reasons visible',async()=>{
 const view=await mountView(modal([agent('busy',{busy:true})]),el=>el)
 try{
  assert.equal(action()?.textContent,'cheap-compact 0 agents');assert.equal(action()?.disabled,true)
  assert.equal(action(true)?.textContent,'compact 0 agents');assert.equal(action(true)?.disabled,true)
  for(const section of dialog().querySelectorAll('[data-compact-preview]'))
    assert.match(section.textContent??'',/busy.*mid-turn/)
 }finally{await view.unmount()}
})

test('Cheap action alone runs cheap if_idle operations and cancel performs no compaction',async()=>{
 let closes=0;const ops:unknown[]=[],posts:string[]=[]
 globalThis.fetch=(async(url,init)=>{if(init?.method==='POST')posts.push(String(url));return reply({supported:true})}) as typeof fetch
 const view=await mountView(modal([agent('one')],async b=>{ops.push(b);return {} as never},()=>{closes++}),el=>el)
 try{
  await settled();assert.ok(action());await inAct(async()=>{action().click();await flush(3)})
  assert.deepEqual(ops,[{op:'cheap_compact',node:'one',if_idle:true}]);assert.deepEqual(posts,[]);assert.equal(closes,1)
 }finally{await view.unmount()}
 const cancelView=await mountView(modal([agent('one')],async b=>{ops.push(b);return {} as never},()=>{closes++}),el=>el)
 try{
  await settled();await inAct(()=>buttons().find(b=>b.textContent==='cancel')!.click())
  assert.equal(ops.length,1);assert.deepEqual(posts,[]);assert.equal(closes,2)
 }finally{await cancelView.unmount()}
})

test('Normal action executes its own supported targets directly without invoking Cheap',async()=>{
 const posts:string[]=[],ops:unknown[]=[]
 globalThis.fetch=(async(url,init)=>{
  const id=String(url).split('/nodes/')[1]!.split('/')[0]!
  if(init?.method==='POST'){posts.push(id);return reply({started:true})}
  return reply({supported:id!=='unsupported',reason:'No normal support'})
 }) as typeof fetch
 const view=await mountView(modal([agent('one'),agent('unsupported')],async b=>{ops.push(b);return {} as never}),el=>el)
 try{
  await settled();assert.ok(action(true));await inAct(async()=>{action(true).click();await flush(4)})
  assert.deepEqual(posts,['one']);assert.deepEqual(ops,[])
 }finally{await view.unmount()}
})
