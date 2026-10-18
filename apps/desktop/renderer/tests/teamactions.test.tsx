import { FakeServer, inAct, installFetch, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { TeamActionsFixture } from './teamactions-fixture'
import { resetConvos } from '../src/convo'
import { forgetSurfaceRequests } from '../src/canvas/modalpin'

for(const isProject of [false,true]) test(`${isProject?'project':'agent'} inline Team has a separate toolbar outside its scrolling tray`,async t=>{
  const oldFetch=globalThis.fetch;installFetch(new FakeServer());resetConvos();localStorage.clear();forgetSurfaceRequests()
  const calls:string[][]=[]
  const view=await mountView(<TeamActionsFixture isProject={isProject} onOpen={(kind,id)=>calls.push([kind,id])}/>,el=>el)
  t.after(async()=>{await view.unmount();resetConvos();globalThis.fetch=oldFetch;localStorage.clear();forgetSurfaceRequests()})
  await inAct(()=>view.el.querySelector<HTMLButtonElement>('[data-tab="team"]')!.click())
  const toolbar=view.el.querySelector<HTMLElement>('[role="toolbar"][aria-label="Team view controls"]')
  assert.equal(!!toolbar,true,'controls own a row, not a floating overlay over the list')
  assert.equal(toolbar!.closest('.tray')===null,true,'toolbar stays outside the list scrollbar')
  assert.equal(toolbar!.querySelectorAll('.panel-corner-btn').length,3,'same shared pin/popout/modal controls')
  assert.equal(!!toolbar!.querySelector('[aria-label="Only active agents"]'),true,'Active has its own reserved header spot')
  assert.equal(toolbar!.contains(view.el.querySelector('.tray-filter')),false,'filter is free to use the tray width')
  await inAct(()=>toolbar!.querySelectorAll<HTMLButtonElement>('.panel-corner-btn')[2].click())
  assert.deepEqual(calls,[['agent-team',isProject?'project-team':'team-lead']])
})
