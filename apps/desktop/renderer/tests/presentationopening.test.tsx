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
  test(`${surface}: server opening target past row40 loads one bounded window and keeps user selection`, async t=>{
    useFakeClock();const saved=fetch,slug='remote-opening-'+surface;const rows=Array.from({length:40},(_,i)=>row('doc-'+(80+i),new Date(Date.UTC(2026,9,20,0,0,120-i)).toISOString()))
    let requests:string[]=[]
    globalThis.fetch=(async url=>{
      const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
      if(id==='viewed')return ok({ok:true})
      if(id)return ok({...rows.find(r=>r.id===id),body:'Body '+id})
      if(!path.includes('/documents?'))return ok({})
      requests.push(path)
      return ok(path.includes('opening=1')?{documents:rows,total:150,next_offset:120,offset:80,opening_id:'doc-99',opening_position:99}
        :{documents:rows,total:150,next_offset:120,offset:80})
    }) as typeof fetch
    const v=await mountView(panel(slug),h=>h);t.after(async()=>{await v.unmount();globalThis.fetch=saved;realClock()})
    await flush(15)
    assert.equal(v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent,'doc-99','honor engine target in its page')
    assert.equal(requests[0]?.includes('opening=1'),true,'request engine opening decision')
    assert.equal(requests.every(p=>Number(new URL(p,'http://fixture').searchParams.get('limit'))===40),true,'no history-wide prefix fetch: '+JSON.stringify(requests))
    assert.ok(requests.length<=2,'one selection request and at most one aligned refresh')
    await inAct(()=>(v.el.querySelector<HTMLElement>('.doc-gallery-row')!).click());await flush()
    await advance(5001);await flush();assert.equal(v.el.querySelector('.doc-gallery-row.on .mfrom')?.textContent,'doc-80')
    assert.equal(requests.filter(p=>p.includes('opening=1')).length,1,'target lookup runs once per open')
  })
}
