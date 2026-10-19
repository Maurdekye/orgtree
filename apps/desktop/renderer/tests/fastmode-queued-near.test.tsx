import { mountView, installFetch, FakeServer, inAct } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { NearCard, agent, seedFastMode } from './fastmode-near-fixture'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import { syncProviderRegistries } from '../src/canvas/shared'
const badge=(el:HTMLElement)=>el.querySelector<HTMLElement>('[data-next-turn="fast"]')
test.beforeEach(()=>{seedFastMode();installFetch(new FakeServer());resetConvos()})
for(const saved of [true,false]) test(`near queued fast ${saved?'on':'off'} is separate from active speed`,async()=>{
 const view=await mountView(<NearCard node={agent(saved,{busy:true,fast_mode_current:!saved})}/>,el=>el)
 try{
  const mark=badge(view.el)
  assert.equal(!!mark,true,'queued fast card is visible near zoom')
  assert.equal(mark!.textContent,`next turn: fast ${saved?'on':'off'}`)
  assert.equal(mark!.title,`worker's fast will change from fast ${saved?'off':'on'} to fast ${saved?'on':'off'} next turn`)
  assert.equal(mark!.getAttribute('aria-label'),mark!.title)
  assert.equal(mark!.closest('.sq-badges')!==null,true)
  assert.equal(mark!.querySelector('button')===null,true)
  assert.equal(!!view.el.querySelector('.badge.fast-mode'),!saved,'bolt reflects active speed independently')
 }finally{await view.unmount()}
})
test('near queued state clears on reversion, admission and completion',async()=>{
 const queued=agent(true,{busy:true,fast_mode_current:false})
 const view=await mountView(<NearCard node={queued}/>,el=>el)
 try{
  assert.equal(!!badge(view.el),true)
  for(const n of [agent(false,{busy:true,fast_mode_current:false}),agent(true,{busy:true,fast_mode_current:true}),agent(true)]){
   await view.render(<NearCard node={n}/>);assert.equal(badge(view.el)===null,true)
  }
 }finally{await view.unmount()}
})
test('unsupported, archived, idle, matching and unknown serving speed stay silent',async()=>{
 const queued=agent(true,{busy:true,fast_mode_current:false})
 const pin=agent(true,{busy:true,fast_mode_current:false});pin.scope!.model_version='6'
 for(const n of [{...queued,tier:'haiku'},{...queued,state:'archived'},pin,agent(),agent(true,{busy:true,fast_mode_current:true}),agent(true,{busy:true}),agent(true,{busy:true,fast_mode_current:null})]){
  const view=await mountView(<NearCard node={n}/>,el=>el)
  try{assert.equal(badge(view.el)===null,true)}finally{await view.unmount()}
 }
})
test('far/map exclude queued cards and provider support loss clears them',async()=>{
 const queued=agent(true,{busy:true,fast_mode_current:false})
 for(const props of [{lod:'mini' as const},{mapMode:true}]){
  const view=await mountView(<NearCard node={queued} {...props}/>,el=>el)
  try{assert.equal(badge(view.el)===null,true)}finally{await view.unmount()}
 }
 const view=await mountView(<NearCard node={queued}/>,el=>el)
 try{assert.equal(!!badge(view.el),true);await inAct(()=>syncProviderRegistries({providers:[]}));assert.equal(badge(view.el)===null,true)}finally{await view.unmount()}
})
test('real desk puts queued speed in the header and keeps composer controls together',async()=>{
 const n=agent(true,{responding:true,busy:true,fast_mode_current:false,effort_effective:'high'})
 const view=await mountView(<DeskChat node={n} map={new Map([[n.id,n]])} slug="fixture" bare op={async()=>({})} toast={()=>{}}/>,el=>el)
 try{
  const mark=badge(view.el), controls=view.el.querySelector('.cc-controls')
  assert.equal(!!mark?.closest('.cc-head-meta'),true,'header owns the pending card')
  assert.equal(!!controls?.querySelector('[data-next-turn]'),false)
  for(const selector of ['.cc-fast','.cc-eff','.cc-send'])assert.equal(controls!.querySelector(selector)!==null,true,selector)
 }finally{await view.unmount();resetConvos()}
})
