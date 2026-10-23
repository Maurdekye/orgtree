// Synthetic full-canvas investigation, with no live engine or data.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { OrgCanvas } from '../src/canvas/OrgCanvas'
import { CurrentOrg } from '../src/popout'
import type { TreeNode, TreePayload } from '../src/types'
import { setChartLayout, setStartView } from '../src/canvas/shared'
import '../src/styles.css'
import '../src/shell.css'

const slug = 'scrollbar-fixture'
setChartLayout('circular'); setStartView('user')
window.WebSocket = class { close() {} } as unknown as typeof WebSocket
const node = (id:string):TreeNode => ({id,title:id,state:'live',tier:'sol',model_id:'sol',generation:1,
  children:[],seat:2,grant:2,free:0,ui_order:0,turns:[],lineage:[],audiences_held:[],
  scope:{tools:{},add_dirs:[],permission_mode:'default',org_visibility:'team'},
  occupancy:null,context_window:null,charter:null,mail_pending:0,limit_locked:false,
} as unknown as TreeNode)
const tree = {slug,name:slug,roots:[node('focused'),node('neighbor')],tiers:{sol:2},dirs:[],
  credit_requests:[],audience_requests:[],audiences:[],watchdogs:[],asks:[],asks_open:0,
  max_top_grant:1000,default_top_grant:20,work_items_summary:{active:0,attention:0},
  user_inbox_count:0,org_inbox:null,net:null,cost_usd_total:0} as unknown as TreePayload
const text = 'A synthetic request with an attachment-sized block. '.repeat(4)
const messages = [{role:'user',seq:1,text}, {role:'assistant',seq:2,
  text:Array.from({length:26},(_,i)=>`Synthetic tool observation ${i+1}: measured output is retained for review.`).join('\n\n')},
  {role:'system',seq:3,text:'compacting',compact_state:'running',compact_started_at:new Date().toISOString()}]
window.fetch = async () => new Response(JSON.stringify({messages,live:[],pending_mail:[],busy:true,
  windowed:true,has_older:false,before:null,draft_epoch:'fixture:0',entries:[],providers:[],
  pending:[],delivered:[],sent:[],transfers:[],items:[],documents:[],docs:[],references:{},
  counts:{active:0,attention:0}}),{status:200,headers:{'Content-Type':'application/json'}})
function Fixture() {
  const [focus,setFocus]=useState('focused')
  Object.assign(window,{fixtureFocus:(id:string)=>setFocus(id)})
  return <CurrentOrg.Provider value={slug}><div className="app"><main className="solo">
    <div className="shell-header">Synthetic organization window</div>
    <div className="canvas-stage"><OrgCanvas tree={tree} slug={slug} focusAgent={focus}
      op={async()=>({})} toast={()=>{}} mailEvt={null} renderOrgSlot={()=> <div hidden />}/></div>
    <div className="shell-statusbar">Synthetic status strip</div>
  </main></div></CurrentOrg.Provider>
}
createRoot(document.getElementById('root')!).render(<Fixture/>)
