import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { UserNode } from '../src/canvas/cards'
import { useContextMenu, type MenuEntry } from '../src/canvas/contextmenu'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import { scratchFolderAction } from '../src/scratch-folder'
import type { CanvasNode } from '../src/canvas/shared'
import type { NativeDesktop } from '../src/desktop'
const noop=()=>{}, label=(e:Element)=>e.textContent?.trim().replace(/\s*▸$/,'')
const named=(name:string,root:ParentNode=document)=>[...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(e=>label(e)===name)!
async function key(el:Element,key:string){await inAct(async()=>{el.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));await flush(3)})}
async function click(el:Element){await inAct(async()=>{el.click();await flush(3)})}
function Menu({entries}:{entries:MenuEntry[]}){const menu=useContextMenu();return <div onContextMenu={e=>menu.open(e,entries)}><span>target</span>{menu.node}</div>}
async function setup(t:import('node:test').TestContext){
 const prior=window.orgtreeDesktop,fetch=globalThis.fetch,calls:unknown[][]=[]
 Object.defineProperty(window,'orgtreeDesktop',{configurable:true,writable:true,value:{scratchFolderScopes:['team','shared'],
  openAgentScratchFolder:async(...args:unknown[])=>{calls.push(['folder',...args]);return{ok:true}},
  agentScratchAgentsFileExists:async()=>({ok:true,exists:false}),
  openAgentScratchAgentsFile:async(...args:unknown[])=>{calls.push(['edit',...args]);return{ok:true}},
 } as unknown as NativeDesktop})
 globalThis.fetch=async()=>new Response('{}',{headers:{'content-type':'application/json'}})
 t.after(()=>{window.orgtreeDesktop=prior;globalThis.fetch=fetch});return calls
}
async function context(view:{el:HTMLElement},selector='span'){
 await inAct(async()=>{view.el.querySelector(selector)!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:30,clientY:40}));await flush(5)})
}
for(const focused of [false,true])test(`switchboard Open click and Enter focus while hover/Right expand (${focused})`,async t=>{
 const calls=await setup(t),view=await mountView(<UserNode pos={{x:0,y:0}} isDrop={false} stats={{circ:0,seats:0,free:0}} pip={null}
  seats={{haiku:1}} pxc={1} zoom={1} onSpawn={noop} onMailLink={noop} onWorkLink={noop} focused={focused} eyeW={900}
  posX={()=>0} map={new Map()} op={async()=>({} as never)} slug="fixture" toast={noop} onInbox={noop} onFocus={()=>calls.push(['focus'])}/>,e=>e)
 t.after(()=>view.unmount());const surface=focused?'.eye-head':'.sq.user'
 await context(view,surface);await click(named('Open'));assert.deepEqual(calls,[['focus']]);assert.equal(!!document.querySelector('.ctxmenu'),false)
 await context(view,surface);await key(named('Open'),'Enter');assert.deepEqual(calls,[['focus'],['focus']])
 await context(view,surface);await inAct(async()=>{named('Open').parentElement!.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));await flush(3)})
 assert.ok(named('Inbox'));assert.equal(calls.length,2)
 await key(named('Open'),'ArrowRight');assert.equal(label(document.activeElement!),'Inbox')
})
test('agent scratch and nested team scratch always expose their own Edit action with direct parent opening',async t=>{
 const calls=await setup(t),own=scratchFolderAction('fixture','worker',noop)!,team=scratchFolderAction('fixture','worker',noop,'team')!
 const entries=agentMenuEntries({id:'worker',state:'live',children:[]} as unknown as CanvasNode,{onInbox:noop,onSettings:noop,onScratchFolder:own,onTeamScratchFolder:team})
 const view=await mountView(<Menu entries={entries}/>,e=>e);t.after(()=>view.unmount())
 await context(view);await key(named('Open'),'ArrowRight');await key(named('Scratch folder'),'ArrowRight')
 const branch=document.querySelector('.ctxmenu-submenu[aria-label="Scratch folder"]')!
 assert.deepEqual([...branch.querySelectorAll(':scope > .ctxmenu-branch > [role=menuitem]')].map(label),['Edit AGENTS.md','Team scratch folder'])
 await click(named('Edit AGENTS.md',branch));assert.deepEqual(calls,[['edit','fixture','worker']])
 await context(view);await key(named('Open'),'ArrowRight');await click(named('Scratch folder'));assert.deepEqual(calls.at(-1),['folder','fixture','worker'])
 await context(view);await key(named('Open'),'ArrowRight');await key(named('Scratch folder'),'ArrowRight');await key(named('Team scratch folder'),'ArrowRight')
 const nested=document.querySelector('.ctxmenu-submenu[aria-label="Team scratch folder"]')!
 assert.deepEqual([...nested.querySelectorAll('[role=menuitem]')].map(label),['Edit AGENTS.md'])
 await click(named('Edit AGENTS.md',nested));assert.deepEqual(calls.at(-1),['edit','fixture','worker','team'])
 await context(view);await key(named('Open'),'ArrowRight');await key(named('Scratch folder'),'ArrowRight');await click(named('Team scratch folder'))
 assert.deepEqual(calls.at(-1),['folder','fixture','worker','team'])
})
for(const scope of ['team','shared'] as const)test(`${scope} folder has only Edit AGENTS.md and parent click opens the folder even before a note exists`,async t=>{
 const calls=await setup(t),action=scratchFolderAction('fixture',scope==='shared'?'':'project',noop,scope)!
 const title=scope==='shared'?'Shared scratch folder':'Team scratch folder'
 const entries:MenuEntry[]=scope==='team'?projectMenuEntries({id:'project',kind:'project',state:'live',children:[]} as unknown as CanvasNode,
  {onInbox:noop,onSettings:noop,onScratchFolder:action}):[{label:title,onSelect:action}]
 const view=await mountView(<Menu entries={entries}/>,e=>e);t.after(()=>view.unmount());await context(view)
 if(scope==='team')await key(named('Open'),'ArrowRight')
 assert.ok(named(title),'the scoped folder label is offered');await key(named(title),'ArrowRight')
 const branch=document.querySelector(`.ctxmenu-submenu[aria-label="${title}"]`)!
 assert.ok(branch,'Edit is available when the note is missing')
 assert.deepEqual([...branch.querySelectorAll('[role=menuitem]')].map(label),['Edit AGENTS.md'])
 await click(named('Edit AGENTS.md',branch));assert.deepEqual(calls.at(-1),['edit','fixture',scope==='shared'?'':'project',scope])
 await context(view);if(scope==='team')await key(named('Open'),'ArrowRight');await click(named(title))
 assert.deepEqual(calls.at(-1),['folder','fixture',scope==='shared'?'':'project',scope]);assert.equal(!!document.querySelector('.ctxmenu'),false)
})
