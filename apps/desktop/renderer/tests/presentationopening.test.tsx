import { advance, flush, inAct, mountView, realClock, useFakeClock } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'

const noop = () => {}
const row = (id:string,at:string,viewed_at:string|null=null) => ({id,node:'synthetic',title:id,at,viewed_at,node_state:'live',evicted:false,format:'markdown'})
const data = () => [row('newest-read','2026-10-20T12:00:00Z','2026-10-20T12:00:00Z'),
  row('new-unread','2026-10-19T12:00:00Z'),row('old-changed','2026-10-18T12:00:00Z','2026-10-17T12:00:00Z'),
  row('oldest-read','2026-10-16T12:00:00Z','2026-10-16T12:00:00Z')]
const ok = (value:unknown) => ({ok:true,status:200,headers:new Headers(),json:async()=>value}) as Response

test('opening waits for local viewed marks before asking the engine to choose unread',async t=>{
  const saved=fetch,slug='opening-sync-local'
  localStorage.setItem('orgtree-docs-viewed-'+slug,JSON.stringify({'old-changed':'2026-10-18T12:00:00Z'}))
  let release:((r:Response)=>void)|undefined,asked=false
  globalThis.fetch=(async url=>{
    const path=String(url)
    if(path.endsWith('/documents/viewed'))return new Promise<Response>(resolve=>{release=resolve})
    if(path.includes('/documents?')){asked=true;return ok({documents:[],total:0,offset:0,next_offset:null,opening_id:null})}
    return ok({})
  }) as typeof fetch
  const v=await mountView(<DocGalleryModal slug={slug} toast={noop} close={noop}/>,h=>h)
  t.after(async()=>{await v.unmount();globalThis.fetch=saved;localStorage.removeItem('orgtree-docs-viewed-'+slug)})
  await flush();assert.equal(typeof release,'function');assert.equal(asked,false,'read-state write precedes selection query')
  await inAct(()=>release!(ok({ok:true})));await flush();assert.equal(asked,true)
})

for (const surface of ['modal','agent','project'] as const) {
  const panel=(slug:string,explicit=false) => surface==='modal'
    ? <DocGalleryModal slug={slug} toast={noop} close={noop} jumpTo={explicit?{id:'new-unread',seq:1}:undefined}/>
    : <AgentGalleryView slug={slug} nid="synthetic" node={{id:'synthetic',kind:surface==='project'?'project':'agent',documents:[]} as any} toast={noop} initialDocument={explicit?'new-unread':undefined}/>
  test(`${surface}: oldest unread/changed opens once, newest fallback, explicit target, empty and reopen`, async t=>{
    useFakeClock();const saved=fetch,slug='opening-'+surface;let rows=data();let delay:((r:Response)=>void)|undefined,first=true
    globalThis.fetch=(async url=>{
      const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
      if(id==='viewed')return ok({ok:true})
      if(id)return ok({...rows.find(r=>r.id===id),body:'Body '+id})
      if(!path.includes('/documents?'))return ok({})
      if(first){first=false;return new Promise<Response>(resolve=>{delay=resolve})}
      return ok({documents:rows,located:'new-unread'})
    }) as typeof fetch
    const v=await mountView(panel(slug),h=>h);t.after(async()=>{await v.unmount();globalThis.fetch=saved;realClock()})
    await flush();assert.equal(v.el.querySelectorAll('.doc-gallery-row').length,0,'wait for initial response')
    await inAct(()=>delay!(ok({documents:rows})));await flush()
    const selected=()=>v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent
    assert.equal(selected(),'old-changed','oldest unread uses modification time and saved viewed_at')
    assert.equal(v.el.querySelector('.doc-gallery-row.on')?.classList.contains('unread'),false,'automatic read uses existing viewed marker')
    await inAct(()=>([...v.el.querySelectorAll<HTMLElement>('.doc-gallery-row')].find(e=>e.textContent?.includes('newest-read'))!).click());await flush()
    rows=[row('earlier-arrival','2026-10-15T12:00:00Z'),...rows]
    await advance(5001);await flush();assert.equal(selected(),'newest-read','poll and viewed updates preserve manual choice')
    await v.render(null);await v.render(panel(slug));await flush();assert.equal(selected(),'earlier-arrival','fresh open chooses current oldest unread')
    rows=data().map(r=>({...r,viewed_at:r.at}))
    await v.render(null);await v.render(panel(slug));await flush();assert.equal(selected(),'newest-read','all read falls back to most recently modified')
    await v.render(null);await v.render(panel(slug,true));await flush();assert.equal(selected(),'new-unread','explicit document target wins')
    rows=[];await v.render(null);await v.render(panel(slug));await flush();assert.equal(v.el.querySelectorAll('.doc-gallery-row.on').length,0)
    rows=data();await advance(5001);await flush();assert.equal(v.el.querySelectorAll('.doc-gallery-row.on').length,0,'empty opening consumes its decision; arrivals do not steal focus')
  })
  test(`${surface}: oldest unread stays selected while newest page is included on every fresh open`, async t=>{
    useFakeClock();const saved=fetch,slug='remote-opening-'+surface;const rows=Array.from({length:150},(_,i)=>row('doc-'+i,new Date(Date.UTC(2026,9,20,0,0,150-i)).toISOString()))
    let requests:string[]=[]
    globalThis.fetch=(async url=>{
      const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
      if(id==='viewed')return ok({ok:true})
      if(id)return ok({...rows.find(r=>r.id===id),body:'Body '+id})
      if(!path.includes('/documents?'))return ok({})
      requests.push(path)
      const q=new URL(path,'http://fixture').searchParams,offset=q.has('opening')?80:Number(q.get('offset')??0),limit=Number(q.get('limit')??40)
      return ok({documents:rows.slice(offset,offset+limit),total:150,next_offset:offset+limit<150?offset+limit:null,offset,...(q.has('opening')?{opening_id:'doc-99',opening_position:99}:{})})
    }) as typeof fetch
    const v=await mountView(panel(slug),h=>h);t.after(async()=>{await v.unmount();globalThis.fetch=saved;realClock()})
    await flush(15)
    assert.equal(v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent,'doc-99','honor engine target in its page')
    assert.equal(requests[0]?.includes('opening=1'),true,'request engine opening decision')
    assert.equal(v.el.querySelector('.doc-gallery-row .mfrom')?.textContent,'doc-0','newest document is included')
    assert.equal(v.el.querySelector('.doc-list-newer')===null,true,'fresh open never hides newer documents')
    assert.equal(requests.every(p=>Number(new URL(p,'http://fixture').searchParams.get('limit'))<=200),true,'bounded prefix/page reads: '+JSON.stringify(requests))
    assert.ok(requests.length<=3,'target query, newest prefix and optional viewed-state refresh: '+JSON.stringify(requests))
    await inAct(()=>(v.el.querySelector<HTMLElement>('.doc-gallery-row')!).click());await flush()
    await advance(5001);await flush();assert.equal(v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent,'doc-0')
    assert.equal(requests.filter(p=>p.includes('opening=1')).length,1,'target lookup runs once per open')
  })
}

