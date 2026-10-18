import { inAct, mountView, flush } from './harness'
import test, { beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { agentMenuEntries, AgentRetireConfirm } from '../src/canvas/agentmenu'
import { CurrentOrg } from '../src/popout'
import type { AgentMenuHandlers } from '../src/canvas/agentmenu'
import type { CanvasNode, OpFn } from '../src/canvas/shared'

const originalFetch=globalThis.fetch
const response=(data:unknown)=>({ok:true,status:200,headers:new Headers(),json:async()=>data} as Response)
beforeEach(()=>{globalThis.fetch=(async()=>response({supported:true,reason:null})) as typeof fetch})
afterEach(()=>{globalThis.fetch=originalFetch})
const noop=()=>{}
const agent=(extra:Record<string,unknown>={}):CanvasNode=>({
  id:'worker',state:'live',tier:'sonnet',model_id:'sonnet',children:[],
  session_id:'session',busy:false,seat:2,grant:0,free:0,
  ...extra,
} as unknown as CanvasNode)
const handlers=(extra:Partial<AgentMenuHandlers>={}):AgentMenuHandlers=>({
  onInbox:noop,onSettings:noop,onHalt:noop,onRetireAsk:noop,...extra,
})
const entries=(n:CanvasNode,h=handlers())=>agentMenuEntries(n,h).filter(e=>e!=='sep')
const dialog=(el:HTMLElement)=>el.ownerDocument.querySelector<HTMLElement>('[role="dialog"]')
const button=(el:HTMLElement,label:string)=>[...el.ownerDocument.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(b=>b.textContent?.trim().toLowerCase()===label.toLowerCase())
const compact=(n=agent(),op:OpFn=async()=>({} as never),toast:(xs:string[])=>void=noop,close=noop)=>
  <CurrentOrg.Provider value="org"><AgentRetireConfirm kind="cheap-compact" node={n} op={op} toast={toast} close={close}/></CurrentOrg.Provider>

test('leaf Halt and Unhalt act directly without ellipses',()=>{
  let count=0
  for(const halted of [false,true]){
    const n=agent(halted?{halt:{phase:'halted'}}:{})
    const item=entries(n,handlers({onHalt:()=>{count++}})).find(e=>e.label.startsWith(halted?'Unhalt':'Halt'))!
    assert.equal(item.label,halted?'Unhalt':'Halt')
    assert.equal(item.children,undefined)
    item.onSelect()
  }
  assert.equal(count,2)
})
test('Halt keeps ellipsis only for an actual team submenu',()=>{
  const boss=agent({children:[agent({id:'kid'})]})
  const withAsk=entries(boss).find(e=>e.label.startsWith('Halt'))!
  assert.ok(withAsk.children?.length)
  assert.equal(withAsk.label,'Halt\u2026')
  const withoutAsk=entries(boss,handlers({onRetireAsk:undefined})).find(e=>e.label.startsWith('Halt'))!
  assert.equal(withoutAsk.children,undefined)
  assert.equal(withoutAsk.label,'Halt')
})
test('Compact menu opens the choice modal and bulk actions choose their type',()=>{
  const asked:string[]=[]
  const branch=entries(agent({children:[agent({id:'kid'})]}),handlers({onRetireAsk:k=>asked.push(k)}))
    .find(e=>e.label==='Compact\u2026')
  assert.ok(branch,'Compact choice must be offered')
  branch.onSelect()
  assert.deepEqual(asked,['cheap-compact'])
  assert.deepEqual(branch.children?.map(e=>e.label),['Compact subtree\u2026','Compact all subordinates\u2026'])
})
test('retired, busy and empty single-agent compaction gates remain intact',()=>{
  for(const extra of [{state:'archived'},{busy:true},{session_id:null}]){
    const entry=entries(agent(extra)).find(e=>/compact/i.test(e.label))!
    assert.ok(entry.disabled||entry.actionDisabled)
  }
  assert.equal(entries(agent(),handlers({onRetireAsk:undefined})).some(e=>/compact/i.test(e.label)),false)
})
test('compact modal explains both choices and offers Cancel',async()=>{
  const v=await mountView(compact(),el=>el)
  try{
    assert.ok(button(v.el,'Normal compact'))
    assert.ok(button(v.el,'Cheap compact'))
    assert.ok(button(v.el,'Cancel'))
    assert.match(dialog(v.el)?.textContent??'',/harness/i)
    assert.match(dialog(v.el)?.textContent??'',/handoff|summary/i)
  }finally{await v.unmount()}
})
test('unsupported normal compaction is disabled with a visible reason',async()=>{
  globalThis.fetch=(async()=>response({supported:false,reason:'Codex does not support normal compact in Orgtree.'})) as typeof fetch
  const v=await mountView(compact(),el=>el)
  try{
    const normal=button(v.el,'Normal compact')
    assert.ok(normal)
    assert.equal(normal.disabled,true)
    assert.match(dialog(v.el)?.textContent??'',/Codex does not support/)
    assert.equal(button(v.el,'Cheap compact')?.disabled,false)
  }finally{await v.unmount()}
})
test('normal compact sends the existing route and reports started:false truthfully',async()=>{
  const old=globalThis.fetch,paths:string[]=[],notes:string[]=[]
  globalThis.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    if(init?.method!=='POST')return response({supported:true,reason:null})
    paths.push(String(input))
    return response({started:false,reason:'the agent is halted'})
  }) as typeof fetch
  const v=await mountView(compact(agent(),undefined,x=>notes.push(...x)),el=>el)
  try{
    const normal=button(v.el,'Normal compact');assert.ok(normal)
    await inAct(async()=>{normal.click();await flush()})
    assert.deepEqual(paths,['/api/orgs/org/nodes/worker/compact'])
    assert.match(notes.join(' '),/halted/)
    assert.doesNotMatch(notes.join(' '),/started/)
  }finally{await v.unmount();globalThis.fetch=old}
})
test('cheap compact uses the existing op only after choosing it',async()=>{
  const calls:unknown[]=[]
  const v=await mountView(compact(agent(),async req=>{calls.push(req);return {} as never}),el=>el)
  try{
    assert.deepEqual(calls,[])
    const cheap=button(v.el,'Cheap compact');assert.ok(cheap)
    await inAct(()=>cheap.click())
    assert.deepEqual(calls,[{op:'cheap_compact',node:'worker'}])
  }finally{await v.unmount()}
})
test('Cancel owns initial focus, Tab stays inside, Escape restores the opener',async()=>{
  const opener=document.createElement('button');opener.textContent='open';document.body.append(opener);opener.focus()
  let closed=0
  const v=await mountView(compact(agent(),undefined,noop,()=>{closed++}),el=>el)
  try{
    const cancel=button(v.el,'cancel');assert.ok(cancel)
    assert.equal(document.activeElement===cancel,true)
    await inAct(()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true})))
    assert.equal(!!dialog(v.el)?.contains(document.activeElement),true)
    await inAct(()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
    assert.equal(closed,1)
  }finally{await v.unmount()}
  assert.equal(document.activeElement===opener,true)
  opener.remove()
})

