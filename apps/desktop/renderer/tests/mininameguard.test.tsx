import {createPortal} from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {inAct,mountView} from './harness'
import {CardHoverCard} from './cardhoverfit-fixture'
import {CardNameRevealProvider} from '../src/canvas/cardnamereveal'
import {DeskHead} from '../src/canvas/deskshell'

declare const __SRC_DIR__:string

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

// The ruling covers project nodes too (USER 2026-10-26 on 4.5.0-alpha.3: "hovering projects at mini node
// zoom doesnt show their name"): a mini project carries the agent's in-card reveal group, folder then name,
// which the stylesheet shows only while the card is hovered or focused.
test('mini project names stay in the CSS hover reveal path while portal desks are registered',async t=>{
  const id='project-transparency-committee'
  const remote=document.implementation.createHTMLDocument('Other desk')
  const scene=(desks:number)=><CardNameRevealProvider><CardHoverCard kind="project" lod="mini" crowded={false}/>{Array.from({length:desks},(_,i)=>createPortal(<DeskHead nodeId={'other-'+i} left={<b>Other desk</b>} tabs={null}/>,remote.body,'desk-'+i))}</CardNameRevealProvider>
  const view=await mountView(scene(2),e=>e);t.after(()=>view.unmount())
  const card=()=>view.el.querySelector('.sq.project.mini')!
  const inline=()=>card().querySelector('.sq-far-tier .sq-far-scaler')
  await inAct(()=>card().dispatchEvent(new MouseEvent('pointerover',{bubbles:true})))
  assert.equal(remote.querySelectorAll('.cc-head').length,2)
  assert.equal(inline()?.querySelector('.sq-far-name')?.textContent,id,'open desks keep the in-card name for the hover/focus CSS reveal')
  assert.ok(inline()?.querySelector('.project-mark svg'),'the folder precedes the name, as on the floating plate')
  assert.equal(!!view.el.querySelector('.sq-far-ghost'),false,'only the floating name is suppressed')
  assert.equal(card().classList.contains('far-ghosted'),false,'so nothing hides the in-card copy')
  await view.render(scene(1));assert.equal(inline()?.querySelector('.sq-far-name')?.textContent,id,'one remaining desk keeps the in-card name too')
  await view.render(scene(0))
  assert.equal(view.el.querySelector('.sq-far-ghost.on .sq-far-name')?.textContent,id,'closing the last desk brings the floating plate back')
  assert.equal(card().classList.contains('far-ghosted'),true,'which hides the in-card copy while it shows')
  assert.ok(card().querySelector('.project-mini svg'),'the resting folder stays')
  const css=readFileSync(path.join(__SRC_DIR__,'styles.css'),'utf8')
  assert.match(css,/\.sq\.project\.mini:not\(:hover\):not\(:focus-within\):not\(:focus-visible\)\s+\.sq-far-tier\s+\.project-mark\s*\{\s*visibility:\s*hidden;?\s*\}/,'at rest the project is its folder alone')
})
