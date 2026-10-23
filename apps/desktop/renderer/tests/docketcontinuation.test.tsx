import { advance, FakeServer, installFetch, flush, inAct, mountView, useFakeClock, realClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentDocketModal } from '../src/canvas/agentdocket'
import { DocketModal } from '../src/canvas/docket'
import { rememberModalOpen, forgetModalOpen } from '../src/canvas/modalpin'
import { readerScope, rememberReaderItem } from '../src/canvas/readeropening'
import type { WorkItem, TreePayload } from '../src/types'

const item=(slug:string)=>({slug,title:slug,objective:'Detail '+slug,rev:1,kind:'code',status:'open',archived:false,
  owner:{node:'worker',generation:1},owner_current:true,participants:[],questions:[],done_so_far:[],working_on_next:[],
  dependencies:[],evidence:[],history:[],dismissals:[],acceptance:[],attention_sources:[],effective_attention:false,manual_attention:null,
  at:'2026-10-21T12:00:00Z',updated_at:'2026-10-21T12:00:00Z',docket_at:'2026-10-21T12:00:00Z'} as WorkItem)

for(const surface of ['org','agent','team'] as const) test(`${surface} docket resumes an eligible off-page ticket independently of another reader's last view`,async t=>{
  useFakeClock();localStorage.clear()
  const org='continued-'+surface,pinKind=surface==='org'?'docket':'agent-docket:worker',scope=readerScope('work',org,surface==='org'?'':'worker',surface==='team')
  const front=Array.from({length:100},(_,i)=>item('top-'+String(i).padStart(3,'0'))),target=item('off-page-selected')
  const all=[...front,target],prior=globalThis.fetch
  installFetch(new FakeServer());const fallback=globalThis.fetch,calls:URLSearchParams[]=[]
  let eligible=true
  globalThis.fetch=(async(input,init)=>{
    const url=new URL(String(input),'http://fixture.invalid')
    if(url.pathname.endsWith('/work-items-page')){
      const q=url.searchParams;calls.push(q)
      const offset=Number(q.get('offset')||0),rows=all.slice(offset,offset+100)
      const saved=eligible?all.find(row=>row.slug===q.get('opening_last')):undefined
      return new Response(JSON.stringify({format:'orgtree.work-page/v1',group:'items',rows,opening_rows:saved?[saved]:[],total:101,
        totals:{items:101,archived:0,backlogged:0},matched:{items:101,archived:0,backlogged:0},counts:{active:101,attention:0,archived:0,backlogged:0},
        next_offset:offset===0?100:null,revision:'restore-v1',at:'2026-10-23T12:00:00Z'}))
    }
    if(url.pathname.endsWith('/work-items/'+target.slug))return new Response(JSON.stringify({item:target}))
    return fallback(input,init)
  })as typeof fetch
  rememberReaderItem(scope,front[0].slug);rememberModalOpen(pinKind,org,{selection:target.slug})
  const tree={slug:org,roots:[{id:'worker',title:'worker',state:'live',tier:'sol',children:[],generation:1}],tiers:{sol:1},asks:[],epoch:1,rev:1}as unknown as TreePayload
  const view=await mountView(surface==='org'?<DocketModal slug={org} tree={tree} toast={()=>{}} close={()=>{}}/>
    :<AgentDocketModal slug={org} nid="worker" tree={tree} team={surface==='team'} pinKind={pinKind} refs={{world:{org},onOpen:()=>{}}} toast={()=>{}} close={()=>{}}/>,el=>el)
  t.after(async()=>{await view.unmount();forgetModalOpen(pinKind,org);globalThis.fetch=prior;realClock();localStorage.clear()})
  await inAct(async()=>{await flush(20)})
  assert.equal(calls[0]?.get('opening_last'),target.slug,'request the continued identity, not generic collection memory')
  assert.equal(view.el.querySelector('.docket-desc')?.textContent?.includes(target.objective),true,'the saved ticket detail is restored')
  assert.equal(calls.every(q=>q.get('offset')==='0'),true,'no intervening history pages are fetched')
  if(surface!=='org')assert.equal(calls[0].get(surface==='team'?'team':'agent'),'worker','ordinary scope stays in the request')
  rememberReaderItem(scope,front[1].slug)
  await advance(15001,15001)
  assert.equal(calls.at(-1)?.get('opening_last'),target.slug,'a later poll retains this reader independently too')
  assert.equal(view.el.querySelector('.docket-desc')?.textContent?.includes(target.objective),true)
  eligible=false
  await advance(15001,15001)
  assert.equal(view.el.querySelector('.docket-desc')?.textContent?.includes(target.objective)??false,false,'a source removed from the eligible response is not retained')
})
