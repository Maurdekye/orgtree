import {createRoot} from 'react-dom/client'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {customAppsFeed} from '../src/canvas/apps/store'
import '../src/styles.css'

// Only the API boundary is synthetic. No app HTML, engine or live org is used.
const slug='apps-live-capture'
const app=(id:string,name:string,created_at:string)=>({id,name,description:'Synthetic app',rev:1,permission_rev:1,width:320,height:240,capabilities:[],events:[],permissions:{},created_at,updated_at:''})
const panel=(id:string,label:string,created_at:string)=>({id,app:'notes',label,created_at,used_at:created_at,rev:1,open:false,running:false,run_generation:0,placement:{mode:'float',x:0,y:0,width:320,height:240},state:{},event_seq:0})
const apps=[app('notes','Notes','2026-10-27T09:00:00Z'),app('clock','Clock','2026-10-26T09:00:00Z')]
const panels=[panel('notes-two','Panel 2','2026-10-27T09:02:00Z'),panel('notes-one','Panel 1','2026-10-27T09:01:00Z')]
globalThis.fetch=async(raw,init)=>{
  const url=new URL(String(raw),'http://fixture.invalid'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}')
  let out:unknown
  if(input.action==='list')out={items:input.kind==='apps'?apps:panels.filter(p=>input.running===undefined||p.running===input.running),next_cursor:null,new_count:0}
  else if(input.action==='runtime')out={items:[],next_cursor:null}
  else throw Error('Unexpected fixture action '+input.action)
  return new Response(JSON.stringify(out),{headers:{'Content-Type':'application/json'}})
}
;(window as unknown as {appsLiveFixture:{addPanel:()=>void}}).appsLiveFixture={addPanel:()=>{panels.push(panel('notes-three','Arrived live','2026-10-27T09:03:00Z'));customAppsFeed(slug,{type:'custom_apps_changed'})}}
document.body.style.cssText='margin:0;background:var(--bg);color:var(--ink);font:14px system-ui'
createRoot(document.getElementById('root')!).render(<><div style={{position:'absolute',left:520,top:50}}><AppsButton slug={slug}/></div><AppsWorkspace slug={slug}/></>)
