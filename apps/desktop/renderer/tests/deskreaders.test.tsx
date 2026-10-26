import { FakeServer, installFetch, mountView, inAct, flush, settleLive, useFakeClock, realClock, advance } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Agent, Project, lead, documentRow, workRow } from './deskreaders.fixture'
import { deskReaderVisible, useDeskReaderAvailability } from '../src/canvas/deskreaders'
import { forgetDeskMemory, deskMemory } from '../src/canvas/desktabs'
import { resetConvos } from '../src/convo'
import { bumpLive, flushLive } from '../src/livebus'
import type { ReaderAvailability } from '../src/api'
import { RecordFeed } from '../src/recordfeed'
import { OrgRecordContext } from '../src/recordsession'

const bit=(own=false,team=own)=>({own,team})
const empty=():ReaderAvailability=>({work:bit(),presented:bit()})
async function serve(t:TestContext,first=empty()) {
  forgetDeskMemory();localStorage.clear();resetConvos()
  const saved=fetch;installFetch(new FakeServer());const inner=fetch
  let value=first
  const requests:string[]=[]
  globalThis.fetch=(async(url,init)=>{
    const raw=String(url),u=new URL(raw,'http://fixture');requests.push(raw)
    const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}})
    if(u.pathname.endsWith('/reader-availability'))return json(value)
    if(u.pathname.endsWith('/documents'))return json({documents:u.searchParams.has('team')?[documentRow]:[],
      total:u.searchParams.has('team')?1:0,next_offset:null,offset:0,opening_id:u.searchParams.has('team')?documentRow.id:null})
    if(u.pathname.endsWith('/documents/proposal'))return json({...documentRow,body:'# Team proposal\n\nAvailable from a report.'})
    if(u.pathname.endsWith('/work-items-page')) {
      const rows=u.searchParams.has('team') || u.searchParams.get('agent')==='pool'?[workRow]:[]
      return json({format:'orgtree.work-page/v1',group:u.searchParams.get('group'),rows,total:rows.length,
        totals:{items:rows.length,archived:0,backlogged:0},matched:{items:rows.length,archived:0,backlogged:0},
        counts:{active:rows.length,attention:0,archived:0,backlogged:0},revision:'r1',next_offset:null,at:'2026-10-23T12:00:00Z'})
    }
    if(u.pathname.endsWith('/team-ticket'))return json({item:workRow})
    return inner(url,init)
  }) as typeof fetch
  const mounted:Awaited<ReturnType<typeof mountView>>[]=[]
  t.after(async()=>{for(const v of mounted)await v.unmount();globalThis.fetch=saved;resetConvos();forgetDeskMemory();localStorage.clear()})
  const mount=async(element:Parameters<typeof mountView>[0])=>{
    const v=await mountView(element,el=>el);mounted.push(v);await inAct(()=>flush(15));return v
  }
  return {mount,requests,setAvailability:(next:ReaderAvailability)=>{value=next},change:async(next:ReaderAvailability)=>{
    value=next;bumpLive();flushLive();await settleLive();await inAct(()=>flush(15))
  }}
}
const offered=(el:Element,tab:string)=>!!el.querySelector(`.cc-tabs button[data-tab="${tab}"]`)
const pick=async(el:Element,tab:string)=>inAct(async()=>{
  const button=el.querySelector<HTMLButtonElement>(`.cc-tabs button[data-tab="${tab}"]`)
  assert.equal(!!button,true,'tab offered: '+tab);button!.click();await flush(15)
})
const teamCheck=(el:Element)=>el.querySelector<HTMLInputElement>('.gallery-team-check input')?.checked

test('record commits reveal first Presented and Docket tabs on mounted agent and project desks without a live bump',async t=>{
  const s=await serve(t)
  const feed=new RecordFeed({snapshot:async()=>{throw Error('unexpected snapshot')},
    catchup:async()=>{throw Error('unexpected catchup')},project:records=>records,
    publish:()=>{},error:error=>{throw error}})
  t.after(()=>feed.dispose())
  const cursor={org_uuid:'readers-id',incarnation:'one',rev:1}
  feed.receive({type:'record_snapshot',cursor,records:[]})
  const v=await s.mount(<OrgRecordContext.Provider value={{slug:'readers',session:feed}}>
    <section data-reader="agent"><Agent/></section><section data-reader="project"><Project/></section>
  </OrgRecordContext.Provider>)
  const desks=[...v.el.querySelectorAll('[data-reader]')]
  const reads=()=>s.requests.filter(p=>p.includes('/reader-availability')).length
  for(const el of desks){assert.equal(offered(el,'presented'),false);assert.equal(offered(el,'docket'),false)}
  assert.equal(reads(),2)
  s.setAvailability({work:bit(),presented:bit(false,true)})
  await inAct(async()=>{
    feed.receive({type:'record_changes',...cursor,from:1,to:2,
      upserts:[{entity:'org',id:'events_count',body:{events_count:1}}],tombstones:[]})
    await flush(15)
  })
  for(const el of desks){assert.equal(offered(el,'presented'),true,'first presentation reveals its tab before the 15 s poll');assert.equal(offered(el,'docket'),false)}
  assert.equal(reads(),4)
  s.setAvailability({work:bit(true,true),presented:bit(false,true)})
  await inAct(async()=>{
    feed.receive({type:'record_changes',...cursor,from:2,to:3,upserts:[],tombstones:[]})
    await flush(15)
  })
  for(const el of desks){assert.equal(offered(el,'docket'),true,'first docket item reveals its tab');assert.equal(el.querySelector('.cc-tabs button.on')?.getAttribute('data-tab'),el.getAttribute('data-reader')==='agent'?'chat':'desk','arrival keeps the current tab')}
  assert.equal(reads(),6)
  const socket=feed.socketOpened(()=>{})
  await inAct(async()=>{
    feed.receiveSocket({type:'agent_runtime',...cursor,epoch:'host',seq:1,full:true,
      agents:{'7':{epoch:'host',seq:1,busy:true}}},socket)
    await flush(10)
  })
  assert.equal(feed.getSnapshot()?.runtime.get('7')?.busy,true,'runtime control really publishes')
  assert.equal(reads(),6,'runtime-only updates do not refetch availability')
})

