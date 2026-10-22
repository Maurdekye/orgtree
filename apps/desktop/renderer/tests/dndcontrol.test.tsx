import { flush, inAct, mountView, FakeServer, installFetch } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { DndControl } from '../src/canvas/dnd'
import { resetConvos } from '../src/convo'
import type { CanvasNode } from '../src/canvas/shared'

const worker={id:'worker',tier:'sol',kind:'agent',state:'live',generation:1,children:[],seat:2,grant:0,
  scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[]},turns:[],lineage:[],
  audiences_held:[],mail_pending:0} as unknown as CanvasNode

test('live desk exposes a header DnD control and an armed badge without urgency',async t=>{
  resetConvos();installFetch(new FakeServer())
  const node={...worker,dnd:false,dnd_next_turn:true}
  const v=await mountView(<DeskChat node={node} map={new Map([[node.id,node]])} slug="dnd-control-desk"
    op={async()=>({})} toast={()=>{}} bare/>,el=>el)
  t.after(async()=>{await v.unmount();resetConvos()})
  await inAct(async()=>{await flush(3)})
  assert.equal(v.el.querySelector('.cc-head-top .dnd-control')?.textContent,'DND next turn')
  assert.equal(v.el.querySelector('.cc-head-meta .dnd-badge')?.textContent,'DND next turn')
  assert.equal(v.el.querySelector('.cc-urgent-toggle'),null,'armed is not an active bypass target')
  const retired={...node,state:'archived'}
  await v.render(<DeskChat node={retired} map={new Map([[retired.id,retired]])} slug="dnd-control-desk"
    op={async()=>({})} toast={()=>{}} bare/>)
  assert.equal(v.el.querySelector('.dnd-control'),null,'retired targets have no runtime toggle')
})

test('idle control arms and clears the same target using explicit boolean POSTs',async t=>{
  const previous=globalThis.fetch
  const calls:{url:string;dnd:boolean}[]=[]
  globalThis.fetch=async(input,init)=>{
    const dnd=JSON.parse(String(init?.body)).dnd
    calls.push({url:String(input),dnd})
    assert.equal(init?.method,'POST')
    return new Response(JSON.stringify({dnd:false,dnd_next_turn:dnd,turn:null}),{status:200})
  }
  const v=await mountView(<DndControl slug="test-org" nid="worker" toast={()=>{}}/>,el=>el)
  t.after(async()=>{await v.unmount();globalThis.fetch=previous})
  const button=v.el.querySelector('button')!
  assert.equal(button.getAttribute('aria-pressed'),'false')
  await inAct(async()=>{button.click();await flush(2)})
  assert.equal(button.textContent,'DND next turn')
  assert.equal(button.getAttribute('aria-pressed'),'true')
  await inAct(async()=>{button.click();await flush(2)})
  assert.equal(button.getAttribute('aria-pressed'),'false')
  assert.deepEqual(calls,[{url:'/api/orgs/test-org/nodes/worker/dnd',dnd:true},
    {url:'/api/orgs/test-org/nodes/worker/dnd',dnd:false}])
})

test('failed clear preserves active state and exposes the refusal',async t=>{
  const previous=globalThis.fetch
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'runtime unavailable'}),{status:409})
  const notices:string[][]=[]
  const v=await mountView(<DndControl slug="test-org" nid="worker" active toast={m=>notices.push(m)}/>,el=>el)
  t.after(async()=>{await v.unmount();globalThis.fetch=previous})
  const button=v.el.querySelector('button')!
  await inAct(async()=>{button.click();await flush(2)})
  assert.equal(button.getAttribute('aria-pressed'),'true')
  assert.equal(button.disabled,false)
  assert.match(notices.flat().join(' '),/runtime unavailable/)
})
