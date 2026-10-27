import {useMemo} from 'react'
import {RefProse,useRefRoutes} from '../src/canvas/reflinks'
import {RefMdBody} from '../src/canvas/refmd'
import {ObjectNavProvider} from '../src/canvas/objectnav'
import {ObjectNavHost} from '../src/canvas/objectnavhost'
import {ObjectMenuBoundary} from '../src/canvas/contextmenu'
import {AppsButton,AppsWorkspace} from '../src/canvas/apps/ui'
import {md} from '../src/canvas/shared'

/** In-memory Apps boundary only: the fixture never contacts an engine or runs app HTML. */
export function mentionMenuEngine(){
  const original=globalThis.fetch,calls:Record<string,any>[]=[]
  const app={id:'recipe-book',name:'Recipe book',description:'Synthetic menu fixture',rev:5,permission_rev:1,width:360,height:280,capabilities:[],events:[],permissions:{},created_by:'fixture',created_at:'2026-10-20T08:00:00Z',updated_at:'',definition:{name:'Recipe book',html:'',initial_state:{}}}
  const panel={id:'kitchen',app:app.id,label:'Kitchen notes',rev:7,open:false,running:false,run_generation:0,state:{},event_seq:0,placement:{mode:'float',x:40,y:40,width:360,height:280},created_at:app.created_at,used_at:app.created_at,updated_at:''}
  let deletedApp=false,deletedPanel=false
  globalThis.fetch=async(raw,init)=>{
    const url=new URL(String(raw),'http://fixture.invalid'),input=init?.method==='POST'?JSON.parse(String(init.body)):JSON.parse(url.searchParams.get('request')??'{}');calls.push(input)
    let result:unknown
    switch(input.action){
      case 'refs':result={apps:(input.apps??[]).filter((id:string)=>id===app.id&&!deletedApp).map((id:string)=>({id,name:app.name,recent:panel.label})),panels:(input.panels??[]).filter((id:string)=>id===panel.id&&!deletedPanel&&!deletedApp).map(()=>({id:panel.id,app:app.id,app_name:app.name,label:panel.label,open:false,running:false}))};break
      case 'list':result={items:input.kind==='apps'?(deletedApp?[]:[app]):(deletedApp||deletedPanel?[]:[panel]),next_cursor:null,new_count:0};break
      case 'app_get':if(input.app!==app.id||deletedApp)throw Error('Missing app');result=app;break
      case 'panel_get':if(input.panel!==panel.id||deletedPanel||deletedApp)throw Error('Missing panel');result=panel;break
      case 'panel_open':
        if(input.app!==app.id||input.closed!==true||input.panel)throw Error('Fixture permits closed/off creation only');
        result={...panel,id:'recipe-book-panel-2',label:'Panel 2',rev:1};break
      case 'app_delete':deletedApp=true;result={deleted:true};break
      case 'panel_delete':deletedPanel=true;result={deleted:true};break
      case 'events':result={events:[],next_cursor:null,oldest_retained:null};break
      case 'runtime':case 'listeners':case 'session_close':result={items:[],next_cursor:null};break
      case 'heartbeat':result={stop:[],sample_epoch:0};break
      default:throw Error('Unexpected fixture action '+input.action)
    }
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}})
  }
  return {app,panel,calls,restore:()=>{globalThis.fetch=original},deletes:()=>calls.filter(c=>c.action==='app_delete'||c.action==='panel_delete')}
}
function Chips({slug,markdown}:{slug:string;markdown:boolean}){
  const agents=useMemo(()=>new Map<string,unknown>(),[]),refs=useRefRoutes(slug,agents,{})
  const text=`@app:${slug}/recipe-book and @panel:${slug}/kitchen`
  return markdown?<RefMdBody className="md" html={md(text)} world={refs.world} onOpen={refs.onOpen}/>:<p><RefProse text={text} world={refs.world} onOpen={refs.onOpen}/></p>
}
const noop=()=>{}
export function MentionMenuFixture({slug,markdown=false,appsButton=false}:{slug:string;markdown?:boolean;appsButton?:boolean}){
  return <ObjectNavProvider><ObjectNavHost org={slug} dogs={[]} openDog={noop} toast={noop}/><ObjectMenuBoundary>
    <section className="mention-menu-fixture"><h2>{markdown?'Markdown mentions':'React mentions'}</h2><Chips slug={slug} markdown={markdown}/>{appsButton&&<AppsButton slug={slug}/>}</section>
  </ObjectMenuBoundary><AppsWorkspace slug={slug}/></ObjectNavProvider>
}
