import { mountView, inAct, flush } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BulkCompactConfirm } from '../src/canvas/bulkcompact'
import { CurrentOrg } from '../src/popout'
import { agent, summaryTargets, supportReply, targetId } from './bulkcompact-summary-fixture'
import type { CanvasNode } from '../src/canvas/shared'
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}})
const oldFetch=globalThis.fetch
test.beforeEach(()=>{globalThis.fetch=(async url=>response(supportReply(targetId(url)))) as typeof fetch})
test.afterEach(()=>{globalThis.fetch=oldFetch})
const mount=(targets:CanvasNode[],close=()=>{})=>mountView(
 <CurrentOrg.Provider value="fixture"><BulkCompactConfirm title="Compact subtree?" scope="subtree"
 targets={targets} op={async()=>({})} toast={()=>{}} close={close}/></CurrentOrg.Provider>,el=>el)
const dialog=()=>document.querySelector<HTMLElement>('[role="dialog"]')!
const body=()=>dialog().querySelector<HTMLElement>('.confirm-body')!
const count=(kind:string)=>body().querySelector<HTMLElement>('[data-compact-count="'+kind+'"]')
const skipLines=()=>[...body().querySelectorAll<HTMLElement>('[data-compact-skip]')]
const settle=()=>inAct(async()=>{await flush(8)})
test('large selection has count-only mode lines with exact covered names on hover',async()=>{
 const targets=summaryTargets(),view=await mount(targets)
 try{
  await settle()
  assert.equal(count('cheap')?.textContent,'14 agents will be cheap-compacted, one at a time.')
  assert.equal(count('normal')?.textContent,'3 agents will be compacted, one at a time.')
  assert.deepEqual(count('cheap')?.title.split(', '),targets.filter(n=>!n.busy&&(n.occupancy??0)>0).map(n=>n.id))
  assert.deepEqual(count('normal')?.title.split(', '),['native-1','native-2','native-3'])
  for(const n of targets)assert.equal(body().textContent?.includes(n.id),false,'names stay in tooltips')
  assert.equal(body().querySelector('details, summary, .agentlink, .desk-jump-card')===null,true)
 }finally{await view.unmount()}
})
test('busy and no-context summaries appear in each mode with exact hover names',async()=>{
 const view=await mount(summaryTargets())
 try{
  await settle();const lines=skipLines()
  assert.equal(lines.length,6,'busy/empty in both modes; unsupported/sessionless only for Normal')
  for(const mode of ['cheap','normal']){
   const section=body().querySelector<HTMLElement>('[data-compact-preview="'+mode+'"]')!
   for(const [key,n,prefix] of [['busy',5,'busy'],['empty',5,'empty']] as const){
    const line=section.querySelector<HTMLElement>('[data-compact-skip="'+key+'"]')
    assert.ok(line,mode+' has '+key+' summary')
    assert.match(line.textContent??'',new RegExp('^'+n+' agents'))
    assert.deepEqual(line.title.split(', '),Array.from({length:n},(_,i)=>prefix+'-'+(i+1)))
   }
   assert.equal(section.querySelector('[data-compact-skip="unsupported"]')!==null,mode==='normal')
   assert.equal(section.querySelector('[data-compact-skip="sessionless"]')!==null,mode==='normal')
  }
  assert.equal(body().querySelector('[data-compact-shared-skips] [data-compact-skip="busy"]')===null,true)
  assert.equal(body().querySelector('[data-compact-shared-skips] [data-compact-skip="empty"]')===null,true)
  assert.equal(body().textContent?.includes("Running turns are never interrupted; you'll get a summary of every outcome."),true)
 }finally{await view.unmount()}
})

