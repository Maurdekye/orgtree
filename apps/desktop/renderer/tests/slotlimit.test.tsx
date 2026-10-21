import test from 'node:test'
import assert from 'node:assert/strict'
import {flush,inAct,mountView} from './harness'
import {SlotsView} from '../src/canvas/slotsdesk'
import {AgentSlotChips} from '../src/canvas/slotchips'
import {slotCount,slotUnits,slotLinks} from '../src/canvas/slots'
import type {ProjectSlotState,SlotLease} from '../src/canvas/slots'
import type {CanvasNode,OpResult} from '../src/canvas/shared'

const node={id:'resource',kind:'project',tier:'project',state:'live',children:[]} as unknown as CanvasNode
const empty={project:'resource',slots:10,held:0,holders:[],line:[],history:[]}
const read=(resolve?:(v:unknown)=>void)=>empty
const state=(held=0):ProjectSlotState=>({total:10,held:held?[{lease:'mine',project:'resource',agent:'user',slots:held,slot:1,since:'2026-10-21T00:00:00Z',reminders:0}]:[],line:[]})
const input=(el:HTMLElement)=>el.querySelector<HTMLInputElement>('input[aria-label="Slots to hold"]')!

test('slot limit: live tree caps a hold while its detail refresh is pending',async t=>{
 let resolve:(v:OpResult)=>void=()=>{};let calls=0
 const op=async()=>{if(++calls===1)return empty as unknown as OpResult;return new Promise<OpResult>(r=>{resolve=r})}
 const render=(held:number)=><SlotsView node={node} state={state(held)} map={new Map()} op={op} toast={()=>{}}/>
 const v=await mountView(render(0),el=>el);t.after(()=>v.unmount())
 await inAct(async()=>{await flush(3)})
 await v.render(render(8))
 assert.equal(input(v.el).max,'2')
 await inAct(async()=>{resolve({...empty,held:8,holders:[{lease:'mine',agent:'user',slots:8,since:'2026-10-21T00:00:00Z'}]} as unknown as OpResult);await flush(3)})
 assert.equal(input(v.el).max,'2')
})

test('slot limit: engine refusal remains visible on the hold control',async t=>{
 const op=async(req:{op:string})=>{if(req.op==='slot_status')return empty as unknown as OpResult;throw Error('Only 2 slots remain; release a hold first')}
 const v=await mountView(<SlotsView node={node} state={state()} map={new Map()} op={op} toast={()=>{}}/>,el=>el);t.after(()=>v.unmount())
 await inAct(async()=>{await flush(3);v.el.querySelector<HTMLButtonElement>('[data-action="hold-slots"]')!.click();await flush(3)})
 assert.match(v.el.querySelector('[role="alert"]')?.textContent??'',/Only 2 slots remain/)
})

test('slot limit: the measured seven-digit maximum survives payload readers and input',async t=>{
 assert.equal(slotUnits(9_999_999),9_999_999)
 assert.equal(slotCount({...node,configured_scope:{slots_capacity:9_999_999}} as unknown as CanvasNode),9_999_999)
 const huge={...empty,slots:9_999_999}
 const v=await mountView(<SlotsView node={node} state={{...state(),total:9_999_999}} map={new Map()} op={async()=>huge as unknown as OpResult} toast={()=>{}}/>,el=>el);t.after(()=>v.unmount())
 await inAct(async()=>{await flush(3)})
 assert.equal(input(v.el).max,'9999999')
})

test('slot limit: many leases to one project use one holder chip and one canvas line',async t=>{
 const leases:SlotLease[]=Array.from({length:250},(_,i)=>({lease:'lease'+i,agent:'reader',project:'resource',slot:i+1,slots:1,since:'2026-10-21T00:00:00Z',reminders:0}))
 const v=await mountView(<AgentSlotChips agent="reader" leases={leases}/>,el=>el);t.after(()=>v.unmount())
 assert.equal(v.el.querySelectorAll('.slot-hold').length,1)
 assert.match(v.el.textContent??'',/250/)
 assert.equal(slotLinks([],leases,()=>true).length,1)
})

test('slot limit: holder rows are bounded before the user asks for more',async t=>{
 const holders=Array.from({length:250},(_,i)=>({lease:'lease'+i,agent:'reader',slots:1,since:'2026-10-21T00:00:00Z'}))
 const v=await mountView(<SlotsView node={node} state={{total:300,held:[],line:[]}} map={new Map()} op={async()=>({...empty,slots:300,held:250,holders}) as unknown as OpResult} toast={()=>{}}/>,el=>el);t.after(()=>v.unmount())
 await inAct(async()=>{await flush(3)})
 assert.ok(v.el.querySelectorAll('.slots-table .holding').length<=100)
 assert.match(v.el.textContent??'',/more.*holds|holds.*more/i)
})