test('failed capability read keeps normal disabled and cheap available',async()=>{
  globalThis.fetch=(async()=>{throw new Error('offline')}) as typeof fetch
  const v=await mountView(compact(),el=>el)
  try{
    assert.equal(button(v.el,'Normal compact')?.disabled,true)
    assert.equal(button(v.el,'Cheap compact')?.disabled,false)
    assert.match(dialog(v.el)?.textContent??'',/Could not check normal compaction: offline/)
  }finally{await v.unmount()}
})
test('an admitted normal compact reports started and never sends a cheap op',async()=>{
  const methods:string[]=[],notes:string[]=[],ops:unknown[]=[]
  globalThis.fetch=(async(_input:RequestInfo|URL,init?:RequestInit)=>{
    methods.push(init?.method??'GET')
    return response(init?.method==='POST'?{started:true}:{supported:true,reason:null})
  }) as typeof fetch
  const v=await mountView(compact(agent(),async req=>{ops.push(req);return {} as never},xs=>notes.push(...xs)),el=>el)
  try{
    await inAct(async()=>{button(v.el,'Normal compact')!.click();await flush()})
    assert.deepEqual(methods,['GET','POST'])
    assert.deepEqual(ops,[])
    assert.deepEqual(notes,['compaction of worker started'])
  }finally{await v.unmount()}
})

test('a node becoming busy while the modal is open disables both choices',async()=>{
  const v=await mountView(compact(),el=>el)
  try{
    assert.equal(button(v.el,'Normal compact')?.disabled,false)
    assert.equal(button(v.el,'Cheap compact')?.disabled,false)
    await v.render(compact(agent({busy:true})))
    assert.equal(button(v.el,'Normal compact')?.disabled,true)
    assert.equal(button(v.el,'Cheap compact')?.disabled,true)
    assert.match(dialog(v.el)?.textContent??'',/finishes its turn/)
  }finally{await v.unmount()}
})
