import {createRoot} from 'react-dom/client'
import {DocketModal} from '../src/canvas/docket'
import {bumpLive} from '../src/livebus'
import {applyTheme} from '../src/themes'
import type {TreePayload,WorkItem} from '../src/types'
const item=(slug:string,extra:Partial<WorkItem>={}):WorkItem=>({slug,title:slug,objective:'Details of '+slug,rev:1,
  kind:'code',status:'open',archived:false,owner:null,participants:[],questions:[],done_so_far:[],working_on_next:[],
  dependencies:[],evidence:[],history:[],dismissals:[],acceptance:[],attention_sources:[],effective_attention:false,
  at:'2026-10-13T18:00:00Z',updated_at:'2026-10-13T18:00:00Z',docket_at:'2026-10-13T18:00:00Z',...extra} as WorkItem)
let items=[item('Child',{parent:'Parent'}),item('Parent'),item('Second ticket')],revision=0
Object.assign(window,{docketFixture:{update:()=>{items=[item('Newest ticket'),...items];revision++;bumpLive()}}})
window.fetch=(async(url,init)=>{
  if(init?.method&&init.method!=='GET')throw new Error('Synthetic fixture refuses writes')
  const u=new URL(String(url),location.href)
  const payload=u.pathname.includes('/work-items-page')?{format:'orgtree.work-page/v1',group:'items',rows:items,total:items.length,
    totals:{items:items.length,archived:0,backlogged:0},matched:{items:items.length,archived:0,backlogged:0},
    counts:{active:items.length,attention:0,archived:0,backlogged:0},next_offset:null,revision:String(revision),at:new Date().toISOString()}
    :u.pathname.includes('/work-items/')?{item:items.find(i=>i.slug===decodeURIComponent(u.pathname.split('/').at(-1)!))}:{}
  return new Response(JSON.stringify(payload),{headers:{'Content-Type':'application/json'}})
}) as typeof fetch
applyTheme('orgtree')
const jumpTo=new URL(location.href).searchParams.get('jump')
createRoot(document.getElementById('root')!).render(<DocketModal slug="fixture" jumpTo={jumpTo} close={()=>{}} toast={()=>{}}
  tree={{slug:'fixture',name:'Fixture',roots:[],asks:[],epoch:1,rev:1} as unknown as TreePayload}/>)