test('pending support uses a counted hover list without names in prose and leaves Cheap ready',async()=>{
 let release!:(r:Response)=>void
 const pending=new Promise<Response>(resolve=>{release=resolve})
 globalThis.fetch=(async()=>pending) as typeof fetch
 const view=await mount([agent('waiting')])
 try{
  const line=body().querySelector<HTMLElement>('[role="status"]')
  assert.equal(line?.title,'waiting')
  assert.match(line?.textContent??'',/Checking.*1 agent/)
  assert.equal(body().textContent?.includes('waiting'),false)
  const buttons=[...dialog().querySelectorAll<HTMLButtonElement>('.row > button')]
  assert.equal(buttons.find(b=>b.textContent==='compact 0 agents')?.disabled,true)
  assert.equal(buttons.find(b=>b.textContent==='cheap-compact 1 agent')?.disabled,false)
 }finally{release(response({supported:true}));await settle();await view.unmount()}
})
test('zero targets keep both count lines and each mode shows the skipped hover names',async()=>{
 const view=await mount([agent('running',{busy:true})])
 try{
  await settle()
  assert.equal(count('cheap')?.textContent,'0 agents will be cheap-compacted, one at a time.')
  assert.equal(count('normal')?.textContent,'0 agents will be compacted, one at a time.')
  assert.equal(skipLines().length,2);assert.equal(skipLines().every(line=>line.title==='running'),true)
  const actions=[...dialog().querySelectorAll<HTMLButtonElement>('.row > button')].slice(0,2)
  assert.equal(actions.every(b=>b.disabled),true)
 }finally{await view.unmount()}
})
test('counted confirmation buttons and Cancel remain unchanged and opening never starts compaction',async()=>{
 let posts=0,closed=0
 globalThis.fetch=(async(url,init)=>{if(init?.method==='POST')posts++;return response(supportReply(targetId(url)))}) as typeof fetch
 const view=await mount(summaryTargets(),()=>{closed++})
 try{
  await settle()
  const buttons=[...dialog().querySelectorAll<HTMLButtonElement>('.row > button')]
  assert.deepEqual(buttons.map(b=>b.textContent),['compact 3 agents','cheap-compact 14 agents','cancel'])
  assert.equal(posts,0)
  await inAct(()=>buttons[2]!.click())
  assert.equal(posts,0);assert.equal(closed,1)
 }finally{await view.unmount()}
})

test('mixed unsupported harnesses merge while unknown reasons and failed reads stay distinct',async()=>{
 globalThis.fetch=(async url=>{
  const id=targetId(url)
  if(id==='offline')throw new Error('offline transport')
  return response({supported:false,reason:id==='codex'?'Normal compaction is not available for Codex in Orgtree.'
   :id==='other'?'Unsupported harness':'Waiting for engine maintenance'})
 }) as typeof fetch
 const view=await mount([agent('codex'),agent('other'),agent('policy'),agent('offline'),agent('reset',{compacted_unrun:true})])
 try{
  await settle();const lines=skipLines()
  assert.equal(lines.length,4)
  const unsupported=lines.find(p=>p.textContent?.includes('do not support'))
  assert.match(unsupported?.textContent??'',/^2 agents/);assert.equal(unsupported?.title,'codex, other')
  const unknown=lines.find(p=>p.textContent?.includes('Waiting for engine maintenance'))
  assert.match(unknown?.textContent??'',/^1 agent:/);assert.equal(unknown?.title,'policy')
  assert.equal(lines.find(p=>p.textContent?.includes('could not be checked'))?.title,'offline')
  assert.equal(lines.find(p=>p.textContent?.includes('already compacted'))?.title,'reset')
 }finally{await view.unmount()}
})

test('both modes retain busy and no-context hover lists while Normal support is pending',async()=>{
 let release!:(r:Response)=>void
 const pending=new Promise<Response>(resolve=>{release=resolve})
 globalThis.fetch=(async()=>pending) as typeof fetch
 const view=await mount([agent('ready'),agent('busy',{busy:true}),agent('empty',{occupancy:0})])
 try{
  for(const mode of ['cheap','normal']){
   const section=body().querySelector<HTMLElement>('[data-compact-preview="'+mode+'"]')!
   assert.equal(section.querySelector<HTMLElement>('[data-compact-skip="busy"]')?.title,'busy')
   assert.equal(section.querySelector<HTMLElement>('[data-compact-skip="empty"]')?.title,'empty')
  }
  assert.equal(count('cheap')?.textContent,'1 agent will be cheap-compacted, one at a time.')
  assert.equal(body().querySelector<HTMLElement>('[role="status"]')?.title,'ready')
 }finally{release(response({supported:true}));await settle();await view.unmount()}
})
