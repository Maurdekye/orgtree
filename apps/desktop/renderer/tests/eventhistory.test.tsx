import './harness'
import {FakeServer,flush,inAct,installFetch,mountView,realClock,useFakeClock} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
declare const __SRC_DIR__: string
const {BASE}=await import('../src/api')
const {DeskChat,HistoryView}=await import('../src/canvas/desk')
import type {CanvasNode} from '../src/canvas/shared'
test('history renders typed status and preserves legacy and unsupported content',async t=>{
  assert.equal(BASE,'')
  useFakeClock(); const old=globalThis.fetch
  const f=JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events/status.report.json'),'utf8'))
  const event={...f.private,summary:'Visible status summary C'}
  const items=[{at:'2026-09-06T12:00:00Z',kind:'notice',actor:'system',detail:{text:'Legacy status projection'},ev:event},
    {at:'2026-09-06T12:01:00Z',kind:'notice',actor:'system',detail:{text:'Literal [DONE] older notice'}},
    {at:'2026-09-06T12:02:00Z',kind:'notice',actor:'system',detail:{text:'Unknown format retained'},ev_error:{code:'variant',path:'variant',expected:'known'}}]
  globalThis.fetch=(async()=>({ok:true,status:200,headers:new Headers(),json:async()=>({items})} as Response)) as typeof fetch
  const view=await mountView(<HistoryView slug="fixture" nid="worker"/>,h=>h)
  t.after(async()=>{await view.unmount();globalThis.fetch=old;realClock()})
  await flush()
  assert.equal(view.el.querySelectorAll('.event-status').length,1)
  assert.match(view.el.querySelector('.event-status')!.textContent!,/Visible status summary C/)
  assert.doesNotMatch(view.el.querySelector('.event-status')!.textContent!,/Legacy status projection/)
  assert.equal(view.el.querySelectorAll('.hist-row').length,1)
  assert.match(view.el.textContent!,/Literal \[DONE\] older notice/)
  assert.match(view.el.querySelector('.event-fallback')!.textContent!,/Unknown format retained/)
})

test('history keeps ordinary messages and notices styled with navigable agent senders',async t=>{
  useFakeClock(); const server=new FakeServer(); installFetch(server); const old=globalThis.fetch
  const message=JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events/ordinary.message.json'),'utf8')).private
  const notice=JSON.parse(readFileSync(path.resolve(__SRC_DIR__,'../tests/fixtures/events/ordinary.notice.json'),'utf8')).private
  const actor='peer-agent'
  const items=[
    {at:'2026-09-06T12:00:00Z',kind:'message',actor,detail:{text:'message fallback'},ev:{...message,actor:{kind:'agent',id:actor},body:'Normal message C'}},
    {at:'2026-09-06T12:01:00Z',kind:'notice',actor,detail:{text:'notice fallback'},ev:{...notice,actor:{kind:'agent',id:actor},body:'Passive notice C'}},
    {at:'2026-09-06T12:02:00Z',kind:'message',actor,detail:{text:'Legacy known sender'}},
    {at:'2026-09-06T12:03:00Z',kind:'notice',actor:'missing-agent',detail:{text:'Legacy missing sender'}},
    {at:'2026-09-06T12:04:00Z',kind:'notice',actor:'@org:outside',detail:{text:'Legacy external sender'}},
  ]
  globalThis.fetch=(async(url,init)=>String(url).endsWith('/history')
    ? ({ok:true,status:200,headers:new Headers(),json:async()=>({items})} as Response)
    : old(url,init)) as typeof fetch
  const jumped:string[]=[]
  const worker:CanvasNode={id:'worker',generation:1,state:'live',tier:'haiku',children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]}}
  const peer:CanvasNode={id:actor,generation:1,state:'live',tier:'sonnet',children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]}}
  const view=await mountView(<DeskChat node={worker} map={new Map([[worker.id,worker],[peer.id,peer]])}
    slug="fixture" op={async()=>({})} toast={()=>{}} pub={false} bare onJump={id=>jumped.push(id)}/>,h=>h)
  t.after(async()=>{await view.unmount();globalThis.fetch=old;realClock()})
  await flush()
  const history=[...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')]
    .find(button=>button.textContent === 'history')!
  await inAct(()=>history.click())
  await flush()
  assert.equal(view.el.querySelectorAll('.hist-event.event-ordinary').length,2)
  assert.match(view.el.textContent!,/Message/)
  assert.match(view.el.textContent!,/Notice/)
  assert.equal(view.el.querySelectorAll('.hist-row').length,3)
  const eventJumps=view.el.querySelectorAll<HTMLButtonElement>('.hist-event button.cc-name-jump')
  assert.equal(eventJumps.length,2)
  eventJumps.forEach(button=>button.click())
  const legacyJump=view.el.querySelector<HTMLButtonElement>('.hist-row button.cc-name-jump')!
  legacyJump.click()
  assert.equal(view.el.querySelectorAll('.hist-row button.cc-name-jump').length,1)
  assert.deepEqual(jumped,[actor,actor,actor])
})
