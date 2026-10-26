import {createPortal} from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import {inAct,mountView} from './harness'
import {CardHoverCard} from './cardhoverfit-fixture'
import {CardNameRevealProvider} from '../src/canvas/cardnamereveal'
import {DeskHead} from '../src/canvas/deskshell'

// USER 2026-10-26 ("Never hide on hover", "revert that change"): hovering a mini node always
// reveals its name, with or without open desks; only the floating plate is suppressed.
test('mini inline names stay in the CSS hover reveal path while portal desks are registered',async t=>{
  const remote=document.implementation.createHTMLDocument('Other desk')
  const scene=(desks:number)=><CardNameRevealProvider><CardHoverCard kind="agent" lod="mini" crowded={false}/>{Array.from({length:desks},(_,i)=>createPortal(<DeskHead nodeId={'other-'+i} left={<b>Other desk</b>} tabs={null}/>,remote.body,'desk-'+i))}</CardNameRevealProvider>
  const view=await mountView(scene(0),e=>e);t.after(()=>view.unmount())
  const card=()=>view.el.querySelector('.sq.mini')!
  assert.ok(card().querySelector('.sq-far-name'),'closed-desk inline name remains available')
  await view.render(scene(2));await inAct(()=>card().dispatchEvent(new MouseEvent('pointerover',{bubbles:true})))
  assert.equal(remote.querySelectorAll('.cc-head').length,2)
  assert.ok(card().querySelector('.sq-far-name'),'open desks keep the inline name for the hover/focus CSS reveal')
  assert.equal(!!view.el.querySelector('.sq-far-ghost'),false,'only the floating name is suppressed')
  await view.render(scene(1));assert.ok(card().querySelector('.sq-far-name'),'one remaining desk keeps the inline name too')
  await view.render(scene(0));assert.ok(card().querySelector('.sq-far-name'),'closing the last desk keeps the inline name')
  assert.ok(card().querySelector('.tier'),'model token stays present')
})
