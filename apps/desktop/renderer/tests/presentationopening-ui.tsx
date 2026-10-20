import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import '../src/styles.css'

let allRead=false,counter=0
const records=()=>[
 {id:'newest',title:'Newest presentation — already read',at:'2026-10-20T06:00:00Z',viewed_at:'2026-10-20T06:00:00Z'},
 {id:'recent',title:'Recent proposal — unread',at:'2026-10-19T12:00:00Z',viewed_at:null},
 {id:'oldest',title:'Oldest changed presentation — selected on open',at:'2026-10-18T12:00:00Z',viewed_at:'2026-10-17T12:00:00Z'},
 {id:'read',title:'Older notes — already read',at:'2026-10-16T12:00:00Z',viewed_at:'2026-10-16T12:00:00Z'},
].map(r=>({node:'synthetic-presenter',tier:'sol',format:'markdown',node_state:'live',evicted:false,...r,viewed_at:allRead?r.at:r.viewed_at}))
globalThis.fetch=(async (url,options)=>{
 const path=String(url),rows=records(),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
 return {ok:true,status:200,headers:new Headers(),json:async()=>id==='viewed'?{ok:true}:id?{...rows.find(r=>r.id===id),body:'# '+rows.find(r=>r.id===id)?.title+'\n\nSynthetic presentation. This reader opens automatically, using the existing saved unread state.\n\nOther unread presentations remain highlighted until opened.'}
  :{documents:rows,total:allRead?4:84,next_offset:null,offset:allRead?0:80,...(path.includes('opening=1')?{opening_id:allRead?'newest':'oldest',opening_position:allRead?0:82}:{})}} as Response
}) as typeof fetch
function Fixture(){
 const [mode,setMode]=useState({surface:'modal',key:0})
 ;(window as any).openGallery=(surface:string,read=false)=>{allRead=read;setMode({surface,key:++counter})}
 const props={key:mode.key,slug:'synthetic-opening-'+mode.key,toast:()=>{}}
 return <><style>{`html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--text)}.fixture-desk{height:650px;padding:12px;display:flex;flex-direction:column}.fixture-desk>.gallery-agent{height:100%;min-height:0}`}</style>
  {mode.surface==='modal'?<DocGalleryModal {...props} close={()=>{}}/>:<div className="fixture-desk"><AgentGalleryView {...props} nid="synthetic-presenter" node={{id:'synthetic-presenter',kind:mode.surface==='project'?'project':'agent',documents:[]} as any}/></div>}</>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
