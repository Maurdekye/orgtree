import { flush, inAct, mountView } from './harness'
import test from 'node:test'
import assert from 'node:assert/strict'
import { openingWork, readerScope, lastReaderItem, rememberReaderItem, resumedReaderItem } from '../src/canvas/readeropening'
import { openingPresentation, AgentGalleryView } from '../src/canvas/gallery'
import { AgentDocketView } from '../src/canvas/docket'
import { rememberModalOpen, forgetModalOpen } from '../src/canvas/modalpin'

test('opening priorities keep current order, skip ineligible remembered work and leave an empty list empty',()=>{
  const rows=[{slug:'top',status:'open'},{slug:'flag-1',status:'blocked',flag:true},{slug:'flag-2',status:'open',flag:true},{slug:'last',status:'open'}]
  const flag=(row:{flag?:boolean})=>!!row.flag
  assert.equal(openingWork(rows,'last',flag),'flag-1')
  const quiet=rows.map(row=>({...row,flag:false}))
  assert.equal(openingWork(quiet,'last',flag),'last')
  assert.equal(openingWork(quiet.map(row=>row.slug==='last'?{...row,status:'done'}:row),'last',flag),'top')
  assert.equal(openingWork(quiet,'missing',flag),'top')
  assert.equal(openingWork([],null,flag),null)
})
test('presentation opening prefers oldest unread change, then last eligible identity, then current topmost',()=>{
  const rows=[{id:'top',at:'2026-10-23T12:00:00Z',viewed_at:'2026-10-23T12:00:00Z'},
    {id:'changed',at:'2026-10-22T12:00:00Z',viewed_at:'2026-10-21T12:00:00Z'},
    {id:'unread',at:'2026-10-20T12:00:00Z',viewed_at:null}] as any
  assert.equal(openingPresentation('read-priority',rows,'top'),'unread')
  const quiet=rows.map((row:any)=>({...row,viewed_at:row.at}))
  assert.equal(openingPresentation('read-priority',quiet,'changed'),'changed')
  assert.equal(openingPresentation('read-priority',quiet,'dismissed'),'top')
  assert.equal(openingPresentation('read-priority',[{...quiet[1],evicted:true}], 'changed'),null)
})
test('last viewed is persistent and isolated by org, reader kind, node and team',()=>{
  const scope=readerScope('work','memory-a','node')
  rememberReaderItem(scope,'remembered')
  assert.equal(lastReaderItem(scope),'remembered')
  for(const other of [readerScope('work','memory-b','node'),readerScope('presented','memory-a','node'),readerScope('work','memory-a'),readerScope('work','memory-a','node',true)])
    assert.equal(lastReaderItem(other),null)
  rememberReaderItem(scope,'')
  assert.equal(lastReaderItem(scope),'remembered','closing a pane retains last viewed identity')
})
test('continued reader restores a deliberate empty selection separately from its remembered last view',()=>{
  rememberModalOpen('gallery','continued-reader',{selection:''})
  assert.equal(resumedReaderItem('continued-reader','gallery'),'')
  forgetModalOpen('gallery','continued-reader')
  assert.equal(resumedReaderItem('continued-reader','gallery'),undefined)
})
test('continued empty presentation and docket panes do not auto-select an unread/attention target',async t=>{
  const saved=fetch
  const docs=[{id:'unread',node:'node',title:'Unread document',at:'2026-10-23T00:00:00Z',viewed_at:null,evicted:false,node_state:'live'}]
  globalThis.fetch=(async()=>new Response(JSON.stringify({documents:docs}))) as typeof fetch
  const view=await mountView(<AgentGalleryView slug="continued-mount" nid="node" toast={()=>{}} continuedSelection="" />, el=>el)
  t.after(async()=>{await view.unmount();globalThis.fetch=saved})
  await flush(12)
  assert.equal(view.el.querySelectorAll('.doc-gallery-row.on').length,0)
  const item={slug:'flag',title:'Flag',status:'blocked',effective_attention:true,attention_sources:['manual'],manual_attention:{reason:'Check'},
    done_so_far:[],working_on_next:[],participants:[],questions:[],dependencies:[],evidence:[],at:'2026-10-23T00:00:00Z',updated_at:'2026-10-23T00:00:00Z'} as any
  await inAct(()=>view.render(<AgentDocketView slug="continued-mount" nid="node" mine={[item]} facts={new Map()} toast={()=>{}} refs={{world:{org:'continued-mount'},onOpen:()=>{}}} continuedSelection=""/>))
  await flush(8)
  assert.equal(view.el.querySelectorAll('.docket-row.on').length,0)
})