test('availability retains its 15 s polling fallback without record events',async t=>{
  const s=await serve(t)
  const Probe=()=>{const rows=useDeskReaderAvailability('readers','lead');return <output>{String(rows?.presented.team===true)}</output>}
  useFakeClock()
  try{
    const v=await s.mount(<Probe/>)
    assert.equal(v.el.textContent,'false')
    s.setAvailability({work:bit(),presented:bit(false,true)})
    await advance(14999)
    assert.equal(v.el.textContent,'false','no event or early polling refresh')
    await advance(1)
    assert.equal(v.el.textContent,'true','fallback still refreshes at 15 seconds')
    await v.unmount()
  }finally{realClock()}
})

test('empty tabs are hidden; an active empty tab is retained only until leaving it',async t=>{
  const s=await serve(t),v=await s.mount(<Agent/>)
  assert.equal(offered(v.el,'docket'),false);assert.equal(offered(v.el,'presented'),false)
  await s.change({work:bit(),presented:bit(false,true)})
  assert.equal(offered(v.el,'presented'),true)
  await pick(v.el,'presented');assert.equal(teamCheck(v.el),true)
  assert.equal(v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent,'Team proposal')
  await s.change(empty());assert.equal(offered(v.el,'presented'),true)
  await pick(v.el,'chat');assert.equal(offered(v.el,'presented'),false)
})

test('manual Team untick survives a fresh desk; own content clears it and the next team-only opening defaults on',async t=>{
  const s=await serve(t,{work:bit(false,true),presented:bit(false,true)})
  const v=await s.mount(<Agent/>);await pick(v.el,'presented')
  await inAct(()=>{v.el.querySelector<HTMLInputElement>('.gallery-team-check input')!.click()})
  assert.equal(teamCheck(v.el),false);assert.equal(deskMemory('readers','lead','presented-team'),'off')
  await pick(v.el,'chat')
  const other=await s.mount(<Agent/>);await pick(other.el,'presented');assert.equal(teamCheck(other.el),false)
  await pick(other.el,'chat');await s.change({work:bit(false,true),presented:bit(true,true)})
  assert.equal(deskMemory('readers','lead','presented-team'),'auto')
  await s.change({work:bit(false,true),presented:bit(false,true)})
  await pick(other.el,'presented');assert.equal(teamCheck(other.el),true)
})

test('team-only Docket opens in the team scope and its request carries scoped opening priority',async t=>{
  const s=await serve(t,{work:bit(false,true),presented:bit()})
  const v=await s.mount(<Agent/>);await pick(v.el,'docket')
  const checks=[...v.el.querySelectorAll<HTMLInputElement>('label input[type="checkbox"]')]
  assert.equal(checks.find(c=>c.parentElement?.textContent?.trim()==='Team')?.checked,true)
  assert.equal(s.requests.some(p=>p.includes('work-items-page')&&p.includes('team=lead')&&p.includes('opening=1')),true)
  assert.equal(v.el.querySelector('.docket-row.on .mfrom')?.textContent,'team-ticket')
})

test('project Presented offers Team and defaults it on; project Docket availability uses its subtree',async t=>{
  const s=await serve(t,{work:bit(false,true),presented:bit(false,true)})
  const v=await s.mount(<Project/>);assert.equal(offered(v.el,'docket'),true)
  await pick(v.el,'presented');assert.equal(teamCheck(v.el),true)
  assert.equal(s.requests.some(p=>p.includes('/documents?')&&p.includes('node=pool')&&p.includes('team=1')&&p.includes('hired=1')&&p.includes('visible=true')),true)
  const retired=[...v.el.querySelectorAll<HTMLInputElement>('label input')].find(c=>c.parentElement?.textContent?.trim()==='Show retired')
  assert.equal(!!retired,true)
  await inAct(()=>{retired!.click()});await flush(10)
  assert.equal(s.requests.some(p=>p.includes('/reader-availability?')&&p.includes('retired=true')),true)
})

test('own content keeps Team off; navigation memory is isolated from another node and org',async t=>{
  const s=await serve(t,{work:bit(true,true),presented:bit(true,true)})
  const v=await s.mount(<Agent/>);await pick(v.el,'presented');assert.equal(teamCheck(v.el),false)
  assert.equal(deskMemory('other','lead','presented-team'),null)
  assert.equal(deskMemory('readers','worker','presented-team'),null)
  assert.equal(deskReaderVisible('presented','chat',undefined),false)
  assert.equal(deskReaderVisible('presented','presented',false),true)
})
