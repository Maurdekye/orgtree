import { FakeServer, installFetch, mountView, inAct, flush } from './harness'
import { legacyAppBackend } from './appfeed-fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import { resetStaffingOptionsForTests } from '../src/canvas/staffingoptions'
import { syncProviderRegistries, type CanvasNode } from '../src/canvas/shared'

const noop=()=>{}
const node={id:'worker',tier:'sol',state:'live',generation:1,children:[],seat:2,grant:0,free:0,
  scope:{tools:{},add_dirs:[]},account:'openai/primary'} as CanvasNode
const click=async(el:Element|null)=>inAct(async()=>{assert.ok(el);el.dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await flush(8)})
async function mount(extra:Partial<CanvasNode>={},refuse=false){
  localStorage.clear();resetConvos();resetStaffingOptionsForTests();installFetch(new FakeServer())
  const fallback=globalThis.fetch,ops:Record<string,unknown>[]=[],toasts:string[][]=[]
  globalThis.fetch=legacyAppBackend((async(input:RequestInfo|URL,init?:RequestInit)=>{
    const path=new URL(String(input),'http://localhost').pathname
    const body=path==='/api/providers'?{providers:[{id:'openai',hire_enabled:true,status:{installed:true}}]}:
      path.endsWith('/staffing-options')?{tiers:['sol','luna'].map(tier=>({tier,seat:2,efforts:['high'],default_ok:true,accounts:[{value:'openai/backup',id:'backup',provider:'openai',ambient:false}]})),errors:[],loading:false}:null
    return body?new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}}):fallback(input,init)
  }) as typeof fetch)
  syncProviderRegistries({providers:[{id:'openai',tiers:[{tier:'sol'},{tier:'luna'}]}]})
  const n={...node,...extra}
  const v=await mountView(<DeskChat bare node={n} map={new Map([[n.id,n]])} slug="org"
    op={async b=>{ops.push(b);if(refuse)throw Error('model unavailable');return{queued:n.busy}}} toast={lines=>toasts.push(lines)}/>,el=>el)
  await inAct(async()=>{await flush(12)})
  return{v,ops,toasts}
}
test.afterEach(()=>resetConvos())
test('desk model icon opens the hire token picker; Escape and click-away cancel',async()=>{
 const {v,ops}=await mount()
 try{
  await click(v.el.querySelector('[aria-label="Change model for worker"]'))
  assert.ok(document.querySelector('[aria-label="Change agent model"] .t-luna'))
  await inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await flush(3)})
  assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),false)
  await click(v.el.querySelector('[aria-label="Change model for worker"]'))
  await inAct(async()=>{document.body.dispatchEvent(new window.Event('pointerdown',{bubbles:true}));await flush(3)})
  assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),false)
  assert.equal(ops.length,0)
 }finally{await v.unmount()}
})
for(const refuse of [false,true])test(`desk model pick uses switch_model and surfaces refusal=${refuse}`,async()=>{
 const{v,ops,toasts}=await mount({},refuse)
 try{
  await click(v.el.querySelector('[aria-label="Change model for worker"]'))
  await click(document.querySelector('[aria-label="Change agent model"] .t-luna'))
  await click(document.querySelector('[aria-label="Apply model change"]'))
  assert.equal(ops[0]?.op,'switch_model');assert.equal(ops[0]?.tier,'luna')
  assert.equal(!!document.querySelector('[aria-label="Change agent model"]'),refuse)
  if(refuse)assert.match(toasts.flat().join(' '),/model unavailable/)
 }finally{await v.unmount()}
})
test('busy model selection confirms before queuing; retired icons stay passive',async()=>{
 const{v,ops}=await mount({busy:true})
 try{
  await click(v.el.querySelector('[aria-label="Change model for worker"]'))
  await click(document.querySelector('[aria-label="Change agent model"] .t-luna'))
  await click(document.querySelector('[aria-label="Apply model change"]'))
  assert.equal(ops.length,0)
  const confirm=[...document.querySelectorAll('button')].find(b=>b.textContent==='queue the switch to luna')
  await click(confirm??null);assert.equal(ops[0]?.op,'switch_model')
 }finally{await v.unmount()}
 const retired=await mount({state:'retired'})
 try{assert.equal(!!retired.v.el.querySelector('[aria-label="Change model for worker"]'),false)}finally{await retired.v.unmount()}
})
