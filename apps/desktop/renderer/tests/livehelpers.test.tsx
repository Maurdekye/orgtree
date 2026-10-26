import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveHelpersBadge } from '../src/canvas/livehelpers'
import type { HelpersSnapshot } from '../src/canvas/livehelpers'

const initial: HelpersSnapshot = { count:2, items:[
  { id:'claude:a', harness:'claude', description:'Inspect widgets', kind:'Explore', model:'small', started_at:'2026-10-26T10:00:00Z', status:'running', live:true, transcript:true, seq:7, tool:'a/1' },
  { id:'codex:c', harness:'codex', description:'Check edges', started_at:'2026-10-26T10:00:01Z', status:'running', live:true, transcript:false },
] }
test('helper badge is absent at zero and does not read closed panels', async t => {
  const original=globalThis.fetch;const calls:string[]=[];globalThis.fetch=(async url=>{calls.push(String(url));return new Response('{}')}) as typeof fetch
  const view=await mountView(<LiveHelpersBadge slug="org" nid="worker" count={0}/>,e=>e.textContent);t.after(async()=>{await view.unmount();globalThis.fetch=original})
  assert.equal(view.el.querySelector('button'),null);assert.equal(calls.length,0)
  await view.render(<LiveHelpersBadge slug="org" nid="worker" count={2}/>);assert.match(view.last()!,/2 helpers/);assert.equal(calls.length,0)
})
test('helper panel lists native details, follows retained Claude output, and stops reads on close', async t => {
  useFakeClock();const original=globalThis.fetch,calls:string[]=[];let text='First **live update**'
  globalThis.fetch=(async url=>{calls.push(String(url));return new Response(JSON.stringify(String(url).endsWith('/helpers')?initial:{messages:[{id:'child-message',text}],live:true}),{headers:{'Content-Type':'application/json'}})}) as typeof fetch
  const view=await mountView(<LiveHelpersBadge slug="test org" nid="worker" count={2}/>,e=>e.textContent);t.after(async()=>{await view.unmount();globalThis.fetch=original;realClock()})
  await inAct(()=>view.el.querySelector('button')!.click());await flush()
  const panel=()=>document.querySelector('[aria-label="Helper agents"]')!
  assert.match(panel().textContent!,/2 live helpers/);assert.match(panel().textContent!,/Inspect widgets/);assert.match(panel().textContent!,/small/)
  assert(panel().querySelector('.helper-transcript strong'));assert(calls.includes('/api/orgs/test%20org/nodes/worker/helpertranscript/7/a%2F1'))
  text='Second live update';await advance(1500);assert.match(panel().textContent!,/Second live update/)
  await inAct(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await flush()
  assert.equal(document.querySelector('[aria-label="Helper agents"]'),null);const n=calls.length;await advance(3000);assert.equal(calls.length,n)
})
test('unsupported helper transcripts disclose the limit and never read a fabricated child path', async t => {
  const original=globalThis.fetch,calls:string[]=[]
  globalThis.fetch=(async url=>{calls.push(String(url));return new Response(JSON.stringify(String(url).endsWith('/helpers')?{count:1,items:[initial.items[1]]}:{}),{headers:{'Content-Type':'application/json'}})}) as typeof fetch
  const view=await mountView(<LiveHelpersBadge slug="org" nid="worker" count={1}/>,e=>e.textContent);t.after(async()=>{await view.unmount();globalThis.fetch=original})
  await inAct(()=>view.el.querySelector('button')!.click());await flush()
  const panel=document.querySelector('[aria-label="Helper agents"]')!
  assert.match(panel.textContent!,/not available for this harness \(Codex\)/);assert.match(panel.textContent!,/Not reported/)
  assert.equal(calls.filter(p=>p.includes('/helpertranscript/')).length,0)
})
test('helper list failure is visible and retry uses the same scoped parent', async t => {
  const original=globalThis.fetch;let fail=true
  globalThis.fetch=(async()=>new Response(JSON.stringify(fail?{error:'Synthetic helper listing failed'}:{count:0,items:[]}),{status:fail?503:200,headers:{'Content-Type':'application/json'}})) as typeof fetch
  const view=await mountView(<LiveHelpersBadge slug="org" nid="worker" count={1}/>,e=>e.textContent);t.after(async()=>{await view.unmount();globalThis.fetch=original})
  await inAct(()=>view.el.querySelector('button')!.click());await flush();assert.match(document.querySelector('[role="alert"]')!.textContent!,/Synthetic helper listing failed/)
  fail=false;await inAct(()=>document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());await flush()
  assert.match(document.querySelector('[aria-label="Helper agents"]')!.textContent!,/No helper agents are currently observed/)
})
test('last helper completion hides the badge while an open panel remains inspectable', async t => {
  const original=globalThis.fetch;globalThis.fetch=(async()=>new Response(JSON.stringify({count:0,items:initial.items.map(h=>({...h,live:false,status:'completed'}))}),{headers:{'Content-Type':'application/json'}})) as typeof fetch
  const view=await mountView(<LiveHelpersBadge slug="org" nid="worker" count={2}/>,e=>e.textContent);t.after(async()=>{await view.unmount();globalThis.fetch=original})
  await inAct(()=>view.el.querySelector('button')!.click());await flush();await view.render(<LiveHelpersBadge slug="org" nid="worker" count={0}/>);await flush()
  assert.equal(view.el.querySelector('.live-helpers-badge'),null);assert.match(document.querySelector('[aria-label="Helper agents"]')!.textContent!,/0 live helpers/)
})
