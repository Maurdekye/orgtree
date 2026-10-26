import {createPortal} from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import {inAct,mountView} from './harness'
import {CardHoverCard} from './cardhoverfit-fixture'
import {CardNameRevealProvider} from '../src/canvas/cardnamereveal'
import {DeskHead} from '../src/canvas/deskshell'

test('mini inline names leave the CSS reveal path while any portal desk is registered',async t=>{
  const remote=document.implementation.createHTMLDocument('Other desk')
  const scene=(desks:number)=><CardNameRevealProvider><CardHoverCard kind="agent" lod="mini" crowded={false}/>{Array.from({length:desks},(_,i)=>createPortal(<DeskHead nodeId={'other-'+i} left={<b>Other desk</b>} tabs={null}/>,remote.body,'desk-'+i))}</CardNameRevealProvider>
  const view=await mountView(scene(0),e=>e);t.after(()=>view.unmount())
  const card=()=>view.el.querySelector('.sq.mini')!
  assert.ok(card().querySelector('.sq-far-name'),'closed-desk inline name remains available')
  await view.render(scene(2));await inAct(()=>card().dispatchEvent(new MouseEvent('pointerover',{bubbles:true})))
  assert.equal(remote.querySelectorAll('.cc-head').length,2)
  assert.equal(!!card().querySelector('.sq-far-name'),false,'no inline name for hover/focus CSS to reveal')
  assert.equal(!!view.el.querySelector('.sq-far-ghost'),false,'floating name is suppressed too')
  await view.render(scene(1));assert.equal(!!card().querySelector('.sq-far-name'),false,'one remaining desk still suppresses names')
  await view.render(scene(0));assert.ok(card().querySelector('.sq-far-name'),'last desk closing restores the inline reveal')
  assert.ok(card().querySelector('.tier'),'model token stays present')
})
