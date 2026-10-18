import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {CurrentOrg} from '../src/popout'
import {ProjectSlotsModal} from '../src/canvas/slotspanel'
import {ProjectDesk} from '../src/canvas/projectdesk'
import {AgentSurfaceRoutesProvider} from '../src/canvas/panelcorner'
import {projectMenuEntries} from '../src/canvas/agentmenu'
import type {CanvasNode} from '../src/canvas/shared'
import type {TreePayload} from '../src/types'
import '../src/styles.css'
import '../src/shell.css'
const noop=()=>{},since=new Date(Date.now()-32_000).toISOString()
const worker={id:'worker',tier:'sol',kind:'agent',state:'live',generation:1,children:[],scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[]}} as unknown as CanvasNode
const base={id:'build-fixture',kind:'project',tier:'project',state:'live',generation:1,children:[worker],scope:{tools:{},add_dirs:[]},configured_scope:{tools:{},add_dirs:[],slots_capacity:1},turns:[],lineage:[],audiences_held:[],seat:0,grant:0,free:0} as unknown as CanvasNode
globalThis.fetch=async()=>new Response(JSON.stringify({messages:[],pending:[],delivered:[],items:[],docs:[],references:{},after:'0:0',has_more:false,total:0}),{status:200,headers:{'Content-Type':'application/json'}})
document.documentElement.dataset.theme='dark'
document.body.style.cssText='margin:0;background:#202020;color:#ddd;font:13px sans-serif'
function Fixture(){
 const[open,setOpen]=useState(false),[count,setCount]=useState(1),node={...base,configured_scope:{...base.configured_scope,slots_capacity:count}}
 const map=new Map([[node.id,node],[worker.id,worker]])
 const tree={slug:'slots-panel-fixture',roots:[node],slot_leases:[{project:node.id,agent:worker.id,lease:'sfixture',slot:9,reason:'focused checks',since,reminders:0}],watchdogs:[]} as unknown as TreePayload
 const op=async()=>({holders:[{agent:worker.id,lease:'sfixture',reason:'focused checks',since}],line:[],history:[]})
 const show=()=>setOpen(true)
 const entries=projectMenuEntries(node,{onInbox:noop,onSettings:noop,onSlots:show})
 const entry=entries.find(e=>e!=='sep'&&e.label==='Open')
 const slots=entry&&entry!=='sep'?entry.children?.find(e=>e!=='sep'&&e.label==='Slots'):undefined
 document.body.dataset.slotMenu=slots?'present':'absent'
 document.body.dataset.slotsOpen=open?'true':'false'
 return <CurrentOrg.Provider value="slots-panel-fixture"><AgentSurfaceRoutesProvider value={{open:show,show}}>
  <div style={{padding:14}}><button id="menu-slots" onClick={()=>{if(slots&&slots!=='sep')slots.onSelect?.()}}>Project menu: Slots</button>
    <button id="disable-slots" onClick={()=>setCount(0)}>Disable slots</button>
    <ProjectDesk node={node} slug="slots-panel-fixture" tree={tree} map={map} op={op} toast={noop}
      refs={{world:{org:'slots-panel-fixture'},onOpen:noop} as never}/></div>
  {open&&<ProjectSlotsModal slug="slots-panel-fixture" nid={node.id} tree={tree} map={map} op={op} toast={noop} close={()=>setOpen(false)}/>} 
 </AgentSurfaceRoutesProvider></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
