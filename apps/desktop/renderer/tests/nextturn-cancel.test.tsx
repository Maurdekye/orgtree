import { useState } from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import { FakeServer, installFetch, mountView, inAct, flush } from './harness'
import { legacyAppBackend } from './appfeed-fixture'
import { NodeConfig } from '../src/canvas/modals'
import { DeskModelButton } from '../src/canvas/deskmodel'
import { EffortButton } from '../src/canvas/desk'
import { FastModeButton } from '../src/canvas/fastmodebutton'
import { QueuedAccountBadge, QueuedModelBadge } from '../src/canvas/nextturn'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { syncProviderRegistries, type CanvasNode } from '../src/canvas/shared'
import { bindHistory } from '../src/historyregistry'
import type { TreePayload } from '../src/types'

const noop=()=>{}
const provider={id:'openai',hire_enabled:true,status:{installed:true},tiers:[{tier:'sol',fast_mode:true},{tier:'luna',fast_mode:true}]}
const tools={bash:true,edit:true,web:false,subagents:false,mcp:[]}
const base={id:'worker',tier:'sol',state:'live',generation:1,children:[],parent:'USER',seat:2,grant:0,free:0,busy:true,
 account:'openai/primary',scope:{tools,add_dirs:[],effort:'high',model_version:'',fast_mode:true},charter:'',team_charter:''} as CanvasNode
