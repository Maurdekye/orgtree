import {createPortal} from 'react-dom'
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {inAct,mountView} from './harness'
import {CardHoverCard} from './cardhoverfit-fixture'
import {DeskHead} from '../src/canvas/deskshell'

declare const __SRC_DIR__:string

// USER 2026-10-26 "Never hide on hover" and 2026-10-27 maf032f443c8c "nodes render overtop the hover names":
// hovering a mini node always shows its name on the floating plate above every card, with or without open
// desks (here desk heads in another document, as a popped-out desk's are). The in-card copy stays in the
// card, hidden while the plate shows. This replaces the 4.4.0 desk suppression of the plate (0a47651).
const desks=(remote:Document,count:number)=>Array.from({length:count},(_,i)=>createPortal(<DeskHead nodeId={'other-'+i} left={<b>Other desk</b>} tabs={null}/>,remote.body,'desk-'+i))

test('mini agent names show on the floating plate while desks are open',async t=>{
  const id='agent-with-a-very-long-display-name'
  const remote=document.implementation.createHTMLDocument('Other desk')
  const scene=(count:number)=><><CardHoverCard kind="agent" lod="mini" crowded={false}/>{desks(remote,count)}</>
  const view=await mountView(scene(2),e=>e);t.after(()=>view.unmount())
  const card=()=>view.el.querySelector('.sq.mini')!
  const plate=()=>view.el.querySelector('.sq-far-ghost.on .sq-far-name')?.textContent
  await inAct(()=>card().dispatchEvent(new MouseEvent('pointerover',{bubbles:true})))
  assert.equal(remote.querySelectorAll('.cc-head').length,2)
  assert.equal(plate(),id,'two open desks: hover shows the floating plate')
  assert.equal(card().classList.contains('far-ghosted'),true,'which hides the in-card copy')
  assert.equal(card().querySelector('.sq-far-name')?.textContent,id,'the in-card copy stays in the card')
  await view.render(scene(1));assert.equal(plate(),id,'one open desk: the plate stays')
  await view.render(scene(0));assert.equal(plate(),id,'no desk: the plate, as always')
  assert.ok(card().querySelector('.tier'),'model token stays present')
})

// The ruling covers project nodes too (USER 2026-10-26 on 4.5.0-alpha.3: "hovering projects at mini node
// zoom doesnt show their name"): a mini project's plate and in-card copy are its folder, then its name.
test('mini project names show on the floating plate while desks are open',async t=>{
  const id='project-transparency-committee'
  const remote=document.implementation.createHTMLDocument('Other desk')
  const scene=(count:number)=><><CardHoverCard kind="project" lod="mini" crowded={false}/>{desks(remote,count)}</>
  const view=await mountView(scene(2),e=>e);t.after(()=>view.unmount())
  const card=()=>view.el.querySelector('.sq.project.mini')!
  const plate=()=>view.el.querySelector('.sq-far-ghost.on .sq-far-scaler')
  const inline=()=>card().querySelector('.sq-far-tier .sq-far-scaler')
  await inAct(()=>card().dispatchEvent(new MouseEvent('pointerover',{bubbles:true})))
  assert.equal(remote.querySelectorAll('.cc-head').length,2)
  assert.equal(plate()?.querySelector('.sq-far-name')?.textContent,id,'two open desks: hover shows the floating plate')
  assert.ok(plate()?.querySelector('.project-mark svg'),'the folder precedes the name on the plate')
  assert.equal(card().classList.contains('far-ghosted'),true,'which hides the in-card copy')
  assert.equal(inline()?.querySelector('.sq-far-name')?.textContent,id,'the in-card copy, folder then name, stays in the card')
  assert.ok(inline()?.querySelector('.project-mark svg'))
  await view.render(scene(1));assert.equal(plate()?.querySelector('.sq-far-name')?.textContent,id,'one open desk: the plate stays')
  await view.render(scene(0));assert.equal(plate()?.querySelector('.sq-far-name')?.textContent,id,'no desk: the plate, as always')
  assert.ok(card().querySelector('.project-mini svg'),'the resting folder stays')
  const css=readFileSync(path.join(__SRC_DIR__,'styles.css'),'utf8')
  assert.match(css,/\.sq\.project\.mini:not\(:hover\):not\(:focus-within\):not\(:focus-visible\)\s+\.sq-far-tier\s+\.project-mark\s*\{\s*visibility:\s*hidden;?\s*\}/,'at rest the project is its folder alone')
})
