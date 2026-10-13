import {advance,flush,inAct,mountView,realClock,useFakeClock} from './harness'
import {compatibilityWorkFixture} from './workcompat.fixture'
import test from 'node:test'
import assert from 'node:assert/strict'
import {DocketModal} from '../src/canvas/docket'
import type {TreePayload,WorkItem} from '../src/types'

const item=(slug:string,extra:Partial<WorkItem>={}):WorkItem=>({slug,title:slug,objective:'Detail '+slug,
  rev:1,kind:'code',status:'open',archived:false,owner:null,participants:[],questions:[],
  done_so_far:[],working_on_next:[],dependencies:[],evidence:[],history:[],dismissals:[],acceptance:[],
  attention_sources:[],effective_attention:false,manual_attention:null,
  at:'2026-10-13T18:00:00Z',updated_at:'2026-10-13T18:00:00Z',docket_at:'2026-10-13T18:00:00Z',...extra} as WorkItem)
let sequence=0
const selected=(el:HTMLElement)=>el.querySelector('.docket-row.on .mfrom')?.textContent??null
const names=(el:HTMLElement)=>[...el.querySelectorAll('.docket-row .mfrom')].map(e=>e.textContent)
for(const mode of ['none','status','agent'])test(`opening selects the first displayed active row (${mode})`,async()=>{
  await scenario(async({mount})=>{
    window.localStorage.setItem('orgtree.docket.group',mode)
    const view=await mount([item('child',{parent:'parent'}),item('parent'),item('other')])
    assert.equal(selected(view.el),names(view.el)[0])
    assert.equal(selected(view.el),'parent','rendered parent precedes its earlier-sorted child')
    assert.ok(view.el.querySelector('.mailer-read')?.textContent?.includes('Detail parent'))
  })
})
test('first load waits; explicit ticket jump wins, including an archived target',async()=>{
  await scenario(async({mount})=>{
    const view=await mount([item('first')],{jumpTo:'archived',archived:[item('archived',{archived:true,status:'done'})]})
    assert.equal(selected(view.el),'archived')
    await inAct(async()=>{await advance(5000);await flush(8)})
    assert.equal(selected(view.el),'archived')
  })
})
test('deliberate clear and later list updates never restore default selection',async()=>{
  await scenario(async({mount,served})=>{
    const view=await mount([item('first'),item('second')])
    assert.equal(selected(view.el),'first')
    await inAct(async()=>{(view.el.querySelector('.docket-row.on') as HTMLElement).click();await flush(3)})
    assert.equal(selected(view.el),null)
    served.items=[item('newest'),...served.items]
    await inAct(async()=>{await advance(5000);await flush(8)})
    assert.equal(selected(view.el),null)
  })
})
test('user-selected ticket survives later updates',async()=>{
  await scenario(async({mount,served})=>{
    const view=await mount([item('first'),item('second')])
    const row=[...view.el.querySelectorAll<HTMLElement>('.docket-row')].find(e=>e.querySelector('.mfrom')?.textContent==='second')!
    await inAct(async()=>{row.click();await flush(3)})
    served.items=[item('newest'),...served.items]
    await inAct(async()=>{await advance(5000);await flush(8)})
    assert.equal(selected(view.el),'second')
  })
})
test('an empty opening stays empty when tickets arrive later',async()=>{
  await scenario(async({mount,served})=>{
    const view=await mount([],{archived:[item('old',{archived:true})],backlogged:[item('future',{status:'backlogged'})]})
    assert.equal(selected(view.el),null)
    served.items=[item('later')]
    await inAct(async()=>{await advance(5000);await flush(8)})
    assert.equal(selected(view.el),null)
  })
})
test('changing org while mounted gets the new org first row',async()=>{
  await scenario(async({mount,served,modal})=>{
    const view=await mount([item('old-org')])
    served.items=[item('new-org')]
    await view.render(modal('another-org-'+sequence))
    await inAct(async()=>{await flush(12)})
    assert.equal(selected(view.el),'new-org')
  })
})

async function scenario(body:(ctx:{mount:(items:WorkItem[],opts?:{jumpTo?:string;archived?:WorkItem[];backlogged?:WorkItem[]})=>Promise<Awaited<ReturnType<typeof mountView>>>;
  served:{items:WorkItem[];archived:WorkItem[];backlogged:WorkItem[]};modal:(slug?:string,jumpTo?:string)=>React.ReactElement})=>Promise<void>){
  useFakeClock();window.localStorage.removeItem('orgtree.docket.group');window.localStorage.removeItem('orgtree.docket.sort')
  const slug='docket-open-'+(++sequence),served={items:[] as WorkItem[],archived:[] as WorkItem[],backlogged:[] as WorkItem[]}
  const previous=globalThis.fetch
  const ok=(payload:unknown)=>Promise.resolve({ok:true,status:200,headers:new Headers(),json:async()=>payload} as Response)
  globalThis.fetch=compatibilityWorkFixture(((url:RequestInfo|URL)=>{
    const path=String(url),one=/\/work-items\/([^/?]+)$/.exec(path)
    if(one)return ok({item:[...served.items,...served.archived,...served.backlogged].find(i=>i.slug===one[1])})
    if(path.includes('/work-items'))return ok({...served,counts:{active:served.items.length,archived:served.archived.length,backlogged:served.backlogged.length}})
    return ok({})
  }) as typeof fetch)
  let view:Awaited<ReturnType<typeof mountView>>|undefined
  const modal=(org=slug,jumpTo?:string)=><DocketModal slug={org} jumpTo={jumpTo} close={()=>{}} toast={()=>{}}
    tree={{slug:org,name:org,roots:[],asks:[],epoch:1,rev:1} as unknown as TreePayload}/>
  try{await body({served,modal,mount:async(items,opts={})=>{
    Object.assign(served,{items,archived:opts.archived??[],backlogged:opts.backlogged??[]})
    view=await mountView(modal(slug,opts.jumpTo),el=>el)
    await inAct(async()=>{await flush(12)})
    return view
  }})}finally{await view?.unmount();globalThis.fetch=previous;realClock()}
}
