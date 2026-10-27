import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {MentionMenuFixture,mentionMenuEngine} from './appmentionmenu.fixture'

const tick=async()=>{for(let i=0;i<7;i++)await flush()}
const menu=()=>document.querySelector<HTMLElement>('.ctxmenu[role="menu"]')
const labels=()=>[...menu()?.querySelectorAll('[role="menuitem"]')??[]].map(el=>el.textContent?.trim())
async function rightClick(el:HTMLElement){await inAct(async()=>{el.dispatchEvent(new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:70,clientY:90}));await tick()})}
async function choose(label:string){await inAct(async()=>{const b=[...menu()!.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(b=>b.textContent?.trim()===label);assert.ok(Boolean(b),label+' exists');b!.click();await tick()})}
async function clickButton(label:string){await inAct(async()=>{const b=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent?.trim()===label);assert.ok(Boolean(b),label+' exists');b!.click();await tick()})}

for(const markdown of [false,true])for(const kind of ['app','panel'] as const)test(`${markdown?'Markdown':'React'} ${kind} mention Settings and Delete use existing dialogs`,async t=>{
  const engine=mentionMenuEngine();t.after(engine.restore)
  const slug=`mention-menu-${markdown?'md':'react'}-${kind}`,view=await mountView(<MentionMenuFixture slug={slug} markdown={markdown}/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  const chip=()=>view.el.querySelector<HTMLElement>(`.ref-${kind}`)!
  assert.equal(chip().tagName,'BUTTON')
  await rightClick(chip());assert.ok(labels().includes('Settings'));assert.ok(labels().includes('Delete…'))
  await choose('Settings');assert.ok(Boolean(document.querySelector(`[aria-label="${kind==='app'?'App':'Panel'} settings"]`)));assert.equal(engine.deletes().length,0)
  await inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await tick()})
  await rightClick(chip());await choose('Delete…')
  const confirm=document.querySelector('.custom-app-confirm');assert.ok(Boolean(confirm));assert.match(confirm!.textContent??'',kind==='app'?/Delete Recipe book, all its panels/:/Delete Kitchen notes and its saved state/)
  assert.equal(engine.deletes().length,0,'Opening Delete only asks for confirmation')
  await clickButton('Cancel');assert.equal(engine.deletes().length,0,'Cancel never deletes')
  await rightClick(chip());await choose('Delete…');await clickButton(kind==='app'?'Delete app and panels':'Delete panel')
  assert.deepEqual(engine.deletes(),[kind==='app'?{action:'app_delete',app:engine.app.id,expected_rev:5,delete_panels:true}:{action:'panel_delete',panel:engine.panel.id,expected_rev:7}])
})

for(const surface of ['React','Markdown','Apps list'])test(`${surface} app New panel creates one off copy without opening or stopping`,async t=>{
  const engine=mentionMenuEngine();t.after(engine.restore)
  const slug='new-panel-'+surface.toLowerCase().replace(' ','-'),view=await mountView(<MentionMenuFixture slug={slug} markdown={surface==='Markdown'} appsButton={surface==='Apps list'}/>,el=>el);t.after(()=>view.unmount());await inAct(tick)
  if(surface==='Apps list')await inAct(async()=>{view.el.querySelector<HTMLButtonElement>('button[aria-label="Apps"]')!.click();await tick()})
  const target=surface==='Apps list'?document.querySelector<HTMLElement>('.custom-apps-menu-app')!:view.el.querySelector<HTMLElement>('.ref-app')!
  await rightClick(target);assert.ok(labels().includes('New panel'),'New panel exists')
  await choose('New panel')
  assert.deepEqual(engine.calls.filter(c=>['panel_open','panel_start','panel_stop','panel_update'].includes(c.action)),[{action:'panel_open',app:engine.app.id,closed:true}])
  assert.equal(document.querySelectorAll('iframe').length,0,'No app HTML or window starts')
  assert.equal(engine.deletes().length,0)
  if(surface==='Apps list')await inAct(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'Escape'}));await tick()})
})
