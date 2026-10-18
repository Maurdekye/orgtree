import {flush,inAct,mountView} from './harness'
import test, {type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {useState} from 'react'
import {CurrentOrg} from '../src/popout'
import {DocketRow} from '../src/canvas/docket'
import {WorkRefText,buildMentionIndex} from '../src/canvas/workrefs'
import {ObjectNavHost} from '../src/canvas/objectnavhost'
import {ObjectNavProvider} from '../src/canvas/objectnav'
import {AgentNavProvider,useProvideAgentNav} from '../src/canvas/agentnav'
import {ObjectMenuBoundary} from '../src/canvas/contextmenu'
import {requestCount,resetStaffingOptionsForTests} from '../src/canvas/staffingoptions'
import type {WorkItem} from '../src/types'

const make=(extra:Partial<WorkItem>={}):WorkItem=>({slug:'parity-ticket',title:'Full ticket title, not the slug',
  status:'open',archived:false,owner:{node:'owner',generation:1},at:'2026-10-14T00:00:00Z',
  updated_at:'2026-10-14T00:00:00Z',done_so_far:[],working_on_next:[],questions:[],
  effective_attention:false,attention_sources:[],...extra} as WorkItem)
const top=()=>document.querySelector<HTMLElement>('.ctxmenu:not(.ctxmenu-submenu)')
const entries=(root:Element)=>[...root.children].flatMap(el=>el.getAttribute('role')==='separator'?['sep']:
  el.classList.contains('ctxmenu-branch')?[el.querySelector('[role="menuitem"]')!.textContent!.trim()]:[])
const named=(label:string,root:Element=top()!)=>[...root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  .find(el=>el.closest('[role="menu"]')===root&&el.textContent?.trim()===label)
async function right(el:Element){
  const event=new window.MouseEvent('contextmenu',{bubbles:true,cancelable:true,button:2,clientX:10,clientY:10})
  await inAct(()=>{el.dispatchEvent(event)});await flush()
  assert.equal(event.defaultPrevented,true)
  assert.ok(Boolean(top()),'menu opened')
}
async function choose(label:string,root:Element=top()!){
  const button=named(label,root);assert.ok(Boolean(button),label+' exists')
  await inAct(()=>button!.click());await flush()
}
async function ownerItems(){
  const owner=named('Owner… ▸');assert.ok(Boolean(owner),'owner submenu exists')
  await inAct(()=>{owner!.closest('.ctxmenu-branch')!.dispatchEvent(new window.MouseEvent('mouseover',{bubbles:true}))})
  await flush()
  const submenu=document.querySelector('.ctxmenu-submenu');assert.ok(Boolean(submenu))
  return entries(submenu!)
}
async function fixture(t:TestContext,item:WorkItem,opts:{kids?:number;folded?:boolean;locked?:boolean;selected?:boolean;registry?:boolean;focusDisabled?:boolean;org?:string|null}={}){
  resetStaffingOptionsForTests()
  const original=globalThis.fetch,writes:string[]=[],calls:string[]=[],requests:string[]=[]
  const clipboard=Object.getOwnPropertyDescriptor(window.navigator,'clipboard')
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{writes.push(text)}}})
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);requests.push((init?.method??'GET')+' '+url)
    const body=url.endsWith('/quick-staff')?{mode:'request',configured_mode:'request',owner:item.owner,
      disclosure:'Request staffing',models:[{tier:'haiku',seat:1,efforts:[],accounts:[],default_ok:true}]}
      :url.includes('/work-items/')?{item}:{providers:[]}
    return new Response(JSON.stringify(body),{status:200})
  }) as typeof fetch
  const org=opts.org===null?undefined:opts.org??'org'
  const focus=()=>calls.push('Focus')
  function Registry(){useProvideAgentNav(name=>opts.registry===false?[]:[
    {label:'Focus',disabled:opts.focusDisabled,onSelect:focus},
    {label:'Existing agent action',onSelect:()=>calls.push('agent:'+name)},
  ]);return null}
  function Host(){
    const [selected,select]=useState(opts.selected??false),[folded,fold]=useState(opts.folded??false)
    return <CurrentOrg.Provider value={org??'org'}><AgentNavProvider><ObjectNavProvider><Registry/>
      <ObjectNavHost org={org??'org'} dogs={[]} openDog={()=>{}} openTicket={id=>calls.push('transcript-open:'+id)} toast={()=>{}}/>
      <ObjectMenuBoundary>
        <DocketRow org={org} item={item} selected={selected} ageTick={0} facts={new Map()} toast={()=>{}}
          onClick={id=>{calls.push('row-select:'+id);select(old=>!old)}} onDismiss={()=>calls.push('dismiss')}
          onFocusAgent={()=>calls.push('legacy-flat-owner')} kids={opts.kids??0} folded={folded}
          foldLocked={opts.locked} onFold={()=>{calls.push('fold');fold(old=>!old)}}/>
        <WorkRefText text={item.slug} index={buildMentionIndex([item])} onPick={()=>calls.push('transcript-click')}/>
      </ObjectMenuBoundary>
    </ObjectNavProvider></AgentNavProvider></CurrentOrg.Provider>
  }
  const view=await mountView(<Host/>,el=>el);await flush()
  t.after(async()=>{
    await view.unmount();globalThis.fetch=original;resetStaffingOptionsForTests()
    if(clipboard)Object.defineProperty(window.navigator,'clipboard',clipboard)
    else Reflect.deleteProperty(window.navigator,'clipboard')
    window.getSelection()?.removeAllRanges()
  })
  return {view,calls,writes,requests,row:view.el.querySelector('.docket-row')!,card:view.el.querySelector('[data-object-nav="ticket"]')!}
}

