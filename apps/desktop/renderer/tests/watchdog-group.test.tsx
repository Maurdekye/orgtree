import test from 'node:test'
import assert from 'node:assert/strict'
import { mountView, inAct, flush } from './harness'
import { WatchdogCanvasCards, WatchdogGroup } from '../src/canvas/watchdoggroup'
import { useWatchdogDetail } from '../src/canvas/watchdogdetail'
import type { Watchdog } from '../src/types'

const dogs=(n:number,owner='worker'):Watchdog[]=>Array.from({length:n},(_,i)=>({
  id:owner+'/watch-'+i,name:'watch-'+i,owner,kind:i%2?'file':'listener_watch',target:'fixture',
  count:2,interval_s:600,once:i%3===0,state:i%4===0?'paused':'armed',at:'2026-10-20T00:00:00Z',fired:0,
}))
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})

test('canvas eight dogs stay separate; a partial preview uses the authoritative count and one group',async t=>{
  const list=dogs(8),opened:string[]=[]
  const show=(n:number)=><WatchdogCanvasCards dogs={list} counts={{worker:{total:n,kept:n,one_shot:3}}} org="demo"
    position={()=>({x:10,y:20})} visible={()=>true} onOpen={id=>opened.push(id)}/>
  const v=await mountView(show(8),el=>el);t.after(()=>v.unmount())
  assert.equal(v.el.querySelectorAll('.wd-chip').length,8)
  await v.render(show(123))
  assert.equal(v.el.querySelectorAll('.wd-chip').length,1)
  assert.match(v.el.querySelector('[data-watchdog-group]')!.textContent??'',/123 watchdogs/)
})

test('expanded inventory replaces pages, reaches the final dog and preserves identity menus',async t=>{
  const list=dogs(123),requests:string[]=[],opened:string[]=[]
  const old=globalThis.fetch
  globalThis.fetch=async input=>{
    const u=new URL(String(input),'http://fixture'),offset=Number(u.searchParams.get('cursor'))
    requests.push(u.search)
    return response({watchdogs:list.slice(offset,offset+50),total:list.length,next_cursor:offset+50<list.length?String(offset+50):null})
  }
  t.after(()=>{globalThis.fetch=old})
  const v=await mountView(<WatchdogGroup owner="worker" org="demo" dogs={list.slice(0,8)} total={123} onOpen={id=>opened.push(id)}/>,el=>el)
  t.after(()=>v.unmount())
  assert.equal(requests.length,0,'closed group does not fetch')
  await inAct(async()=>{v.el.querySelector<HTMLElement>('[data-watchdog-group]')!.click();await flush(6)})
  const dialog=()=>document.querySelector('[role="dialog"][aria-label="worker watchdogs"]')!
  assert.equal(dialog().querySelectorAll('.watchdog-link').length,50)
  const next=()=>[...dialog().querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='next')!
  for(let i=0;i<2;i++)await inAct(async()=>{next().click();await flush(6)})
  assert.equal(dialog().querySelectorAll('.watchdog-link').length,23,'prior pages are not accumulated')
  assert.equal(next().disabled,true)
  const last=dialog().querySelectorAll<HTMLElement>('.watchdog-link')[22]!
  assert.equal(last.dataset.objectId,'worker/watch-122')
  assert.equal(last.dataset.objectOrg,'demo')
  await inAct(async()=>last.click())
  assert.deepEqual(opened,['worker/watch-122'])
  assert.equal(document.querySelector('[aria-label="worker watchdogs"]')===null,true)
  assert.deepEqual(requests.map(q=>new URLSearchParams(q).get('cursor')),['0','50','100'])
})

test('failed page is explicit and retry works; a closed group ignores late data',async t=>{
  const old=globalThis.fetch;let fail=true,requests=0
  globalThis.fetch=async()=>{requests++;return fail?response({error:'fixture unavailable'},503):response({watchdogs:dogs(9),total:9,next_cursor:null})}
  t.after(()=>{globalThis.fetch=old})
  const v=await mountView(<WatchdogGroup owner="worker" org="demo" dogs={dogs(8)} total={9} onOpen={()=>{}}/>,el=>el);t.after(()=>v.unmount())
  await inAct(async()=>{v.el.querySelector<HTMLElement>('button')!.click();await flush(6)})
  assert.ok(!!document.querySelector('[role="alert"]'))
  fail=false
  await inAct(async()=>{document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();await flush(6)})
  assert.equal(document.querySelectorAll('[aria-label="worker watchdogs"] .watchdog-link').length,9)
  assert.equal(requests,2)
})

test('exact detail outside the preview ignores a reply for a previous org',async t=>{
  const old=globalThis.fetch,pending:Array<(r:Response)=>void>=[]
  globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));t.after(()=>{globalThis.fetch=old})
  function Detail({org}:{org:string}){const {dog}=useWatchdogDetail(org,'worker/watch-99',[]);return <span>{dog?.name??'loading'}</span>}
  const v=await mountView(<Detail org="old"/>,el=>el);t.after(()=>v.unmount())
  await v.render(<Detail org="new"/>)
  await inAct(async()=>{pending[0]!(response({watchdogs:[{...dogs(1)[0],id:'worker/watch-99',name:'OLD'}]}));await flush(6)})
  assert.equal(v.el.textContent,'loading')
  await inAct(async()=>{pending[1]!(response({watchdogs:[{...dogs(1)[0],id:'worker/watch-99',name:'NEW'}]}));await flush(6)})
  assert.equal(v.el.textContent,'NEW')
})
