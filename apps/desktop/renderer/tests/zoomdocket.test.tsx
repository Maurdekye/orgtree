import { flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { tree, payload } from './zoomdocket.fixture'
import { OrgCanvas } from '../src/canvas/OrgCanvas'

const click = async (e:Element|null) => { assert.ok(e); await inAct(()=>{(e as HTMLElement).click()}); await flush() }
test('overview Docket opens the selected agent, archive toggle and details reuse existing view',async t=>{
 useFakeClock(); const calls:string[]=[]
 globalThis.fetch=async (url,init)=>{
  assert.equal(init?.method??'GET','GET','no mutation requested')
  calls.push(String(url))
  return new Response(JSON.stringify(String(url).includes('/work-items')?payload:{}),{headers:{'Content-Type':'application/json'}})
 }
 const v=await mountView(<OrgCanvas tree={tree(['alpha','beta','empty'])} slug="mine" op={async()=>({})} toast={()=>{}} mailEvt={null}/>,x=>x)
 t.after(async()=>{await v.unmount();realClock()})
 await flush()
 assert.equal(calls.filter(x=>x.includes('/work-items')).length,0,'no per-card docket polling')
 await click(v.el.querySelector('[aria-label="Docket for alpha"]'))
 const panel=()=>v.el.querySelector('.docket-agent')!
 assert.match(panel().textContent??'',/alpha-task/)
 assert.doesNotMatch(panel().textContent??'',/beta-task|alpha-archive/)
 await click(panel().querySelector('input[type=checkbox]'))
 assert.match(panel().textContent??'',/alpha-archive/)
 await click([...panel().querySelectorAll('.docket-row')].find(e=>e.textContent?.includes('alpha-task'))??null)
 assert.match(panel().textContent??'',/Test objective/)
 await click([...v.el.querySelectorAll('.overlay button')].find(e=>e.textContent==='Close')??null)
 assert.equal(v.el.querySelector('.docket-agent'),null)
 await click(v.el.querySelector('[aria-label="Docket for beta"]'))
 assert.match(panel().textContent??'',/beta-task/)
 assert.doesNotMatch(panel().textContent??'',/alpha-task|alpha-archive/)
 await click([...v.el.querySelectorAll('.overlay button')].find(e=>e.textContent==='Close')??null)
 await click(v.el.querySelector('[aria-label="Docket for empty"]'))
 assert.match(panel().textContent??'',/no docket items are assigned to empty/)
 assert.ok(calls.some(x=>x.includes('/api/orgs/mine/work-items')),'uses enclosing org route')
})
