import { createRoot } from 'react-dom/client'
import { AgentDocketView } from '../src/canvas/docket'
import { AgentGalleryView } from '../src/canvas/gallery'
import { readerScope, rememberReaderItem } from '../src/canvas/readeropening'
const slug='opening-demo', noop=()=>{}
const work=(id:string,flag=false)=>({slug:id,title:id,objective:flag?'Choose the next step for the release.':'This item remains available in the current collection.',
  kind:'code',rev:1,status:'in_progress',archived:false,owner:{node:'developer',generation:1},owner_current:true,owner_state:'live',
  participants:[],reply_recipients:[{node:'developer',role:'owner',state:'live'}],questions:[],done_so_far:[],working_on_next:[],dependencies:[],evidence:[],history:[],attachments:[],dismissals:[],acceptance:[],
  effective_attention:flag,attention_sources:flag?['manual']:[],manual_attention:flag?{reason:'Choose the next step',set_rev:1,at:'2026-10-23T12:00:00Z',by:{node:'developer',generation:1}}:null,
  at:'2026-10-23T12:00:00Z',updated_at:'2026-10-23T12:00:00Z',docket_at:'2026-10-23T12:00:00Z'} as any)
const items=[work('Recent work'),work('Needs your attention',true),work('Last viewed work')]
const docs=[{id:'recent',title:'Recent overview',at:'2026-10-23T12:00:00Z',viewed_at:'2026-10-23T12:00:00Z'},
  {id:'old-unread',title:'Earlier proposal',at:'2026-10-21T12:00:00Z',viewed_at:null},
  {id:'remembered',title:'Last viewed document',at:'2026-10-22T12:00:00Z',viewed_at:'2026-10-22T12:00:00Z'}].map(row=>({...row,node:'developer',node_state:'live',format:'markdown',evicted:false}))
rememberReaderItem(readerScope('work',slug,'developer'),'Last viewed work')
rememberReaderItem(readerScope('presented',slug,'developer'),'remembered')
globalThis.fetch=(async(url)=>{
  const path=String(url),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
  const item=items.find(row=>path.endsWith('/'+row.slug))
  return new Response(JSON.stringify(path.endsWith('/viewed')?{}:id?{...docs.find(row=>row.id===id),body:'# Earlier proposal\n\nThis unread proposal is the oldest pending presentation. It opens before the last viewed document.\n\nAfter all presentations are read, the next opening remembers your place.'}:item?{item}:{documents:docs}))
}) as typeof fetch
document.body.classList.add('theme-dark')
createRoot(document.getElementById('root')!).render(<main style={{padding:24,display:'grid',gridTemplateColumns:'1fr 1fr',gap:20,height:'100vh',boxSizing:'border-box'}}>
  <section style={{minHeight:0,display:'flex',flexDirection:'column'}}><h2>Work · attention first</h2><div className="docket-modal msgs" style={{flex:1,minHeight:0}}>
    <AgentDocketView slug={slug} nid="developer" mine={items} facts={new Map()} refs={{world:{org:slug},onOpen:noop}} toast={noop}/></div></section>
  <section style={{minHeight:0,display:'flex',flexDirection:'column'}}><h2>Presented · oldest unread first</h2>
    <AgentGalleryView slug={slug} nid="developer" toast={noop} node={{id:'developer',state:'live',tier:'sol'}}/></section>
</main>)
