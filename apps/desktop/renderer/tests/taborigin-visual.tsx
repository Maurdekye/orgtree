import {useState} from 'react'
import {createRoot} from 'react-dom/client'
import {TeamActionsFixture,map,project,root as agent} from './teamactions-fixture'
import {TeamModal} from '../src/canvas/team'
import {CurrentOrg} from '../src/popout'
import {AgentNavProvider} from '../src/canvas/agentnav'
import {forgetModalPins,forgetModalOpenCache,forgetSurfaceRequests} from '../src/canvas/modalpin'
const org='team-actions-synthetic'
window.fetch=(()=>Promise.resolve(new Response(JSON.stringify({items:[],references:{},revisions:{},next_cursor:null,
 pending:[],delivered:[],sent:[],events:[],busy:false}),{headers:{'content-type':'application/json'}}))) as typeof fetch
;(window as unknown as {orgtreeDesktop:unknown}).orgtreeDesktop={minimizePopout:async()=>{},toggleMaximizePopout:async()=>{},closePopout:async()=>{},
 getPopoutState:async()=>({maximized:false}),onEvent:()=>()=>{}}
function Fixture(){
 const [state,setState]=useState({project:false,modal:false,key:0})
 Object.assign(window,{tabOriginReset(isProject:boolean,modal:boolean){
  localStorage.clear();forgetModalPins();forgetModalOpenCache();forgetSurfaceRequests()
  setState(s=>({project:isProject,modal,key:s.key+1}))
 }})
 return <CurrentOrg.Provider value={org}><AgentNavProvider>
  <div aria-hidden style={{position:'fixed',left:0,top:0,width:2,height:2,zIndex:2147483647,background:'var(--bg)'}}/>
  <div data-pin-org={org} style={{position:'fixed',left:20,top:30,right:20,bottom:20}}>
   <div className="origin-desk-host" style={{position:'absolute',left:60,top:50,width:620,height:500,display:'flex',flexDirection:'column',border:'1px solid var(--line)'}}>
    <TeamActionsFixture key={state.key} isProject={state.project} onShow={()=>setState(s=>({...s,modal:true}))}/>
   </div>
  </div>
  {state.modal&&<TeamModal key={state.key} map={map} nid={state.project?project.id:agent.id} onPick={()=>{}}
   refs={{world:{org},onOpen(){}} as never} close={()=>setState(s=>({...s,modal:false}))}/>}
 </AgentNavProvider></CurrentOrg.Provider>
}
localStorage.clear();forgetModalPins();forgetModalOpenCache();forgetSurfaceRequests()
createRoot(document.getElementById('root')!).render(<Fixture/>)
