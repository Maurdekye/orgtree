import { createRoot } from 'react-dom/client'
import { OrgInboxModal } from '../src/canvas/mail'
import { CurrentOrg } from '../src/popout'
import { AgentNavProvider, useProvideAgentNav } from '../src/canvas/agentnav'
import { setHubchatInstalled } from '../src/canvas/agentmentions'
import { applyTheme } from '../src/themes'
import type { OrgInboxEntry } from '../src/types'
import type { CanvasNode } from '../src/canvas/shared'

applyTheme('orgtree'); setHubchatInstalled(true)
const entry:OrgInboxEntry={id:'out-1',dir:'out',peer:'@net:peer.fixture',by:'coordinator-opus',
  body:'Project update: the requested changes are ready for the next alpha.',at:'2026-10-18T12:00:00Z',state:'read'}
window.fetch=async url=>new Response(JSON.stringify(String(url).endsWith('/org_inbox')
  ?{entries:[entry],total:1,unread:0}:String(url).endsWith('/phone')?{hubchat_pc:true}:{transfers:[]}))
function Fixture(){
  useProvideAgentNav(id=>[{label:`Desk of ${id}`,action:()=>{}}],id=>({title:`Agent ${id}`}))
  return <OrgInboxModal slug="fixture" inbox={{entries:[entry],total:1,unread:0,visible:true,holders:[]}}
    map={new Map([['coordinator-opus',{id:'coordinator-opus',tier:'opus',state:'live'} as CanvasNode]])}
    onFocusAgent={()=>{}} toast={()=>{}} close={()=>{}} jumpTo="out-1" />
}
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="fixture"><AgentNavProvider><Fixture/></AgentNavProvider></CurrentOrg.Provider>)
