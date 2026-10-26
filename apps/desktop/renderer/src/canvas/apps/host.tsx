import {appCapabilities} from './policy'
import {useEffect,useMemo,useRef,useState} from 'react'
import {customAppsRequest} from '../../api'
import {useSurfaceDocument} from '../../popout'
import {changeApps,isRunning,refreshApps} from './store'
import {PANEL_PROTOCOL,panelDocument,panelRequest} from './sdk'
import {AppActionClient,HIDDEN_PROMPT} from './actions'
import {hostPanel} from './runtime'
import {AppPermissionPrompt,type PermissionPrompt} from './permissions'
import {AppFileClient,type FileDecision,type FilePrompt} from './files'
import type {PermissionChoice} from './actions'
import {AppFilePermissionPrompt} from './files-ui'
import type {CustomApp,CustomPanel,PanelEvents} from './types'

/** USER 2026-10-26: a running panel keeps ONE browsing context while hidden,
 * culled, at far zoom or in a hidden owner window ("just closing their visual
 * doesnt stop them from running"). Only power off, a new execution generation
 * (a start or a code change) or a move between documents replaces it. Native
 * consent needs the panel visible: a hidden panel's prompt is refused. */
export function PanelHtml({slug,app,panel,visible=true}:{slug:string;app:CustomApp;panel:CustomPanel;visible?:boolean}){
  const owner=useSurfaceDocument(),frame=useRef<HTMLIFrameElement>(null),replyPort=useRef<MessagePort|null>(null)
  const [definition,setDefinition]=useState<CustomApp|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState(false)
  const [prompt,setPrompt]=useState<PermissionPrompt|null>(null),actions=useRef<AppActionClient|null>(null)
  const [filePrompt,setFilePrompt]=useState<FilePrompt|null>(null),files=useRef<AppFileClient|null>(null)
  const generation=panel.run_generation??0,running=isRunning(panel)
  const channel=useMemo(()=>crypto.randomUUID(),[slug,app.id,app.rev,panel.id,owner,generation])
  const current=useRef<CustomPanel|null>(null),eventSeq=useRef<number|null>(null),epoch=useRef(0),ready=useRef(false)
  // React handlers keep their main-window realm after a portal moves. A reply
  // port supplied by the exact iframe avoids pretending that realm is its
  // new parent window; no HTML engine credential or caller identity travels.
  const post=(value:unknown)=>replyPort.current?.postMessage({protocol:PANEL_PROTOCOL,channel,...value as object})
  useEffect(()=>()=>{replyPort.current?.close();replyPort.current=null},[channel])
  const postRef=useRef(post);postRef.current=post
  // Hiding refuses any open prompt; the runtime and its host session remain.
  const shown=useRef(visible),hiding=useRef(new Set<()=>void>());shown.current=visible
  useEffect(()=>{if(!visible)for(const refuse of [...hiding.current])refuse()},[visible])
  useEffect(()=>{
    const prompted=<T,>(show:(finish:(value:T|null)=>void)=>void,clear:()=>void,signal:AbortSignal)=>new Promise<T|null>((resolve,reject)=>{
      if(!shown.current){reject(Error(HIDDEN_PROMPT));return}
      if(signal.aborted){resolve(null);return}
      let settled=false
      const end=()=>{settled=true;signal.removeEventListener('abort',cancel);hiding.current.delete(refuse);clear()}
      const finish=(value:T|null)=>{if(settled)return;end();resolve(value)}
      const cancel=()=>finish(null)
      const refuse=()=>{if(settled)return;end();reject(Error(HIDDEN_PROMPT))}
      signal.addEventListener('abort',cancel,{once:true});hiding.current.add(refuse);show(finish)
    })
    const client=new AppActionClient(slug,app.id,app.rev,panel.id,(request,signal)=>prompted<PermissionChoice>(finish=>setPrompt({request,finish}),()=>setPrompt(null),signal),generation||undefined)
    actions.current=client
    const fileClient=new AppFileClient(slug,app.id,panel.id,client,(request,session,signal)=>prompted<FileDecision>(finish=>setFilePrompt({request,session,finish}),()=>setFilePrompt(null),signal))
    files.current=fileClient
    return()=>{client.dispose();if(actions.current===client)actions.current=null;if(files.current===fileClient)files.current=null;replyPort.current?.close();replyPort.current=null;ready.current=false}
  },[slug,app.id,app.rev,panel.id,channel,owner,generation])
  // The engine's lease: which copies this window actually runs. A stop or a
  // newer generation elsewhere refreshes the list, which unmounts this host.
  useEffect(()=>running&&generation?hostPanel(slug,panel.id,generation,()=>void refreshApps(slug)):undefined,[slug,panel.id,generation,running])
  useEffect(()=>{let alive=true;setDefinition(null);setError('');current.current=null;eventSeq.current=null;ready.current=false;++epoch.current
    void customAppsRequest<CustomApp>(slug,{action:'app_get',app:app.id}).then(result=>{if(alive){if(result.rev!==app.rev)throw Error('App changed; refresh its panel.');setDefinition(result)}}).catch(e=>{if(alive)setError(String(e))})
    return()=>{alive=false;++epoch.current;ready.current=false}
  },[slug,app.id,app.rev,owner])
  useEffect(()=>{let alive=true;const at=epoch.current
    void customAppsRequest<CustomPanel>(slug,{action:'panel_get',panel:panel.id}).then(async result=>{
      if(!alive||at!==epoch.current)return
      if(current.current && result.rev<current.current.rev)return
      current.current=result
      if(ready.current)postRef.current({kind:'event',name:'state.changed',payload:result.state})
      const latest=result.event_seq??0
      if(eventSeq.current===null){eventSeq.current=latest;return}
      let after=eventSeq.current
      while(after<latest){
        // Messages (the event action, orgtree.emit) reach orgtree.on from their own
        // listing; History rows never do (user 2026-10-26 mcbcd7b3cb6c0).
        const page=await customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,after,limit:200,messages:true})
        if(!alive||at!==epoch.current)return
        for(const event of page.events){after=Math.max(after,event.seq);if(ready.current)postRef.current({kind:'event',name:event.name,payload:event.payload})}
        if(page.next_cursor===null)break
      }
      eventSeq.current=latest
    }).catch(e=>{if(alive)setError(String(e))})
    return()=>{alive=false}
  },[slug,panel.id,panel.rev,panel.event_seq,app.rev,owner])
  useEffect(()=>{
    const win=owner.defaultView;if(!win)return
    let active=true,chain=Promise.resolve(),start=Date.now(),count=0
    const listener=(event:MessageEvent)=>{
      const request=panelRequest(event,frame.current?.contentWindow??null,channel);if(!request)return
      if(Date.now()-start>=1000){start=Date.now();count=0}
      if(++count>30){postRef.current({id:request.id,error:'Too many panel requests; slow down.'});return}
      if(request.method==='host.ready'){const port=event.ports?.[0];if(!port)return;replyPort.current?.close();replyPort.current=port;ready.current=true;postRef.current({kind:'ready'});return}
      const at=epoch.current
      chain=chain.then(async()=>{
        if(!active||at!==epoch.current)return
        try{
          let p=current.current
          if(!p){p=await customAppsRequest<CustomPanel>(slug,{action:'panel_get',panel:panel.id});if(!active||at!==epoch.current)return;current.current=p}
          let result:unknown
          if(request.method==='state.get')result=p.state??{}
          else if(request.method==='state.set'||request.method==='state.patch'){
            const field=request.method==='state.set'?'state':'patch'
            const next=await changeApps<CustomPanel>(slug,{action:request.method==='state.set'?'state_set':'state_patch',panel:panel.id,expected_rev:p.rev,[field]:request.args})
            if(!active||at!==epoch.current)return
            current.current=next;setSaved(true);result=next.state??{};postRef.current({kind:'event',name:'state.changed',payload:result})
          }else if(request.method==='event.emit'){
            const args=request.args as {name?:unknown;payload?:unknown}|null
            if(!args||typeof args.name!=='string')throw Error('Event needs a name and JSON payload.')
            result=await changeApps(slug,{action:'event',panel:panel.id,name:args.name,payload:args.payload??null})
          }else if(request.method==='engine.call'){
            const client=actions.current;if(!client)throw Error('App host closed or hidden.')
            result=await client.call(request.args)
          }else if(request.method==='files.call'){
            const client=files.current;if(!client)throw Error('App host closed or hidden.')
            result=await client.call(request.args)
          }else throw Error('Unknown panel API method.')
          if(active&&at===epoch.current){setError('');postRef.current({id:request.id,result})}
        }catch(e){if(active&&at===epoch.current){setError(String(e));postRef.current({id:request.id,error:e instanceof Error?e.message:String(e)})}}
      })
    }
    win.addEventListener('message',listener)
    return()=>{active=false;win.removeEventListener('message',listener)}
  },[slug,panel.id,channel,owner])
  const source=useMemo(()=>definition?.definition?panelDocument(definition.definition.html,channel,new URL('/api/orgs/'+encodeURIComponent(slug)+'/apps/media',window.location.href).href):'', [definition,channel,slug])
  return <div className="custom-app-host">
    {error&&<div className="custom-app-error" role="alert">{error}</div>}
    {source?<iframe key={channel} ref={frame} title={`${app.name}: ${panel.label}`} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer"
      data-orgtree-runtime={panel.id+':'+generation} onLoad={()=>{ready.current=true;postRef.current({kind:'ready'})}}/>:<div className="custom-app-suspended">Loading app…</div>}
    <div className="custom-app-status"><span>{saved?'Saved':'State saved by Orgtree'}</span></div>
    {prompt&&visible&&<AppPermissionPrompt prompt={prompt} owner={owner}/>}
    {filePrompt&&visible&&<AppFilePermissionPrompt slug={slug} prompt={filePrompt} owner={owner} canSend={appCapabilities(app).includes('mail.send')}/>}
  </div>
}
