import './harness'
import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {PanelFireEvent} from '../src/canvas/apps/events'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'
import {customAppsFeed} from '../src/canvas/apps/store'

const app={id:'sample',name:'Sample',events:[{name:'ended'},{name:'saved'},{name:'never'}]} as CustomApp
const panel={id:'one',app:'sample'} as CustomPanel
const row=(seq:number,body:string|null)=>({seq,name:'event.fired',payload:{event:'ended',subscribers:0},body,actor:'user',at:'2026-10-27T12:00:00Z'})
const page=(events:ReturnType<typeof row>[])=>({panel:'one',events,next_cursor:null,oldest_retained:null})
const response=(value:unknown)=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
const tick=async()=>{for(let i=0;i<6;i++)await flush()}
const change=(el:HTMLTextAreaElement|HTMLSelectElement,value:string,event:string)=>{Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')!.set!.call(el,value);el.dispatchEvent(new window.Event(event,{bubbles:true}))}

test('last fire pre-fills untouched data, follows newer fires and choices, and preserves edits including a cleared box',async t=>{
  const original=globalThis.fetch,calls:Record<string,any>[]=[],bodies:Record<string,ReturnType<typeof row>[]>={ended:[row(7,'{"run_id":"r7","score":9}'),row(6,'{"score":1}')],saved:[row(8,'[1,2]')],never:[]}
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);assert.equal(input.action,'events');return response(page(bodies[input.name]??[]))}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelFireEvent slug="prefill" app={app} panel={panel}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const data=view.el.querySelector<HTMLTextAreaElement>('textarea')!,select=view.el.querySelector<HTMLSelectElement>('select')!
  assert.deepEqual(JSON.parse(data.value),{run_id:'r7',score:9},'the newest fire supplies editable JSON')
  assert.ok(data.value.includes('\n'),'the JSON is laid out for editing')
  bodies.ended=[row(9,'{"score":11}')]
  await inAct(async()=>{customAppsFeed('prefill',{type:'custom_apps_history',panel:'one'});await tick()})
  assert.deepEqual(JSON.parse(data.value),{score:11},'a newer fire can update an untouched template')
  await inAct(async()=>{change(select,'saved','change');await tick()});assert.deepEqual(JSON.parse(data.value),[1,2])
  await inAct(async()=>{change(select,'never','change');await tick()});assert.equal(data.value,'','never fired stays empty');assert.match(data.placeholder,/empty sends/)
  await inAct(async()=>{change(select,'ended','change');await tick();change(data,'{"typed":true}','input');await tick();change(select,'saved','change');await tick()})
  assert.equal(data.value,'{"typed":true}','event changes never overwrite typed data')
  await inAct(async()=>{change(data,'','input');await tick();customAppsFeed('prefill',{type:'custom_apps_history',panel:'one'});await tick()})
  assert.equal(data.value,'','a user-cleared box also stays empty')
  assert.ok(calls.every(c=>c.action==='events'),'prefill never fires an event')
})

test('delayed history cannot overwrite typing or a newer event selection; missing latest body stays empty',async t=>{
  const original=globalThis.fetch,waiting=new Map<string,(value:Response)=>void>()
  globalThis.fetch=async(raw)=>{const url=new URL(String(raw),'http://local'),input=JSON.parse(url.searchParams.get('request')??'{}');return new Promise<Response>(resolve=>waiting.set(input.name,resolve))}
  t.after(()=>{globalThis.fetch=original})
  const view=await mountView(<PanelFireEvent slug="prefill-delay" app={app} panel={panel}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const data=view.el.querySelector<HTMLTextAreaElement>('textarea')!,select=view.el.querySelector<HTMLSelectElement>('select')!
  await inAct(async()=>{change(select,'saved','change');await tick();waiting.get('saved')!(response(page([row(8,'{"saved":true}')])));await tick()})
  assert.deepEqual(JSON.parse(data.value),{saved:true})
  await inAct(async()=>{waiting.get('ended')!(response(page([row(7,'{"stale":true}')])));await tick()})
  assert.deepEqual(JSON.parse(data.value),{saved:true},'a previous selection cannot supply this template')
  await inAct(async()=>{change(select,'never','change');await tick();change(data,'my draft','input');await tick();waiting.get('never')!(response(page([row(10,'{"late":true}')])));await tick()})
  assert.equal(data.value,'my draft','a late response cannot overwrite typing')
  view.unmount()
  globalThis.fetch=async()=>response(page([row(11,null),row(7,'{"older":true}')]))
  const missing=await mountView(<PanelFireEvent slug="prefill-missing" app={app} panel={panel}/>,e=>e);t.after(()=>missing.unmount());await inAct(tick)
  assert.equal(missing.el.querySelector<HTMLTextAreaElement>('textarea')!.value,'','never guess from an older body when the latest was not kept')
})
