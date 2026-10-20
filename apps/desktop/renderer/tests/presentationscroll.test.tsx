import {advance,flush,inAct,mountView,realClock,useFakeClock} from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import {AgentGalleryView,DocGalleryModal} from '../src/canvas/gallery'

const ok=(value:unknown)=>({ok:true,status:200,headers:new Headers(),json:async()=>value}) as Response
const noop=()=>{}
for(const surface of ['global','agent','project'] as const) for(const distant of [false,true]) {
 test(`${surface}: opening unread row is visible once (${distant?'distant gap':'contiguous'})`,async t=>{
  useFakeClock();const saved=fetch,proto=HTMLElement.prototype,box=proto.getBoundingClientRect,height=Object.getOwnPropertyDescriptor(proto,'clientHeight')
  const target=distant?299:99,slug=`scroll-${surface}-${distant}`
  const rows=Array.from({length:400},(_,i)=>({id:'scroll-'+i,node:'writer',title:'Document '+i,at:new Date(Date.UTC(2026,9,20)-i*60000).toISOString(),viewed_at:i===target?null:new Date(Date.UTC(2026,9,20)-i*60000).toISOString(),node_state:'live',evicted:false,format:'markdown'}))
  const rect=(top:number,height:number)=>({top,bottom:top+height,left:0,right:300,width:300,height,x:0,y:top,toJSON(){}}) as DOMRect
  Object.defineProperty(proto,'clientHeight',{configurable:true,get(){return this.classList.contains('mailer-list')?180:0}})
  proto.getBoundingClientRect=function(){
   if(this.classList.contains('mailer-list'))return rect(100,180)
   if(this.classList.contains('doc-gallery-row')){
    const list=this.closest<HTMLElement>('.mailer-list')!,index=[...list.querySelectorAll('.doc-gallery-row')].indexOf(this)
    return rect(100+index*60-list.scrollTop,60)
   }
   return rect(0,0)
  }
  globalThis.fetch=(async url=>{
   const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
   if(id==='viewed')return ok({ok:true})
   if(id)return ok({...rows.find(r=>r.id===id),body:'Body '+id})
   if(!path.includes('/documents?'))return ok({})
   const q=new URL(path,'http://fixture').searchParams,limit=Number(q.get('limit')??40)
   const offset=q.has('opening')||q.has('locate')?Math.floor(target/40)*40:Number(q.get('offset')??0)
   return ok({documents:rows.slice(offset,offset+limit),offset,total:rows.length,next_offset:offset+limit<rows.length?offset+limit:null,...(q.has('opening')?{opening_id:'scroll-'+target}:{})})
  }) as typeof fetch
  const panel=()=>surface==='global'?<DocGalleryModal slug={slug} toast={noop} close={noop}/>:<AgentGalleryView slug={slug} nid="writer" node={{id:'writer',kind:surface==='project'?'project':'agent',documents:[]} as any} toast={noop}/>
  const v=await mountView(panel(),h=>h)
  t.after(async()=>{await v.unmount();globalThis.fetch=saved;proto.getBoundingClientRect=box;if(height)Object.defineProperty(proto,'clientHeight',height);else delete (proto as any).clientHeight;realClock()})
  await flush(15)
  const list=v.el.querySelector<HTMLElement>('.mailer-list')!,selected=v.el.querySelector<HTMLElement>('.doc-gallery-row.on')!
  assert.match(selected.textContent??'',new RegExp('Document '+target))
  assert.ok(list.scrollTop>0,'opening scrolls down to the unread selection')
  const selectedBox=selected.getBoundingClientRect(),listBox=list.getBoundingClientRect()
  assert.ok(selectedBox.top>=listBox.top&&selectedBox.bottom<=listBox.bottom,'selected row is in the list viewport')
  // The reader marks its selected version read immediately; that must not
  // erase the pending opening scroll or re-arm it on the next poll.
  await inAct(()=>{list.scrollTop=0;list.dispatchEvent(new Event('scroll',{bubbles:true}))})
  await advance(5001);await flush(15)
  assert.equal(list.scrollTop,0,'poll/read-state refresh does not fight later user scrolling')
  await inAct(()=>v.el.querySelector<HTMLElement>('.doc-gallery-row')!.click());await flush()
  assert.equal(list.scrollTop,0,'manual selection does not re-run the opening reveal')
  rows[target]!.viewed_at=null // server still chooses the opening unread target
  localStorage.removeItem('orgtree-docs-viewed-'+slug)
  await v.render(null);await v.render(panel());await flush(15)
  assert.ok(v.el.querySelector<HTMLElement>('.mailer-list')!.scrollTop>0,'fresh open gets a fresh reveal')
 })
}
