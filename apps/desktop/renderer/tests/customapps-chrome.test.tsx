import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {AppPermissionPrompt} from '../src/canvas/apps/permissions'

const tick=async()=>{for(let i=0;i<5;i++)await flush()}
const app={id:'notes',name:'Notes',description:'Saved notes',rev:1,permission_rev:1,width:360,height:280,capabilities:['mail.send'],permissions:{},created_by:'maker',updated_at:'',definition:{name:'Notes',description:'',html:'<p>Notes</p>',initial_state:{note:''},capabilities:['mail.send'],width:360,height:280}}
const panel={id:'one',app:'notes',label:'First notes',rev:1,open:true,state:{note:'saved'},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},used_at:'',updated_at:''}
test('app windows open centered and their gears lead to the panel settings system with every copy action',async t=>{
  const original=globalThis.fetch,p=structuredClone(panel),calls:Record<string,unknown>[]=[]
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
    if(input.action==='list')out={items:input.kind==='apps'?[app]:[p],next_cursor:null,new_count:0}
    else if(input.action==='app_get')out=app
    else if(input.action==='panel_get')out=p
    else if(input.action==='events')out={events:[],next_cursor:null}
    else if(input.action==='panel_update'){Object.assign(p,input);p.rev++;out=p}
    else if(input.action==='session_close')out={}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<><AppsButton slug="chrome"/><AppsWorkspace slug="chrome"/></>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const frame=view.el.querySelector('[data-custom-panel="one"]')!
  assert.ok(frame.closest('.overlay'),'an unpinned float is a centered modal, not a fixed corner window')
  assert.ok(frame.classList.contains('settings'),'frame uses standard settings typography and controls')
  const gear=frame.querySelector<HTMLButtonElement>('button[aria-label="Settings for First notes"]');assert.ok(gear,'gear opens settings directly')
  assert.equal(frame.querySelector('details'),null,'no gear dropdown')
  await inAct(async()=>{gear.click();await tick()})
  const settings=document.querySelector<HTMLElement>('[role="dialog"][aria-label="Panel settings"]')!;assert.ok(settings?.classList.contains('settings'))
  // User 2026-10-26: "removemthe "this panel" title"; the copy's rows sit straight under the tab row.
  assert.equal(settings.querySelectorAll('.set-group-head').length,0,'Panel settings shows no section header')
  for(const name of ['State','Rename','Duplicate','Delete panel'])assert.ok(settings.textContent?.includes(name),'missing settings action '+name)
  // User 2026-10-26: links, Activity and placement left Panel settings.
  for(const name of ['Linked agents','Activity','Float','Pin to screen','Pin to canvas'])assert.equal(settings.textContent?.includes(name),false,'removed settings action '+name)
  const state=[...settings.querySelectorAll<HTMLButtonElement>('button')].find(e=>e.textContent==='State…')!
  await inAct(async()=>{state.click();await tick()});assert.equal(JSON.parse(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Panel JSON state"]')!.value).note,'saved')
  assert.equal(calls.some(c=>c.action==='state_set'||c.action==='permission_set'||c.action==='app_delete'),false,'opening settings is read-only')
})

test('native permission chrome uses the shared settings frame without granting or changing identity',async t=>{
  const choices:unknown[]=[]
  const prompt={request:{name:'Notes',label:'First notes',app:'notes',panel:'one',capability:'mail.send',request:{action:'mail.send',args:{to:'maker',body:'Private'}},challenge:'challenge'},finish:(choice:unknown)=>choices.push(choice)}
  const view=await mountView(<AppPermissionPrompt prompt={prompt as never} owner={document}/>,e=>e);t.after(()=>view.unmount())
  assert.ok(document.querySelector('[aria-label="App permission"].settings'),'permission prompt uses native modal design system')
  assert.ok(document.querySelector('[aria-label="App permission"]')?.closest('.overlay'))
  assert.deepEqual(choices,[],'rendering native chrome never grants execution')
})