const click=async(el:Element|null|undefined)=>inAct(async()=>{assert.ok(el);el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await flush(10)})
const choose=async(label:string,value:string)=>inAct(async()=>{
 const el=document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);assert.ok(el)
 el.value=value;el.dispatchEvent(new window.Event('change',{bubbles:true}));await flush(5)
})
async function setup(surface:'settings'|'desk',kind:'model'|'account'|'both',history=false){
 resetStaffingOptionsForTests();localStorage.clear();installFetch(new FakeServer())
 const fallback=globalThis.fetch,acts:Record<string,unknown>[]=[],writes:Record<string,unknown>[]=[]
 let update:(fn:(n:CanvasNode)=>CanvasNode)=>void=()=>{}
 const act=(body:Record<string,unknown>)=>{
  acts.push(body)
  if(body.op==='switch_model'&&body.tier===base.tier)update(n=>({...n,pending_switch:null}))
  if(body.op==='account'&&body.account===base.account)update(n=>({...n,pending_account:null}))
  return {unchanged:true,cancelled:body.op==='account'}
 }
 globalThis.fetch=legacyAppBackend((async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input),'http://localhost').pathname
  let body:unknown=null
  if(init?.method==='POST'&&typeof init.body==='string'){
   const request=JSON.parse(init.body)
   if(path.endsWith('/gesture'))body={results:request.steps.map(act)}
   else if(path.endsWith('/account'))body=act({op:'account',node:base.id,...request})
   else if(path.endsWith('/scope')){writes.push(request);body={}}
  }
  if(path==='/api/providers')body={providers:[provider]}
  if(path==='/api/accounts')body={accounts:[{id:'openai/backup',provider:'openai',identity:{email:'backup@example.test'},enabled:true}]}
  if(path.endsWith('/staffing-options'))body={tiers:['sol','luna'].map(tier=>({tier,seat:2,efforts:['low','medium','high'],default_ok:true,accounts:[{value:'openai/primary',id:'default',provider:'openai',ambient:true},{value:'openai/backup',id:'backup',provider:'openai',ambient:false}]})),errors:[],loading:false}
  return body!==null?new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}):fallback(input,init)
 }) as typeof fetch)
 syncProviderRegistries({providers:[provider]})
 const off=history?bindHistory('cancel',{refresh:async()=>{},can:()=>false} as never):noop
 function Fixture(){
  const[node,setNode]=useState({...base,pending_switch:kind==='account'?null:{tier:'luna'},pending_account:kind==='model'?null:{account:'openai/backup'}} as CanvasNode)
  update=setNode
  const tree={slug:'cancel',roots:[node],dirs:[],tiers:{sol:2,luna:.1},max_top_grant:100,default_tools:tools,undo_history:history} as unknown as TreePayload
  return <><div data-queued><QueuedModelBadge node={node}/><QueuedAccountBadge node={node}/></div>
   {surface==='settings'?<NodeConfig node={node} map={new Map([[node.id,node]])} tree={tree} slug="cancel" op={async b=>act(b)} toast={noop} close={noop} codexProvider={provider as never}/>:
    <DeskModelButton node={node} slug="cancel" op={async b=>act(b)} toast={noop}/>}</>
 }
 const v=await mountView(<Fixture/>,el=>el)
 await inAct(async()=>{await flush(14)})
 return{v,acts,writes,close:async()=>{await v.unmount();off()}}
}
for(const history of [false,true])for(const surface of ['settings','desk'] as const)for(const kind of ['model','account','both'] as const)
 test(`${surface} ${history?'history':'legacy'}: choosing current ${kind} cancels its queued change`,async()=>{
 const s=await setup(surface,kind,history)
 try{
  if(surface==='settings'){
   if(kind!=='account'){
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="model tier"]')?.value,'luna','show queued choice so choosing current fires change')
    await choose('model tier','sol')
   }
   if(kind!=='model'){
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Account"]')?.value,'openai/backup')
    await choose('Account','openai/primary')
   }
   await click([...document.querySelectorAll('button')].find(b=>b.textContent==='save'))
  }else{
   await click(s.v.el.querySelector('[aria-label="Change model for worker"]'))
   await click(document.querySelector('[aria-label="Change agent model"] .t-sol'))
   if(kind!=='model'){
    assert.equal(document.querySelector<HTMLSelectElement>('select[aria-label="Model account"]')?.value,'openai/backup')
    await choose('Model account','openai/primary')
   }
   await click(document.querySelector('[aria-label="Apply model change"]'))
  }
  if(kind!=='account'){assert.equal(s.acts.some(b=>b.op==='switch_model'&&b.tier==='sol'),true);assert.equal(!!s.v.el.querySelector('[data-next-turn="model"]'),false)}
  if(kind!=='model'){assert.equal(s.acts.some(b=>b.op==='account'&&b.account==='openai/primary'),true);assert.equal(!!s.v.el.querySelector('[data-next-turn="account"]'),false)}
 }finally{await s.close()}
})
for(const history of [false,true])test(`untouched ${history?'history':'legacy'} settings Save preserves both queues`,async()=>{
 const s=await setup('settings','both',history)
 try{await click([...document.querySelectorAll('button')].find(b=>b.textContent==='save'));assert.equal(s.acts.some(b=>['switch_model','account'].includes(String(b.op))),false);assert.equal(s.v.el.querySelectorAll('[data-next-turn]').length,2)}finally{await s.close()}
})
test('speed toggle already submits the current running value to revert a queued change',async()=>{
 const s=await setup('desk','model')
 const v=await mountView(<FastModeButton node={{...base,fast_mode_current:false}} slug="cancel" toast={noop}/>,el=>el)
 try{await click(v.el.querySelector('button'));assert.equal(s.writes.some(b=>b.fast_mode===false),true)}finally{await v.unmount();await s.close()}
})
test('effort selector already submits the current running level to revert a queued change',async()=>{
 const values:string[]=[]
 const v=await mountView(<EffortButton value="high" effective="high" currentEffort="medium" pendingEffort="high" levels={['low','medium','high']} onSet={value=>{values.push(value)}}/>,el=>el)
 try{await click(v.el.querySelector('.cc-eff'));await inAct(async()=>{v.el.querySelector('[role="slider"]')!.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));await flush(4)});assert.deepEqual(values,['medium'])}finally{await v.unmount()}
})
