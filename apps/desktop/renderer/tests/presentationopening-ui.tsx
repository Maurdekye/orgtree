import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { AgentGalleryView, DocGalleryModal } from '../src/canvas/gallery'
import '../src/styles.css'

let allRead=false,counter=0
const records=()=>Array.from({length:150},(_,i)=>{
 const at=new Date(Date.UTC(2026,9,20,6)-i*3600000).toISOString()
 return {id:i===0?'newest':i===99?'oldest':'read-'+i,
 title:i===0?'Newest presentation':i===99?'Oldest unread presentation — selected':'Reviewed presentation '+i,
 at,viewed_at:!allRead&&i===99?null:at,node:'synthetic-presenter',tier:'sol',format:'markdown',node_state:'live',evicted:false}
})
globalThis.fetch=(async (url,options)=>{
 const path=String(url),rows=records(),id=path.match(/\/documents\/([^/?]+)$/)?.[1]
 const q=new URL(path,'http://fixture').searchParams,offset=q.has('opening')&&!allRead?80:Number(q.get('offset')??0),limit=Number(q.get('limit')??40)
 return {ok:true,status:200,headers:new Headers(),json:async()=>id==='viewed'?{ok:true}:id?{...rows.find(r=>r.id===id),body:'# '+rows.find(r=>r.id===id)?.title+'\n\nSynthetic presentation. The oldest unread remains selected, and the newest document is loaded at the top of the list.\n\nOpening the collection never hides its newest end.'}
  :{documents:rows.slice(offset,offset+limit),total:150,next_offset:offset+limit<150?offset+limit:null,offset,...(q.has('opening')?{opening_id:allRead?'newest':'oldest',opening_position:allRead?0:99}:{})}} as Response
}) as typeof fetch
function Fixture(){
 const [mode,setMode]=useState({surface:'modal',key:0})
 ;(window as any).openGallery=(surface:string,read=false)=>{allRead=read;setMode({surface,key:++counter})}
 const props={key:mode.key,slug:'synthetic-opening-'+mode.key,toast:()=>{}}
 return <><style>{`html,body,#root{height:100%;margin:0}body{background:var(--bg);color:var(--text)}.fixture-desk{height:650px;padding:12px;display:flex;flex-direction:column}.fixture-desk>.gallery-agent{height:100%;min-height:0}`}</style>
  {mode.surface==='modal'?<DocGalleryModal {...props} close={()=>{}}/>:<div className="fixture-desk"><AgentGalleryView {...props} nid="synthetic-presenter" node={{id:'synthetic-presenter',kind:mode.surface==='project'?'project':'agent',documents:[]} as any}/></div>}</>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
