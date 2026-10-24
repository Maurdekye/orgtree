import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DraftNode, type DraftForm } from '../src/canvas/cards'
import { ProjectDraftNode } from '../src/canvas/newproject'
import { CurrentOrg } from '../src/popout'
import type { TreePayload } from '../src/types'

window.fetch = (async () => new Response(JSON.stringify({ accounts: [], servers: [], charters: [] }),
  { headers: { 'content-type': 'application/json' } })) as typeof fetch
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
const tree = { slug:'draft-close-capture', roots:[], dirs:[], tiers:{ opus:5 },
  default_tools:{ bash:true, edit:true, web:true, subagents:true, mcp:[] },
  default_visibility:'team', permission_mode:'acceptEdits', default_top_grant:12, max_top_grant:100,
} as unknown as TreePayload
function Fixture() {
  const [kind,setKind]=useState('agent')
  const [form,setForm]=useState<DraftForm>({ name:'proposed-agent',charter:'Synthetic task',grant:12,chosen:[],scope:null })
  Object.assign(window,{ setDraftKind:setKind, draftCloseState:()=>form })
  const refuse=()=>{throw new Error('Capture must never create a node')}
  return <CurrentOrg.Provider value={tree.slug}>{kind==='agent'
    ? <DraftNode pos={{x:100,y:100}} draft={{parent:null,tier:'opus'}} map={new Map()} tree={tree}
        seats={tree.tiers!} maxTop={100} defaultTop={12} zoom={1} pxc={1} form={form}
        onFormChange={setForm} onConfirm={refuse} onCancel={()=>{}} />
    : <ProjectDraftNode pos={{x:100,y:100}} onConfirm={refuse} onCancel={()=>{}} />
  }</CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