test('distant unread opening is two bounded pages; scrolling/clicking fills the explicit gap without losing selection',async t=>{
  useFakeClock();const saved=fetch,slug='sparse-opening',all=Array.from({length:400},(_,i)=>row('sparse-'+i,new Date(Date.UTC(2026,9,20)-i*60000).toISOString()))
  const requests:{offset:number;limit:number}[]=[]
  all[280]!.node_state='archived' // the first row of the target page is hidden
  globalThis.fetch=(async url=>{
    const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
    if(id==='viewed')return ok({ok:true})
    if(id)return ok({...all.find(r=>r.id===id),body:'Body '+id})
    if(!path.includes('/documents?'))return ok({})
    const q=new URL(path,'http://fixture').searchParams,offset=q.has('opening')?280:Number(q.get('offset')??0),limit=Number(q.get('limit')??40)
    requests.push({offset,limit})
    return ok({documents:all.slice(offset,offset+limit),total:all.length,offset,next_offset:offset+limit<all.length?offset+limit:null,
      ...(q.has('opening')?{opening_id:'sparse-299',opening_position:299}:{})})
  }) as typeof fetch
  const v=await mountView(<DocGalleryModal slug={slug} toast={noop} close={noop}/>,h=>h)
  t.after(async()=>{await v.unmount();globalThis.fetch=saved;realClock()})
  await flush(15)
  assert.equal(v.el.querySelectorAll('.doc-gallery-row').length,79,'two bounded pages; retired boundary row is filtered')
  assert.equal(v.el.querySelector('.doc-gallery-row .mfrom')?.textContent,'sparse-0')
  assert.match(v.el.querySelector('.mailer-read')?.textContent??'',/Body sparse-299/)
  assert.equal(v.el.querySelector('.doc-list-newer')===null,true)
  for(let n=0;n<6;n++){
    const button=v.el.querySelector<HTMLButtonElement>('[data-doc-gap] button');assert.ok(button)
    await inAct(()=>button.click());await flush(15)
    assert.match(v.el.querySelector('.mailer-read')?.textContent??'',/Body sparse-299/,'selection survives gap growth')
  }
  assert.equal(v.el.querySelector('[data-doc-gap]')===null,true,'ranges join once the gap is filled')
  const titles=[...v.el.querySelectorAll('.doc-gallery-row .mfrom')].map(e=>e.textContent)
  assert.deepEqual(titles,all.slice(0,320).filter(r=>r.node_state==='live').map(r=>r.title),'no duplicated or missing documents at the join')
  assert.equal(requests.every(r=>r.limit<=200),true,'every growth and refresh stays bounded')
})
