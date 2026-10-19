import { createRoot } from 'react-dom/client'
import { DocGalleryModal } from '../src/canvas/gallery'
import '../src/styles.css'

const at='2026-10-19T12:00:00Z'
const rows=[
  {id:'read',title:'Release plan — already read',viewed_at:at},
  {id:'new',title:'Project proposal — never opened',viewed_at:null},
  {id:'updated',title:'Interface mockup — updated since last view',viewed_at:'2026-10-18T12:00:00Z',format:'html'},
  {id:'read2',title:'Implementation notes — already read',viewed_at:at},
].map(r=>({node:'test-agent',tier:'sol',at,format:'markdown',node_state:'live',evicted:false,...r}))
globalThis.fetch=(async url=>{
  const id=String(url).match(/\/documents\/([^/?]+)$/)?.[1]
  return {ok:true,json:async()=>id==='viewed'?{ok:true}:id?{...rows.find(r=>r.id===id),body:'# Synthetic presentation\n\nThis is the selected presentation.'}
    :{documents:rows,total:rows.length,next_offset:null}} as Response
}) as typeof fetch
createRoot(document.getElementById('root')!).render(<DocGalleryModal slug="synthetic-presentation-unread" toast={()=>{}} close={()=>{}} />)
