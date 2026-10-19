import { FakeServer, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeskChat } from '../src/canvas/desk'
import { resetConvos } from '../src/convo'
import { agent, seedFastMode } from './fastmode-near-fixture'
test.beforeEach(()=>{seedFastMode();installFetch(new FakeServer());resetConvos()})
for(const next of [true,false])test(`queued fast ${next?'on':'off'} is in the header while its toggle stays above send`,async()=>{
 const n=agent(next,{busy:true,responding:true,fast_mode_current:!next,effort_effective:'high'})
 const view=await mountView(<DeskChat node={n} map={new Map([[n.id,n]])} slug="fixture" bare op={async()=>({})} toast={()=>{}}/>,el=>el)
 try{
  const controls=view.el.querySelector('.cc-controls')!, bolt=controls.querySelector('.cc-fast')!, badge=view.el.querySelector('[data-next-turn="fast"]')!
  const top=bolt.closest('.cc-fast-row'), lower=controls.querySelector('.cc-primary-row')
  assert.equal(!!top,true,'the toggle is back in the top control row')
  assert.equal(!!badge.closest('.cc-head-meta'),true,'queued label belongs to the header')
  assert.equal(controls.contains(badge),false,'no queued label in the composer')
  assert.equal(!!lower,true,'effort and Send retain their own lower row')
  assert.equal(lower!.querySelector('.cc-eff')!==null,true)
  assert.equal(lower!.querySelector('.cc-send')!==null,true)
  assert.equal(lower!.contains(bolt),false)
  assert.equal(top!.nextElementSibling===lower,true,'the fast row precedes the existing effort/Send row')
 }finally{await view.unmount();resetConvos()}
})
test('without a queued change the fast toggle still occupies the top row',async()=>{
 const n=agent(true,{busy:true,fast_mode_current:true,effort_effective:'high'})
 const view=await mountView(<DeskChat node={n} map={new Map([[n.id,n]])} slug="fixture" bare op={async()=>({})} toast={()=>{}}/>,el=>el)
 try{
  assert.equal(view.el.querySelector('[data-next-turn="fast"]')===null,true)
  assert.equal(view.el.querySelector('.cc-fast-row .cc-fast')!==null,true,'the toggle never drops into the lower row')
  assert.equal(view.el.querySelector('.cc-primary-row .cc-eff')!==null,true)
  assert.equal(view.el.querySelector('.cc-primary-row .cc-send')!==null,true)
 }finally{await view.unmount();resetConvos()}
})
