import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import '../src/styles.css'
import { AgentWorkstate } from '../src/canvas/desk'
import { UrgentAgentOptions, type UrgentAgentMail } from '../src/canvas/dnd'
import { MailList } from '../src/canvas/mail'
import type { CanvasNode } from '../src/canvas/shared'
const node={id:'focused-agent',tier:'sol',state:'live',busy:true,phase:'thinking',dnd:true,
  last_status:{status:'working',summary:'Finishing the focused change'}} as unknown as CanvasNode
function Fixture(){
  const [urgent,setUrgent]=useState<UrgentAgentMail | undefined>({urgent:true,urgent_reason:'Blocking dependency before this turn ends'})
  return <main style={{padding:24,width:900,color:'var(--text)',background:'var(--bg)',height:600}}>
    <h2>focused-agent</h2>
    <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:20}}><AgentWorkstate node={node}/></div>
    <div style={{border:'1px solid var(--line)',padding:16,marginBottom:24}}>
      <UrgentAgentOptions active value={urgent} onChange={setUrgent}/>
    </div>
    <div style={{height:320}}><MailList outgoing delivered={[
      {id:'held',from:'sender',to:'focused-agent',kind:'message',body:'Please check the next change when your turn ends.',at:'2026-10-18T14:00:00Z',dnd_held:true},
      {id:'read',from:'sender',to:'focused-agent',kind:'message',body:'The agent opened this held message explicitly.',at:'2026-10-18T13:59:00Z',dnd_read:true},
    ]}/></div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture/> )