for(const status of ['open','backlogged'] as const)for(const archived of [false,true])for(const flagged of [false,true])for(const owner of [false,true]){
  test(`docket menu matches transcript then keeps extras: ${status} archived=${archived} flag=${flagged} owner=${owner}`,async t=>{
    const item=make({status,archived,owner:owner?{node:'owner',generation:1}:null,
      attention_sources:flagged?['manual']:[],effective_attention:flagged,
      manual_attention:flagged?{reason:'Review this',by:{node:'owner',generation:1},set_rev:1,at:'2026-10-14T00:00:00Z'}:null})
    const f=await fixture(t,item,{kids:2})
    const path='/api/orgs/org/work-items/'+item.slug+'/quick-staff'
    assert.equal(requestCount(path),status==='backlogged'&&!archived?1:0,'warm-up starts from draw before either menu')
    await right(f.card)
    const transcript=entries(top()!)
    assert.deepEqual(transcript,['Open details',...(owner?['Owner… ▸']:[]),'sep','Copy ticket title','Copy slug','Copy reference'])
    const ownerTranscript=owner?await ownerItems():[]
    await right(f.row)
    const extras=['Hide 2 sub-items',...(status==='backlogged'&&!archived?['Staff… ▸']:[])]
    assert.deepEqual(entries(top()!),[...transcript,'sep',...extras])
    if(owner)assert.deepEqual(await ownerItems(),ownerTranscript,'owner children and order identical')
    assert.equal(entries(top()!).filter(label=>label==='Copy ticket title').length,1)
    assert.equal(entries(top()!).includes('Close details'),false)
    assert.equal(entries(top()!).some(label=>label.startsWith('Open owner')),false)
    assert.equal(entries(top()!).some(label=>label.includes('Dismiss')),false)
    assert.deepEqual(f.calls,[],'right-click and submenu inspection never invoke actions')
    assert.equal(f.requests.some(request=>request.startsWith('POST ')&&request.endsWith('/quick-staff')),false,'inspection never staffs')
    assert.equal(requestCount(path),status==='backlogged'&&!archived?1:0,'held menu reuses draw-time staffing preview')
  })
}

test('Open details selects once and never toggles closed; primary click still toggles',async t=>{
  const f=await fixture(t,make())
  await right(f.row);await choose('Open details')
  assert.equal(f.row.classList.contains('on'),true)
  await right(f.row);await choose('Open details')
  assert.equal(f.row.classList.contains('on'),true)
  assert.deepEqual(f.calls,['row-select:parity-ticket'])
  await inAct(()=>{f.row.dispatchEvent(new window.MouseEvent('click',{bubbles:true}))});await flush()
  assert.equal(f.row.classList.contains('on'),false)
})

test('copy entries target full title, slug and reference; fold toggles at the bottom',async t=>{
  const f=await fixture(t,make(),{kids:1,folded:true})
  for(const label of ['Copy ticket title','Copy slug','Copy reference']){await right(f.row);await choose(label)}
  assert.deepEqual(f.writes,['Full ticket title, not the slug','parity-ticket','@item:org/parity-ticket'])
  assert.equal(Boolean(f.row.querySelector('.docket-copied')),true,'slug copy keeps its success bubble')
  assert.deepEqual(f.calls,[])
  await right(f.row);assert.equal(entries(top()!).at(-1),'Show 1 sub-item');await choose('Show 1 sub-item')
  await right(f.row);assert.equal(entries(top()!).at(-1),'Hide 1 sub-item')
  assert.deepEqual(f.calls,['fold'])
})

test('Owner parent and submenu actions use the same agent registry as transcript',async t=>{
  const f=await fixture(t,make())
  await right(f.row);await choose('Owner… ▸');assert.deepEqual(f.calls,['Focus'])
  await right(f.row);assert.deepEqual(await ownerItems(),['Copy mention','sep','Focus','Existing agent action'])
  await choose('Copy mention',document.querySelector('.ctxmenu-submenu')!)
  assert.deepEqual(f.writes,['@owner'])
  await right(f.row);await ownerItems();await choose('Existing agent action',document.querySelector('.ctxmenu-submenu')!)
  assert.deepEqual(f.calls,['Focus','agent:owner'])
  await right(f.card);await choose('Owner… ▸');assert.deepEqual(f.calls,['Focus','agent:owner','Focus'])
})

test('missing Focus keeps Owner submenu accessible and copy-only on both surfaces',async t=>{
  const f=await fixture(t,make(),{registry:false})
  for(const el of [f.card,f.row]){
    await right(el)
    assert.equal(named('Owner… ▸')?.getAttribute('aria-disabled'),'true')
    await choose('Owner… ▸');assert.deepEqual(f.calls,[])
    assert.deepEqual(await ownerItems(),['Copy mention'])
  }
})

test('search-locked folds and ineligible staffing produce no extras separator',async t=>{
  const f=await fixture(t,make({archived:true}),{kids:2,locked:true})
  await right(f.card);const transcript=entries(top()!)
  await right(f.row);assert.deepEqual(entries(top()!),transcript)
  assert.equal(entries(top()!).some(label=>/sub-item|Staff/.test(label)),false)
  assert.equal(f.requests.some(request=>request.includes('/quick-staff')),false)
})

test('unscoped row does not invent a reference or warm staffing',async t=>{
  const f=await fixture(t,make({status:'backlogged'}),{org:null})
  await right(f.row)
  assert.equal(entries(top()!).includes('Copy reference'),false)
  assert.equal(entries(top()!).some(label=>label.startsWith('Staff')),false)
  assert.equal(f.requests.some(request=>request.includes('/quick-staff')),false)
})
