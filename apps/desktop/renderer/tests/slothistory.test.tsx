import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { SlotsView } from '../src/canvas/slotsdesk'
import type { CanvasNode, OpRequest, OpResult } from '../src/canvas/shared'

const node = (id='build') => ({id, kind:'project', tier:'project', state:'live', children:[]}) as unknown as CanvasNode
const state = { total:1, held:[], line:[] }
const hold = (lease:string) => ({lease,agent:'worker',slot:1,since:'2026-10-19T10:00:00Z',ended:'2026-10-19T11:00:00Z'})
const page = (ids:string[],next:string|null) => ({project:'build',slots:1,held:0,holders:[],line:[],history:ids.map(hold),history_next:next})
const rows = (el:HTMLElement) => [...el.querySelectorAll('.slots-history .slot-lease')].map(row=>row.textContent)
const settle = async () => inAct(async()=>{await flush(4)})
async function bottom(el:HTMLElement) {
 const scroll=el.querySelector<HTMLElement>('.slots-table-scroll')!
 Object.defineProperties(scroll,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:400},scrollTop:{configurable:true,value:1600}})
 await inAct(async()=>{scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await flush(4)})
}

test('recent holds fetch only near the bottom, dedupe overlapping pages, and stop at the end',async t=>{
 const requests:OpRequest[]=[]
 let release!:(value:OpResult)=>void
 const op=async(req:OpRequest)=>{requests.push(req);if(req.op==='slot_status')return page(['s3','s2'],'cursor2') as unknown as OpResult
   return new Promise<OpResult>(resolve=>{release=resolve})}
 const v=await mountView(<SlotsView node={node()} state={state} map={new Map()} op={op} toast={()=>{}}/>,el=>el)
 t.after(()=>v.unmount());await settle()
 assert.deepEqual(rows(v.el),['s3','s2']);assert.equal(requests.length,1,'no eager older-history read')
 await bottom(v.el);await bottom(v.el)
 assert.deepEqual(requests[1],{op:'slot_history',node:'build',history_before:'cursor2'})
 assert.equal(requests.length,2,'only one request while the page is in flight')
 assert.deepEqual(rows(v.el),['s3','s2'],'existing rows remain visible while loading')
 await inAct(async()=>{release(page(['s2','s1'],null) as unknown as OpResult);await flush(4)})
 assert.deepEqual(rows(v.el),['s3','s2','s1'])
 await bottom(v.el);assert.equal(requests.length,2,'no fetch after the final page')
})

test('failed older pages leave rows in place and can be retried',async t=>{
 let attempts=0
 const op=async(req:OpRequest)=>{if(req.op==='slot_status')return page(['s2'],'cursor2') as unknown as OpResult
   if(++attempts===1)throw new Error('offline');return page(['s1'],null) as unknown as OpResult}
 const v=await mountView(<SlotsView node={node()} state={state} map={new Map()} op={op} toast={()=>{}}/>,el=>el)
 t.after(()=>v.unmount());await settle();await bottom(v.el)
 assert.deepEqual(rows(v.el),['s2'])
 assert.match(v.el.textContent??'',/Could not load older holds/)
 const retry=[...v.el.querySelectorAll('button')].find(b=>b.textContent==='Retry')
 assert.ok(retry);await inAct(async()=>{retry.click();await flush(4)})
 assert.deepEqual(rows(v.el),['s2','s1'])
})

test('a stale older-page response cannot enter a different project',async t=>{
 let release!:(value:OpResult)=>void
 const op=async(req:OpRequest)=>req.op==='slot_history'?new Promise<OpResult>(resolve=>{release=resolve}):
   page([req.node==='other'?'other1':'s2'],'cursor') as unknown as OpResult
 const v=await mountView(<SlotsView node={node()} state={state} map={new Map()} op={op} toast={()=>{}}/>,el=>el)
 t.after(()=>v.unmount());await settle();await bottom(v.el)
 await v.render(<SlotsView node={node('other')} state={state} map={new Map()} op={op} toast={()=>{}}/>)
 await settle()
 await inAct(async()=>{release(page(['old-project-row'],null) as unknown as OpResult);await flush(4)})
 assert.deepEqual(rows(v.el),['other1'])
})

test('new top holds preserve loaded older rows and the existing older cursor',async t=>{
 let head=0
 const requests:OpRequest[]=[]
 const op=async(req:OpRequest)=>{requests.push(req);return (req.op==='slot_status'?
   ++head===1?page(['s3','s2'],'cursor2'):page(['s4','s3'],'new-head-cursor'):
   req.history_before==='cursor2'?page(['s2','s1'],'cursor1'):page(['s0'],null)) as unknown as OpResult}
 const render=(total:number)=><SlotsView node={node()} state={{...state,total}} map={new Map()} op={op} toast={()=>{}}/>
 const v=await mountView(render(1),el=>el)
 t.after(()=>v.unmount());await settle();await bottom(v.el)
 assert.deepEqual(rows(v.el),['s3','s2','s1'])
 await v.render(render(2));await settle()
 assert.deepEqual(rows(v.el),['s4','s3','s2','s1'])
 await bottom(v.el)
 assert.equal(requests.at(-1)?.history_before,'cursor1')
 assert.deepEqual(rows(v.el),['s4','s3','s2','s1','s0'])
})
