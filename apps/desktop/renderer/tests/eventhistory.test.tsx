import './harness'
import {flush,mountView,realClock,useFakeClock} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
declare const __SRC_DIR__: string
const {DeskChat,HistoryView}=await import('../src/canvas/desk')
import type {CanvasNode} from '../src/canvas/shared'
test('history renders typed status and preserves legacy and unsupported content',async t=>{
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

test('desk tab row no longer offers Files or History',async t=>{
  useFakeClock()
  const worker:CanvasNode={id:'worker',generation:1,state:'live',tier:'haiku',children:[],seat:1,grant:0,free:0,scope:{tools:{},add_dirs:[]}}
  const view=await mountView(<DeskChat node={worker} map={new Map([[worker.id,worker]])}
    slug="fixture" op={async()=>({})} toast={()=>{}} bare/>,h=>h)
  t.after(async()=>{await view.unmount();realClock()})
  await flush()
  const deskTabs = [...view.el.querySelectorAll<HTMLButtonElement>('.cc-tabs button')]
    .map(button => button.textContent?.trim())
  assert.equal(deskTabs.includes('history'), false, 'History moved to agent settings')
  assert.equal(deskTabs.includes('files'), false, 'scratch browsing moved to the OS file explorer')
})
