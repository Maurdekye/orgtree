import {flush,inAct,mountView} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as appsStore from '../src/canvas/apps/store'
import {AppSettings} from '../src/canvas/apps/settings'
import type {CustomApp,PermissionHistoryEntry} from '../src/canvas/apps/types'

// USER 2026-10-27 m838e66af753b, after md2006b10cf40 on History: "ssme for permission
// history, and put tgat on i6s own tab".
const tick=async()=>{for(let i=0;i<6;i++)await flush()}
const t0=Date.UTC(2026,9,27,6,0,0),at=(seq:number)=>new Date(t0+seq*1000).toISOString()
const entry=(seq:number):PermissionHistoryEntry=>seq%10===0?{seq,capability:'net.fetch',site:'api.example.com',permission:'allow',via:'prompt',actor:'user',panel:'p1',at:at(seq)}
  :seq%10===5?{seq,capability:'net.fetch',site:'api.example.com',permission:'default',via:'code',actor:'builder',panel:null,at:at(seq)}
  :{seq,capability:'net.fetch',site:null,permission:seq%2?'deny':'ask',via:'change',actor:'builder',panel:null,at:at(seq)}
const bottom=async(list:HTMLElement)=>{
  Object.defineProperties(list,{scrollHeight:{configurable:true,value:2000},clientHeight:{configurable:true,value:400},scrollTop:{configurable:true,value:1600}})
  await inAct(async()=>{list.dispatchEvent(new window.Event('scroll',{bubbles:true}));await tick()})
}

test('Permission history is its own App settings tab: a live list of expandable rows that loads older entries on scroll',async t=>{
  const app={id:'feed',name:'Feed',description:'',rev:3,permission_rev:9,width:400,height:300,capabilities:['net.fetch','docket.write'],sites:['api.example.com'],permissions:{},site_permissions:{},origin:'created',created_by:'maker',updated_at:''} as CustomApp
  const entries=Array.from({length:70},(_,i)=>entry(i+1)),calls:Record<string,any>[]=[],original=globalThis.fetch
  globalThis.fetch=async(raw,init)=>{const url=new URL(String(raw),'http://local'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input);let out:unknown
    if(input.action==='permission_history'){
      assert.equal(init?.method??'GET','GET','history is a read')
      const n=Number(input.limit??100),from=input.after!==undefined?entries.filter(e=>e.seq>input.after):entries.filter(e=>e.seq<(input.before??Infinity)).reverse(),page=from.slice(0,n)
      out={app:'feed',entries:page,next_cursor:from.length>n?page.at(-1)!.seq:null}
    }else if(input.action==='list')out={items:[],next_cursor:null}
    else throw Error('Unexpected '+input.action)
    return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
  };t.after(()=>{globalThis.fetch=original})
  const slug='permission-history',view=await mountView(<AppSettings slug={slug} app={app} close={()=>{}}/>,e=>e);t.after(()=>view.unmount());await inAct(tick)
  const tabs=[...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  assert.deepEqual(tabs.map(b=>b.textContent?.trim()),['General','Permissions','Permission history'],'Permission history is the last App settings tab')
  await inAct(async()=>{tabs[1]!.click();await tick()})
  const permissions=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  assert.match(permissions.textContent??'',/Internet access/)
  assert.equal(permissions.textContent?.includes('Permission history'),false,'the Permissions tab no longer holds the history')
  const reads=()=>calls.filter(c=>c.action==='permission_history')
  assert.equal(reads().length,0,'opening Permissions reads no history')

  await inAct(async()=>{tabs[2]!.click();await tick()})
  const body=document.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
  assert.match(body.querySelector('p.dim')?.textContent??'',/^Permission changes and prompt answers for this app, newest first\./,'the lead line says what it lists')
  assert.equal([...body.querySelectorAll('button')].some(b=>/refresh/i.test(b.textContent??'')),false,'no Refresh button: the history is live')
  assert.deepEqual(reads(),[{action:'permission_history',app:'feed',limit:50}],'the newest page loads first, and only it')
  const list=body.querySelector<HTMLElement>('ol[aria-label="Permission history"]')!;assert.ok(list,'the history is a list')
  const items=()=>[...list.querySelectorAll<HTMLButtonElement>(':scope > li > button[aria-expanded]')]
  const texts=()=>items().map(b=>b.textContent??'')
  assert.equal(items().length,50,'one compact row per entry, a page at a time')
  assert.match(texts()[0]!,/api\.example\.com: allowed at a prompt.*You/,'what changed, how, and who, newest first')
  assert.match(texts()[1]!,/Internet access: denied.*builder/)
  assert.match(texts()[5]!,/api\.example\.com: Allow cleared by a code change.*builder/)
  assert.equal(items()[0]!.querySelector('time')?.getAttribute('dateTime'),at(70),'each row starts with its time')

  // A row expands to its details, and collapses again.
  const first=items()[0]!
  await inAct(async()=>{first.click();await tick()})
  assert.equal(first.getAttribute('aria-expanded'),'true')
  const details=document.getElementById(first.getAttribute('aria-controls')??'')
  assert.ok(details&&list.contains(details),'the row controls its own details')
  for(const part of [/net\.fetch/,/api\.example\.com/,/prompt/i,/p1/])assert.match(details!.textContent??'',part)
  await inAct(async()=>{first.click();await tick()})
  assert.equal(first.getAttribute('aria-expanded'),'false');assert.equal(document.getElementById(first.getAttribute('aria-controls')??''),null,'clicking again collapses it')

  // Older entries load as the list scrolls down; it ends at the oldest stored entry.
  await bottom(list)
  assert.deepEqual(reads().at(-1),{action:'permission_history',app:'feed',limit:50,before:21})
  assert.equal(items().length,70);assert.equal(list.querySelector('.custom-app-log-more'),null)
  const count=reads().length;await bottom(list);assert.equal(reads().length,count,'nothing more to load')

  // Live: a permission change arrives through the change feed; an app's fire is not a permission change.
  const feed=(appsStore as unknown as Record<string,unknown>).customAppsFeed as ((slug:string,data:unknown)=>boolean)|undefined
  assert.equal(typeof feed,'function','the live change feed reaches the Apps lists')
  entries.push(entry(71))
  await inAct(async()=>{feed!(slug,{type:'custom_apps_changed',org:slug});await tick()})
  assert.deepEqual(reads().at(-1),{action:'permission_history',app:'feed',limit:50,after:70},'a live update reads only entries newer than the newest shown')
  assert.match(texts()[0]!,/Internet access: denied/)
  const live=reads().length
  await inAct(async()=>{feed!(slug,{type:'custom_apps_history',org:slug,panel:'p1'});await tick()})
  assert.equal(reads().length,live,"a panel's History change reads no permission history")
  const seqs=items().map(b=>(Date.parse(b.querySelector('time')?.getAttribute('dateTime')??'')-t0)/1000)
  assert.deepEqual(seqs,Array.from({length:71},(_,i)=>71-i),'every stored entry exactly once, newest first')
})
