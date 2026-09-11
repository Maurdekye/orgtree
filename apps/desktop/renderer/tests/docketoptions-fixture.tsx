import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DocketModal } from '../src/canvas/docket'
import { pinModal, commitModalRect } from '../src/canvas/modalpin'
import { CurrentOrg } from '../src/popout'
import type { TreePayload, WorkItem } from '../src/types'
import '../src/styles.css'
const tree={slug:'fixture',name:'Fixture',roots:[],asks:[],epoch:1,rev:1} as unknown as TreePayload
const item=(slug:string,status:string,archived=false)=>({slug,title:slug,kind:'code',status,archived,rev:1,owner:null,participants:[],at:'2026-09-05T08:00:00Z',updated_at:'2026-09-06T08:00:00Z',docket_at:'2026-09-06T08:00:00Z',done_so_far:[],working_on_next:[],questions:[],dependencies:[],evidence:[],history:[],dismissals:[],acceptance:[],effective_attention:false,attention_sources:[]} as unknown as WorkItem)
window.fetch=(async(input:RequestInfo|URL,init?:RequestInit)=>{if(init?.method&&init.method!=='GET')throw Error('Blocked fixture write');return new Response(JSON.stringify({items:[item('Active task','in_progress')],archived:[item('Archived task','done',true)],backlogged:[item('Backlogged task','backlogged')]}),{headers:{'Content-Type':'application/json'}})}) as typeof fetch
// ⚠ pins are keyed PER OPEN ORG (modalPinKey), so the probe has to pin under
// the same org the modal renders in — a bare 'docket' pin is a different key
// and PinFrame never sees it.
const ORG='fixture'
function Fixture(){const [open,setOpen]=useState(true);Object.assign(window,{optionsProbe:{pin:()=>pinModal('docket',{x:30,y:30,w:500,h:650},ORG),size:(w:number,h=650)=>commitModalRect('docket',{x:30,y:30,w,h},ORG)}});return <CurrentOrg.Provider value={ORG}>{open?<DocketModal slug={ORG} tree={tree} toast={()=>{}} close={()=>setOpen(false)}/>:<div>Closed docket</div>}</CurrentOrg.Provider>}
createRoot(document.getElementById('root')!).render(<Fixture/> )
