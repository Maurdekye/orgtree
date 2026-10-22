import {useState} from 'react'
import test from 'node:test'
import assert from 'node:assert/strict'
import {FakeServer, installFetch, mountView, inAct, flush} from './harness'
import {legacyAppBackend} from './appfeed-fixture'
import {DeskModelButton} from '../src/canvas/deskmodel'
import {QueuedModelBadge} from '../src/canvas/nextturn'
import {resetStaffingOptionsForTests} from '../src/canvas/staffingoptions'
import type {StaffingAccount} from '../src/canvas/staffingoptions'
import {syncProviderRegistries, type CanvasNode} from '../src/canvas/shared'
import {bindHistory} from '../src/historyregistry'
import type {ToastFn} from '../src/types'

const base={id:'worker',tier:'sol',state:'live',generation:1,children:[],seat:2,grant:0,free:0,
 account:'openai/backup',scope:{tools:{},add_dirs:[],model_version:'5.5'}} as CanvasNode
const click=async(el:Element|null|undefined)=>inAct(async()=>{assert.ok(el);el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await flush(12)})
const escape=async()=>inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flush(4)})
async function setup(history:boolean,extra:Partial<CanvasNode>={},refuse=false,defaultState:{default_ok?:boolean;native_ok?:boolean;accounts?:StaffingAccount[]}={}){
 localStorage.clear();resetStaffingOptionsForTests();installFetch(new FakeServer())
 const fallback=globalThis.fetch,acts:Record<string,unknown>[]=[],toasts:{text:string;undo:Parameters<ToastFn>[1]}[]=[]
 let update:(fn:(n:CanvasNode)=>CanvasNode)=>void=()=>{}
 const act=(b:Record<string,unknown>)=>{acts.push(b);if(refuse)throw Error('model unavailable');if(b.op==='switch_model'&&b.tier==='sol')update(n=>({...n,pending_switch:null}));return {queued:extra.busy===true}}
 globalThis.fetch=legacyAppBackend((async(input:RequestInfo|URL,init?:RequestInit)=>{
  const path=new URL(String(input),'http://localhost').pathname
  let body:unknown=null
  if(init?.method==='POST'&&typeof init.body==='string'){
   const b=JSON.parse(init.body)
   if(path.endsWith('/gesture')){try{body={results:b.steps.map(act),history_entry:{id:7,kind:'retool',label:'Model'}}}catch{ return new Response(JSON.stringify({error:'model unavailable'}),{status:409,headers:{'content-type':'application/json'}})}}
   if(path.endsWith('/scope'))body=act({op:'scope',...b})
  }
  if(path==='/api/providers')body={providers:['openai','claude'].map(id=>({id,hire_enabled:true,status:{installed:true}}))}
  if(path.endsWith('/staffing-options'))body={tiers:['sol','luna','opus'].map(tier=>({tier,seat:2,efforts:['high'],default_ok:true,accounts:[{value:tier==='opus'?'claude/backup':'openai-1',id:tier==='opus'?'claude/backup':'openai-1',provider:tier==='opus'?'claude':'openai',ambient:false}],...defaultState})),errors:[],loading:false}
  return body!==null?new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}):fallback(input,init)
 }) as typeof fetch)
 syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol'},{tier:'luna'}]}]})
 const off=history?bindHistory('instant',{refresh:async()=>{},can:()=>true,run:async()=>{}} as never):()=>{}
 function Fixture(){const[n,setNode]=useState({...base,...extra});update=setNode;return <><QueuedModelBadge node={n}/><DeskModelButton node={n} slug="instant" op={async b=>act(b)} toast={(lines,undo)=>toasts.push({text:lines?.join(' ')??'',undo})}/></>}
 const v=await mountView(<Fixture/>,el=>el);await inAct(async()=>{await flush(16)})
 const open=async()=>click(v.el.querySelector('[aria-label="Change model for worker"]'))
 const pick=async(tier:string)=>click(document.querySelector(`[aria-label="Change agent model"] .t-${tier}`))
 return{v,acts,toasts,open,pick,close:async()=>{await v.unmount();off()}}
}
for(const history of [false,true])for(const defaultState of [{default_ok:false},{native_ok:false}])
test(`eligible secondary preserves the model choice and receives the switch: history=${history} ${JSON.stringify(defaultState)}`,async()=>{
 const s=await setup(history,{busy:true},false,defaultState)
 try{await s.open();const token=document.querySelector('[aria-label="Change agent model"] .t-luna');assert.equal(!!token,true,'eligible managed account keeps its model offered');assert.equal(token?.getAttribute('title'),'Change model to luna · account openai-1');await s.pick('luna');assert.equal(s.acts[0]?.tier,'luna');assert.equal(s.acts[0]?.account,'openai-1');assert.equal(s.acts.some(b=>b.op==='scope'&&b.model_version===''),true);assert.match(s.toasts[0]?.text??'',/next turn/);if(history)assert.equal(s.toasts[0]?.undo?.label,'Undo')}finally{await s.close()}
})
test('no usable account hides another model but current-model queue cancellation stays available',async()=>{
 const s=await setup(false,{busy:true,pending_switch:{tier:'luna'}},false,{default_ok:true,native_ok:false,accounts:[]})
 try{await s.open();assert.equal(!!document.querySelector('[aria-label="Change agent model"] .t-luna'),false);await s.pick('sol');assert.deepEqual(s.acts,[{op:'switch_model',node:'worker',tier:'sol'}])}finally{await s.close()}
})
test('cross-provider fallback account is disclosed before confirmation and used only after approval',async()=>{
 const s=await setup(false,{busy:true},false,{native_ok:false})
 try{await s.open();await s.pick('opus');assert.equal(s.acts.length,0);assert.match(document.body.textContent??'',/account claude\/backup/);await click([...document.querySelectorAll('button')].find(b=>b.textContent==='switch to opus and reset the conversation'));assert.equal(s.acts[0]?.account,'claude/backup')}finally{await s.close()}
})
for(const history of [false,true]){
 const mode=history?'history':'legacy'
 test(`${mode}: one chip click switches with default account and latest, without an options row`,async()=>{
  const s=await setup(history)
  try{await s.open();await s.pick('luna');assert.equal(s.acts[0]?.op,'switch_model');assert.equal(s.acts[0]?.tier,'luna');assert.equal(s.acts[0]?.account,'openai/primary');assert.equal(s.acts.some(b=>b.op==='scope'&&b.model_version===''),true);assert.equal(!!document.querySelector('.desk-model-options, [aria-label="Apply model change"], [aria-label="Model account"], [aria-label="Model version"]'),false);assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),false);if(history)assert.equal(s.toasts[0]?.undo?.label,'Undo')}finally{await s.close()}
 })
 test(`${mode}: busy same-provider chip queues immediately and toast names next turn`,async()=>{
  const s=await setup(history,{busy:true})
  try{await s.open();await s.pick('luna');assert.equal(s.acts[0]?.tier,'luna');assert.equal(!!document.querySelector('.overlay .confirm'),false);assert.match(s.toasts[0]?.text??'',/next turn/);if(history)assert.equal(s.toasts[0]?.undo?.label,'Undo')}finally{await s.close()}
 })
 test(`${mode}: clicking running model immediately cancels its queue without account or pin edits`,async()=>{
  const s=await setup(history,{busy:true,pending_switch:{tier:'luna'}})
  try{await s.open();await s.pick('sol');assert.deepEqual(s.acts,[{op:'switch_model',node:'worker',tier:'sol'}]);assert.equal(!!s.v.el.querySelector('[data-next-turn="model"]'),false);assert.match(s.toasts[0]?.text??'',/model change cancelled/)}finally{await s.close()}
 })
 test(`${mode}: cross-provider chip confirms before switching to default and latest`,async()=>{
  const s=await setup(history,{busy:true})
  try{await s.open();await s.pick('opus');assert.match(document.body.textContent??'',/Switching providers resets the conversation/);assert.equal(s.acts.length,0);await click([...document.querySelectorAll('button')].find(b=>b.textContent==='switch to opus and reset the conversation'));assert.equal(s.acts[0]?.tier,'opus');assert.equal(s.acts[0]?.account,'claude/primary');assert.equal(s.acts.some(b=>b.op==='scope'&&b.model_version===''),true);assert.match(s.toasts[0]?.text??'',/next turn/)}finally{await s.close()}
 })
 test(`${mode}: Escape from cross-provider confirmation saves nothing`,async()=>{
  const s=await setup(history)
  try{await s.open();await s.pick('opus');assert.match(document.body.textContent??'',/Switching providers resets the conversation/);await escape();assert.equal(s.acts.length,0);assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),false)}finally{await s.close()}
 })
 test(`${mode}: an immediate refusal is visible and leaves the picker open`,async()=>{
  const s=await setup(history,{},true)
  try{await s.open();await s.pick('luna');assert.match(s.toasts[0]?.text??'',/model unavailable/);assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),true)}finally{await s.close()}
 })
}
