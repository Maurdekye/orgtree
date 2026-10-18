import test from 'node:test'
import assert from 'node:assert/strict'
import {flush,inAct,mountView} from './harness'
import {NodeConfig} from '../src/canvas/modals'
import {ackProject,ackTree,mockAckSettings} from './acksettings-fixture'
import type {TestContext} from 'node:test'
async function settings(t:TestContext,scope:Record<string,unknown>={},checkups=true){
  mockAckSettings(checkups);const node=ackProject(scope),ops:unknown[]=[]
  const view=await mountView(<NodeConfig node={node} map={new Map([[node.id,node]])} tree={ackTree} slug="synthetic"
    op={async b=>{ops.push(b);return {} as any}} toast={()=>{}} close={()=>{}}/>,el=>el)
  t.after(()=>view.unmount());await inAct(async()=>{await flush(4)});return {...view,ops}
}
test('round-robin without slots hides acknowledgement controls',async t=>{
  const {el}=await settings(t)
  assert.equal(!!el.querySelector('[aria-label="Acknowledgement"]'),false)
  assert.equal(!!el.querySelector('input[aria-label="Max attempts"]'),false)
})
test('a slot alone shows acknowledgement at the bottom and slot changes toggle it',async t=>{
  const {el}=await settings(t,{slots_capacity:1})
  const section=el.querySelector('[aria-label="Acknowledgement"]')
  assert.equal(!!section,true,'slot holders need acknowledgement settings even in round-robin')
  assert.equal(section?.parentElement?.lastElementChild===section,true,'acknowledgement is the bottom section')
  assert.equal(el.querySelector<HTMLInputElement>('input[aria-label="Ack reminders"]')?.value,'3')
  const slots=el.querySelector<HTMLInputElement>('input[aria-label="Concurrency slots"],input[aria-label="Slots"]')!
  await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(slots,'0');slots.dispatchEvent(new Event('input',{bubbles:true}))})
  assert.equal(!!el.querySelector('[aria-label="Acknowledgement"]'),false)
})
test('ack mode shows the saved reminder count and saves only an edited count',async t=>{
  const {el,ops}=await settings(t,{mail_queue:'ack',mail_queue_ack_reminders:5})
  const count=el.querySelector<HTMLInputElement>('input[aria-label="Ack reminders"]')
  assert.equal(!!count,true,'configurable reminder count is present')
  assert.equal(count!.value,'5');assert.equal(count!.min,'1');assert.equal(count!.max,'10')
  await inAct(()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(count,'8');count!.dispatchEvent(new Event('input',{bubbles:true}))})
  await inAct(async()=>{[...el.querySelectorAll('button')].find(b=>b.textContent==='save')!.click();await flush(4)})
  assert.deepEqual(ops,[{op:'set_mail_queue',node:'build-project',ack_reminders:8}])
})
test('slot-only acknowledgement controls are inactive when runtime checkups are off',async t=>{
  const {el}=await settings(t,{slots_capacity:1},false)
  const count=el.querySelector<HTMLInputElement>('input[aria-label="Ack reminders"]')
  assert.equal(!!count,true,'slot-only reminder control remains visible')
  assert.equal(count!.disabled,true)
  assert.equal(el.querySelector<HTMLInputElement>('input[aria-label="Max attempts"]')!.disabled,true)
})
