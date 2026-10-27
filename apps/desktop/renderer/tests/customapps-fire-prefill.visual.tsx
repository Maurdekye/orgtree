import {createRoot} from 'react-dom/client'
import {PanelSettings} from '../src/canvas/apps/settings'
import type {CustomApp,CustomPanel} from '../src/canvas/apps/types'
import '../src/styles.css'
import '../src/shell.css'
import '../src/canvas/apps/apps.css'

const app={id:'scoreboard',name:'Scoreboard',rev:1,description:'Practice results',events:[{name:'run.ended',description:'One collision-ended run: {run_id, score, best, duration_ms, ended_at}'}],capabilities:[],permissions:{}} as unknown as CustomApp
const panel={id:'practice',app:'scoreboard',label:'Practice',rev:1,open:false,placement:{mode:'float',x:0,y:0,width:640,height:550}} as CustomPanel
window.fetch=async(raw,init)=>{
  const url=new URL(String(raw),'http://synthetic'),request=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
  let out:unknown
  if(request.action==='events')out={panel:panel.id,events:[{seq:7,name:'event.fired',payload:{event:'run.ended',subscribers:1},body:'{"run_id":"practice-007","score":128,"best":256,"duration_ms":18420,"ended_at":"2026-10-27T16:00:00Z"}',actor:'user',at:'2026-10-27T16:00:00Z'}],next_cursor:null,oldest_retained:null}
  else if(request.action==='list')out={items:request.kind==='apps'?[app]:[panel],next_cursor:null}
  else throw Error('Synthetic fixture refuses action '+request.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
}
createRoot(document.getElementById('root')!).render(<PanelSettings slug="synthetic" app={app} panel={panel} close={()=>{}}/>)
