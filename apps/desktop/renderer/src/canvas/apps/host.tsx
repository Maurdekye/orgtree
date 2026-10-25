import {useEffect,useMemo,useRef,useState} from 'react'
import {customAppsRequest} from '../../api'
import {useSurfaceDocument} from '../../popout'
import {changeApps} from './store'
import {PANEL_PROTOCOL,panelDocument,panelRequest} from './sdk'
import type {CustomApp,CustomPanel,PanelEvents} from './types'

export function PanelHtml({slug,app,panel,visible=true}:{slug:string;app:CustomApp;panel:CustomPanel;visible?:boolean}){
  const owner=useSurfaceDocument(),frame=useRef<HTMLIFrameElement>(null),replyPort=useRef<MessagePort|null>(null)
  const [definition,setDefinition]=useState<CustomApp|null>(null),[error,setError]=useState(''),[saved,setSaved]=useState(false)
  const channel=useMemo(()=>crypto.randomUUID(),[slug,app.id,app.rev,panel.id,owner])
  const current=useRef<CustomPanel|null>(null),eventSeq=useRef<number|null>(null),epoch=useRef(0),ready=useRef(false)
  // React handlers keep their main-window realm after a portal moves. A reply
  // port supplied by the exact iframe avoids pretending that realm is its
  // new parent window; no HTML engine credential or caller identity travels.
  const post=(value:unknown)=>replyPort.current?.postMessage({protocol:PANEL_PROTOCOL,channel,...value as object})
  useEffect(()=>()=>{replyPort.current?.close();replyPort.current=null},[channel])
  const postRef=useRef(post);postRef.current=post
  const [foreground,setForeground]=useState(!owner.hidden)
  useEffect(()=>{const update=()=>setForeground(!owner.hidden);owner.addEventListener('visibilitychange',update);update();return()=>owner.removeEventListener('visibilitychange',update)},[owner])
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
        const page=await customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,after,limit:200})
        if(!alive||at!==epoch.current)return
        for(const event of page.events){after=Math.max(after,event.seq);if(ready.current&&!['state.changed','panel.changed','panel.opened','panel.duplicated'].includes(event.name))postRef.current({kind:'event',name:event.name,payload:event.payload})}
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
            // Deliberately denied in the state-host slice. The next slice adds
            // server-bound sessions and native per-app permission decisions.
            throw Error('Engine actions are not enabled for this app.')
          }else throw Error('Unknown panel API method.')
          if(active&&at===epoch.current){setError('');postRef.current({id:request.id,result})}
        }catch(e){if(active&&at===epoch.current){setError(String(e));postRef.current({id:request.id,error:e instanceof Error?e.message:String(e)})}}
      })
    }
    win.addEventListener('message',listener)
    return()=>{active=false;win.removeEventListener('message',listener)}
  },[slug,panel.id,channel,owner])
  const source=useMemo(()=>definition?.definition?panelDocument(definition.definition.html,channel):'', [definition,channel])
  return <div className="custom-app-host">
    {error&&<div className="custom-app-error" role="alert">{error}</div>}
    {visible&&foreground&&source?<iframe key={channel} ref={frame} title={`${app.name}: ${panel.label}`} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer"
      onLoad={()=>{ready.current=true;postRef.current({kind:'ready'})}}/>:<div className="custom-app-suspended">{source?'Paused while hidden.':'Loading app…'}</div>}
    <div className="custom-app-status">{panel.linked_agents.length?`Linked: ${panel.linked_agents.join(', ')}`:'No linked agents'}<span>{saved?'Saved':'State saved by Orgtree'}</span></div>
  </div>
}
