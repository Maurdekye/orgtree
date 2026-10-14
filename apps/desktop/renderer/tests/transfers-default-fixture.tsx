// Real mail surfaces, immutable synthetic transfer data and local HTTP only.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { InboxView, OrgInboxModal } from '../src/canvas/mail'
import '../src/styles.css'
import '../src/shell.css'
const W = window as unknown as {proof:{refresh:()=>void;reopen:()=>void;requests:string[];confirmed:number}}
const requests:string[]=[]
W.proof={requests,confirmed:40,refresh:()=>{},reopen:()=>{}}
window.fetch=async(input)=>{
  const url=String(input);requests.push(url)
  const body=url.includes('/transfers')?{transfers:[{id:'fixture-transfer',direction:'download',
    peer:'fixture.peer',message_id:'fixture-message',state:document.body.dataset.completed==='true'?'complete':'downloading',attempt:1,
    files:[{id:'fixture-file',name:'retained.txt',total:100,confirmed:W.proof.confirmed,processed:80}]}],next_cursor:null}
    :url.includes('/org_inbox')?{entries:[],total:0,unread:0}: {pending:[],delivered:[],sent:[]}
  return new Response(JSON.stringify(body),{headers:{'X-Orgtree-Instance':'fixture'}})
}
function Host(){
  const [generation,next]=useState(0)
  W.proof.reopen=()=>next(v=>v+1)
  const surface=document.body.dataset.surface
  return <div className="app"><main className="solo"><div className="settings wide" style={{margin:16}} key={generation}>
    {surface==='org'?<OrgInboxModal slug="fixture" map={new Map()} toast={()=>{}} close={()=>{}}
      inbox={{entries:[],total:0,unread:0,visible:true,holders:[]}}/>
      :<InboxView slug="fixture" nid={surface==='user'?'user':'agent-fixture'}/>}
  </div></main></div>
}
createRoot(document.getElementById('root')!).render(<Host/> )
