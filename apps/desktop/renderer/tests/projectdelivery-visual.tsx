import { createRoot } from 'react-dom/client'
import { MailList } from '../src/canvas/mail'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { applyTheme } from '../src/themes'
import type { MailRow } from '../src/canvas/shared'

applyTheme('orgtree')
const rows: MailRow[] = ['hubchat-jumplist-sol','skilltree-opus','taskbar-orgs-sol','message-docs-luna'].map((from,i) => ({
  id:String(i+1),from,kind:i%2?'message':'question',body:'Project mail: please check the requested change.',
  at:`2026-10-18T12:0${4-i}:00Z`,
  ...(i%2?{}:{ev:{v:1,variant:'ordinary.question',actor:{kind:'agent',id:from},object:null,engine_authored:false,body:'Please check this project change.'}}),
  queue:{held_by:'coordinator-opus',held_at:'2026-10-18T12:05:00Z',ack:false},
}))
function Fixture() {
  useProvideAgentNav(id => [{label:`Desk of ${id}`,action:()=>{}}], id => ({title:`Agent ${id}`}))
  return <div className="desk-body" style={{height:480,padding:12}}>
    <div style={{fontSize:12,color:'var(--dim)',paddingBottom:8}}>Project inbox · 350px list</div>
    <div style={{display:'flex',height:430}}><MailList delivered={rows} hasAgent={()=>true} tierOf={()=>'sol'}
      onFocusAgent={id=>{document.body.dataset.focusedAgent=id}} /></div>
  </div>
}
createRoot(document.getElementById('root')!).render(<AgentNavProvider><Fixture /></AgentNavProvider>)
