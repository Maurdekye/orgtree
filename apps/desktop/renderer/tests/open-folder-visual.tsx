import { createRoot } from 'react-dom/client'
import { UserNode } from '../src/canvas/cards'
import { useContextMenu, type MenuEntry } from '../src/canvas/contextmenu'
import { agentMenuEntries, projectMenuEntries } from '../src/canvas/agentmenu'
import { scratchFolderAction } from '../src/scratch-folder'
import type { NativeDesktop } from '../src/desktop'
import type { CanvasNode } from '../src/canvas/shared'
const noop=()=>{},calls:unknown[][]=[]
const record=(...args:unknown[])=>{calls.push(args);document.querySelector('output')!.textContent=JSON.stringify(calls)}
Object.defineProperty(window,'orgtreeDesktop',{value:{scratchFolderScopes:['team','shared'],
 openAgentScratchFolder:async(...args:unknown[])=>{record('folder',...args);return{ok:true}},
 agentScratchAgentsFileExists:async()=>({ok:true,exists:false}),
 openAgentScratchAgentsFile:async(...args:unknown[])=>{record('edit',...args);return{ok:true}},
} as unknown as NativeDesktop})
window.fetch=async()=>new Response('{}',{headers:{'content-type':'application/json'}})
const mode=new URLSearchParams(location.search).get('mode')||'agent'
function Menu({entries}:{entries:MenuEntry[]}){const menu=useContextMenu();return <div id="menu-target" onContextMenu={e=>menu.open(e,entries)}>Synthetic {mode} menu{menu.node}</div>}
const node={id:'synthetic-'+mode,kind:mode==='project'?'project':undefined,state:'live',children:[]} as unknown as CanvasNode
const own=scratchFolderAction('fixture',node.id,noop)!,team=scratchFolderAction('fixture',node.id,noop,'team')!
const handlers={onInbox:noop,onSettings:noop,onScratchFolder:mode==='project'?team:own,onTeamScratchFolder:team,onOpenDesk:noop}
createRoot(document.getElementById('root')!).render(<>
 <h1>Click parent to open · Right / hover for Edit AGENTS.md</h1><output>[]</output>
 {mode==='switchboard'?<UserNode pos={{x:0,y:0}} isDrop={false} stats={{circ:0,seats:0,free:0}} pip={null}
  seats={{haiku:1}} pxc={1} zoom={1} onSpawn={noop} onMailLink={noop} onWorkLink={noop}
  focused={true} eyeW={800} posX={()=>0} map={new Map()} op={async()=>({} as never)} slug="fixture" toast={noop} onInbox={noop} onFocus={()=>record('focus')}/>
  :<Menu entries={mode==='project'?projectMenuEntries(node,handlers):agentMenuEntries(node,handlers)}/>}
</>)
