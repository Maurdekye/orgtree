import {createRoot} from 'react-dom/client'
import {ProjectDesk} from '../src/canvas/projectdesk'
import {CurrentOrg} from '../src/popout'
import {applyTheme} from '../src/themes'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'
applyTheme('orgtree')
const child={id:'builder',title:'builder',tier:'sol',state:'live',children:[],turns:[]} as unknown as CanvasNode
const boss={id:'lead',title:'lead',tier:'opus',state:'live',children:[],turns:[]} as unknown as CanvasNode
const project={id:'website',title:'website',kind:'project',tier:'project',state:'live',parent:'lead',
  charter:'Build the project and report focused test results. This Summary is the standing charter for the project’s agents.\n\nKeep wire compatibility while improving the project interface.',
  configured_scope:{slots_capacity:1},scope:{tools:{},add_dirs:[]},children:[child],lineage:[],turns:[],audiences_held:[],mail_pending:0,
  seat:0,grant:0,free:0} as unknown as CanvasNode
const tree={slug:'org',roots:[project],slot_leases:[{project:'website',agent:'builder',slot:1,lease:'fixture',since:'2026-10-18T17:00:00Z'}],watchdogs:[]} as unknown as TreePayload
window.fetch=async()=>new Response(JSON.stringify({items:[],rows:[],references:[],paging:{next_cursor:null},pending:[],delivered:[],sent:[]}))
createRoot(document.getElementById('root')!).render(<CurrentOrg.Provider value="org"><div style={{position:'fixed',inset:12,display:'flex'}}>
  <ProjectDesk bare node={project} tree={tree} map={new Map([[project.id,project],[boss.id,boss],[child.id,child]])}
    slug="org" refs={{world:{org:'org'},onOpen:()=>{}} as never} op={async()=>({})} toast={()=>{}} onJump={()=>{}}/>
</div></CurrentOrg.Provider>)
