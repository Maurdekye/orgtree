import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {CSSProperties,PointerEvent as ReactPointerEvent,ReactNode} from 'react'
import {createPortal} from 'react-dom'
import {AppsIcon,CloseIcon,MoreIcon,PinIcon} from '../../icons'
import {MovableSurface,PopoutButton,useSurface,useSurfaceDocument} from '../../popout'
import {windowExitStarted} from '../../windowlayout'
import {customAppsRequest} from '../../api'
import {activateApps,changeApps,loadAppsMenu,markAppsSeen,useApps} from './store'
import {PanelHtml} from './host'
import {AppPermissions} from './permissions'
import {APP_BUNDLE_MAX,AppExport,AppImport,parseAppBundle,saveAppJson} from './portable'
import type {AppBundle} from './portable'
import type {AppPlacement,CustomApp,CustomPanel,PanelEvents} from './types'
import type {WorldRect} from '../viewport'
import {intersectsViewport} from '../viewport'
import './apps.css'

type Point={x:number;y:number}
type Menu={slug:string;anchor:HTMLElement}|null
let menu:Menu=null
const menuSubs=new Set<()=>void>(),anchorSubs=new Set<()=>void>()
const anchors=new Map<string,{element:HTMLElement;zoom:number}>(),canvas=new Map<string,{center:(w:number,h:number)=>Point;focus:(p:Point)=>void}>(),returns=new Map<string,AppPlacement>()
const key=(slug:string,id:string)=>slug+'\0'+id
function setMenu(value:Menu){menu=value;for(const fn of menuSubs)fn()}
function useMenu(){return useSyncExternalStore(fn=>{menuSubs.add(fn);return()=>menuSubs.delete(fn)},()=>menu)}
function putAnchor(slug:string,id:string,element:HTMLElement|null,zoom:number){const k=key(slug,id),old=anchors.get(k);if(old?.element===element&&old?.zoom===zoom)return;if(element)anchors.set(k,{element,zoom});else anchors.delete(k);for(const fn of anchorSubs)fn()}
function useAnchor(slug:string,id:string){return useSyncExternalStore(fn=>{anchorSubs.add(fn);return()=>anchorSubs.delete(fn)},()=>anchors.get(key(slug,id)))}
export function AppsButton({slug}:{slug:string}){
  const current=useMenu(),{newCount}=useApps(slug)
  return <button type="button" className={'iconbtn shell-action apps-button'+(newCount?' glow':'')} aria-label="Apps" title={newCount?`Apps · ${newCount} new`:'Apps'} aria-description={newCount?`${newCount} new apps`:undefined} aria-expanded={current?.slug===slug}
    onClick={e=>setMenu(current?.slug===slug?null:{slug,anchor:e.currentTarget})}><AppsIcon fontSize="inherit"/>{newCount>0&&<b className="eye-count asks">{newCount}</b>}</button>
}

const saveJson=saveAppJson
function Dialog({title,close,children}:{title:string;close:()=>void;children:ReactNode}){
  return <div className="custom-app-dialog" role="dialog" aria-label={title} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){e.preventDefault();close()}}}>
    <header><strong>{title}</strong><button type="button" className="iconbtn" aria-label="Close dialog" onClick={close}><CloseIcon/></button></header>{children}</div>
}

function AppsMenu({slug,current,manage,importApp,onShowCanvas}:{slug:string;current:NonNullable<Menu>;manage:(app:CustomApp)=>void;importApp:(bundle:AppBundle,owner:Document)=>void;onShowCanvas:()=>void}){
  const data=useApps(slug),ref=useRef<HTMLDivElement>(null),owner=current.anchor.ownerDocument
  const [style,setStyle]=useState<CSSProperties>({visibility:'hidden'})
  const [seenHere,setSeenHere]=useState<Set<string>>(()=>new Set()),pending=useRef(new Set<string>())
  useLayoutEffect(()=>{const win=owner.defaultView;if(!win||!ref.current)return;const a=current.anchor.getBoundingClientRect(),r=ref.current.getBoundingClientRect(),width=Math.min(390,win.innerWidth-16)
    setStyle({width,left:Math.max(8,Math.min(a.right-width,win.innerWidth-width-8)),top:Math.max(8,Math.min(a.bottom+6,win.innerHeight-r.height-8))})
  },[owner,current.anchor,data.apps.length,data.panels.length])
  useEffect(()=>{void loadAppsMenu(slug);const pointer=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node)&&!current.anchor.contains(e.target as Node))setMenu(null)},keyboard=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMenu(null)}}
    owner.addEventListener('pointerdown',pointer,true);owner.addEventListener('keydown',keyboard,true);return()=>{owner.removeEventListener('pointerdown',pointer,true);owner.removeEventListener('keydown',keyboard,true)}
  },[slug,owner,current.anchor])
  useEffect(()=>{
    if(!ref.current||style.visibility==='hidden'||!owner.defaultView?.IntersectionObserver)return
    // Only catalog entries actually visible in the owning menu are seen.
    // Retain their New labels for this visit, then omit them on the next open.
    const observer=new owner.defaultView.IntersectionObserver(entries=>{
      const ids=entries.filter(e=>e.isIntersecting&&e.intersectionRatio>0).map(e=>e.target.getAttribute('data-new-app')!).filter(id=>id&&!pending.current.has(id)).slice(0,200)
      if(!ids.length)return;ids.forEach(id=>pending.current.add(id));setSeenHere(old=>new Set([...old,...ids]))
      void markAppsSeen(slug,ids).catch(()=>{ids.forEach(id=>pending.current.delete(id))})
    },{root:ref.current,threshold:0})
    ref.current.querySelectorAll('[data-new-app]').forEach(e=>observer.observe(e));return()=>observer.disconnect()
  },[slug,owner,data.apps,style.visibility])
  const open=async(input:Record<string,unknown>)=>{setMenu(null);try{const p=await changeApps<CustomPanel>(slug,input);if(p.placement.mode==='canvas'){onShowCanvas();canvas.get(slug)?.focus(p.placement)}}catch(e){window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(e)}}))}}
  return createPortal(<div ref={ref} className="custom-apps-menu" role="dialog" aria-label="Apps" style={style}>
    <header><strong>Apps</strong><label className="custom-app-import-file">Import app<input type="file" aria-label="Import app" accept=".orgtree-app,.json,application/json" hidden onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;try{if(file.size>APP_BUNDLE_MAX)throw Error('App bundle exceeds 16 MiB.');const bundle=parseAppBundle(await file.text());setMenu(null);importApp(bundle,owner)}catch(error){window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(error)}}))}}}/></label><button type="button" onClick={()=>void loadAppsMenu(slug)}>Refresh</button></header>
    {data.error&&<p role="alert">{data.error}</p>}
    {!data.apps.length&&!data.loading&&<p className="dim">Your apps will appear here.</p>}
    {data.apps.map(app=><section key={app.id} className="custom-apps-menu-group">
      <div className="custom-apps-menu-app" data-new-app={app.is_new?app.id:undefined}><button type="button" className="custom-apps-open" onClick={()=>void open({action:'panel_open',app:app.id})}><AppsIcon/><span><b>{app.name}</b><small>{app.description}</small></span></button>
        {(app.is_new||seenHere.has(app.id))&&<b className="custom-app-new-label">New</b>}
        <button type="button" title={`Manage ${app.name}`} aria-label={`Manage ${app.name}`} onClick={()=>{setMenu(null);manage(app)}}><MoreIcon/></button></div>
      <button type="button" className="custom-apps-new" onClick={()=>void open({action:'panel_open',app:app.id,new:true})}>+ New panel</button>
      {data.panels.filter(p=>p.app===app.id).sort((a,b)=>b.used_at.localeCompare(a.used_at)).map(p=><button type="button" key={p.id} className="custom-apps-saved" onClick={()=>void open({action:'panel_open',panel:p.id})}><span className={p.open?'custom-app-dot open':'custom-app-dot'}/><span>{p.label}</span><small>{p.open?'Open':'Closed'}</small></button>)}
    </section>)}
    {data.appNext&&<button type="button" onClick={()=>void loadAppsMenu(slug,'apps')}>More apps</button>}
    {data.panelNext&&<button type="button" onClick={()=>void loadAppsMenu(slug,'panels')}>More saved panels</button>}
  </div>,owner.body)
}

function StateEditor({slug,panel,app,close}:{slug:string;panel:CustomPanel;app:CustomApp;close:()=>void}){
  const owner=useSurfaceDocument(),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(true),[rev,setRev]=useState(panel.rev)
  useEffect(()=>{let alive=true;void customAppsRequest<CustomPanel>(slug,{action:'panel_get',panel:panel.id}).then(p=>{if(alive){setText(JSON.stringify(p.state??{},null,2));setRev(p.rev);setBusy(false)}}).catch(e=>{if(alive){setError(String(e));setBusy(false)}});return()=>{alive=false}},[slug,panel.id])
  const value=()=>{if(new TextEncoder().encode(text).length>2*1024*1024)throw Error('State exceeds 2 MiB.');const v:unknown=JSON.parse(text);if(!v||Array.isArray(v)||typeof v!=='object')throw Error('State must be a JSON object.');return v}
  const save=async()=>{try{setBusy(true);await changeApps(slug,{action:'state_set',panel:panel.id,expected_rev:rev,state:value()});close()}catch(e){setError(String(e))}finally{setBusy(false)}}
  return <Dialog title={`${panel.label}: state`} close={close}>
    <p className="dim">Each panel keeps its own JSON data. Save reports a conflict if another edit arrived.</p>
    <textarea aria-label="Panel JSON state" spellCheck={false} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/>
    {error&&<p role="alert">{error}</p>}
    <div className="custom-app-dialog-actions"><label className="button">Import<input type="file" accept="application/json,.json" hidden onChange={async e=>{try{const f=e.target.files?.[0];if(!f)return;if(f.size>2*1024*1024)throw Error('State exceeds 2 MiB.');const text=await f.text();JSON.parse(text);setText(text);setError('')}catch(error){setError(String(error))}}}/></label>
      <button type="button" onClick={()=>{try{saveJson(owner,panel.label+'.json',value())}catch(e){setError(String(e))}}}>Export</button>
      <button type="button" onClick={async()=>{try{await owner.defaultView?.navigator.clipboard.writeText(JSON.stringify(value(),null,2))}catch(e){setError(String(e))}}}>Copy</button>
      <button type="button" onClick={async()=>{try{const a=await customAppsRequest<CustomApp>(slug,{action:'app_get',app:app.id});setText(JSON.stringify(a.definition?.initial_state??{},null,2))}catch(e){setError(String(e))}}}>Reset</button>
      <span/><button type="button" onClick={close}>Cancel</button><button type="button" className="primary" disabled={busy} onClick={()=>void save()}>Save</button></div>
  </Dialog>
}

function PanelBody({slug,app,panel,zoom}:{slug:string;app:CustomApp;panel:CustomPanel;zoom:number}){
  const surface=useSurface(),[dialog,setDialog]=useState<'state'|'rename'|'links'|'activity'|'permissions'|'delete'|null>(null),[input,setInput]=useState(''),[error,setError]=useState(''),[events,setEvents]=useState<PanelEvents['events']>([])
  const latest=useRef(panel);latest.current=panel
  const drag=useRef<{x:number;y:number;placement:AppPlacement;kind:'move'|'size'}|null>(null),[preview,setPreview]=useState<AppPlacement|null>(null)
  const update=async(fields:Record<string,unknown>)=>{try{setError('');return await changeApps<CustomPanel>(slug,{action:'panel_update',panel:panel.id,expected_rev:latest.current.rev,...fields})}catch(e){setError(String(e));throw e}}
  const close=()=>void update({open:false}).catch(()=>{})
  const place=(mode:AppPlacement['mode'])=>{const p={...latest.current.placement,mode,anchor:mode==='canvas'?latest.current.placement.anchor:null};if(mode==='canvas'&&latest.current.placement.mode!=='canvas')Object.assign(p,canvas.get(slug)?.center(p.width,p.height)??{x:100,y:100});void update({placement:p}).catch(()=>{})}
  const geometry=preview??panel.placement
  const style:CSSProperties=surface?.detached?{width:'100%',height:'100%'}:{width:geometry.width,height:geometry.height,...(preview?{transform:`translate(${preview.x-panel.placement.x}px,${preview.y-panel.placement.y}px)`}:{})}
  const start=(event:ReactPointerEvent<HTMLElement>,kind:'move'|'size')=>{if(surface?.detached||event.button!==0||(event.target as HTMLElement).closest('button,summary,details,input,select'))return;event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);drag.current={x:event.clientX,y:event.clientY,placement:{...panel.placement},kind}}
  const move=(event:ReactPointerEvent<HTMLElement>)=>{const d=drag.current;if(!d)return;event.stopPropagation();const scale=panel.placement.mode==='canvas'?zoom:1,dx=(event.clientX-d.x)/scale,dy=(event.clientY-d.y)/scale;setPreview(d.kind==='move'?{...d.placement,x:d.placement.x+dx,y:d.placement.y+dy}:{...d.placement,width:Math.round(Math.max(160,Math.min(4096,d.placement.width+dx))),height:Math.round(Math.max(120,Math.min(4096,d.placement.height+dy)))})}
  const end=()=>{drag.current=null;if(preview){void update({placement:preview}).catch(()=>{});setPreview(null)}}
  const show=(kind:typeof dialog)=>{setDialog(kind);setError('');setInput(kind==='rename'?panel.label:kind==='links'?panel.linked_agents.join('\n'):'')
    if(kind==='activity')void customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,limit:200}).then(async page=>{let all=page.events;if(page.next_cursor!==null){const next=await customAppsRequest<PanelEvents>(slug,{action:'events',panel:panel.id,after:page.next_cursor,limit:200});all=[...all,...next.events]}setEvents(all.reverse())}).catch(e=>setError(String(e)))
  }
  return <section className="custom-app-window" data-custom-panel={panel.id} data-detached={surface?.detached||undefined} style={style} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <header className="custom-app-title" onPointerDown={e=>start(e,'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null)}}>
      <AppsIcon/><strong title={`${app.name} · ${panel.label}`}>{app.name} · {panel.label}</strong>
      <details className="custom-app-more"><summary aria-label={`Panel menu: ${panel.label}`}><MoreIcon/></summary><div onClick={e=>{if((e.target as Element).closest("button"))(e.currentTarget.parentElement as HTMLDetailsElement).open=false}}>
        <button type="button" onClick={()=>show('state')}>State…</button><button type="button" onClick={()=>show('rename')}>Rename…</button><button type="button" onClick={()=>show('links')}>Linked agents…</button><button type="button" onClick={()=>show('activity')}>Activity…</button><button type="button" onClick={()=>show('permissions')}>Permissions…</button>
        <button type="button" onClick={()=>void changeApps(slug,{action:'panel_duplicate',panel:panel.id,expected_rev:latest.current.rev}).catch(e=>setError(String(e)))}>Duplicate</button>
        <button type="button" onClick={()=>place('float')}>Float</button><button type="button" onClick={()=>place('screen')}>Pin to screen</button><button type="button" onClick={()=>place('canvas')}>Pin to canvas</button>
        <button type="button" onClick={()=>show('delete')}>Delete panel…</button></div></details>
      <PopoutButton/><button type="button" className={'iconbtn'+(panel.placement.mode==='screen'?' active':'')} title={panel.placement.mode==='screen'?'Unpin':'Pin to screen'} aria-label={panel.placement.mode==='screen'?'Unpin':'Pin to screen'} onClick={()=>place(panel.placement.mode==='screen'?'float':'screen')}><PinIcon fontSize="inherit"/></button>
      <button type="button" className="iconbtn" aria-label={`Close ${panel.label}`} onClick={close}><CloseIcon fontSize="inherit"/></button>
    </header>
    {error&&<div role="alert" className="custom-app-error">{error}</div>}
    {surface?.error&&<div role="alert">{surface.error}</div>}
    <PanelHtml slug={slug} app={app} panel={panel}/>
    {!surface?.detached&&<div className="custom-app-resize" aria-label="Resize panel" onPointerDown={e=>{e.stopPropagation();e.currentTarget.setPointerCapture(e.pointerId);drag.current={x:e.clientX,y:e.clientY,placement:{...panel.placement},kind:'size'}}} onPointerMove={move} onPointerUp={end}/>}
    {dialog==='state'&&<StateEditor slug={slug} panel={panel} app={app} close={()=>setDialog(null)}/>}
    {(dialog==='rename'||dialog==='links')&&<Dialog title={dialog==='rename'?'Rename panel':'Linked agents'} close={()=>setDialog(null)}>
      <label>{dialog==='rename'?'Label':'Agent names, one per line'}<textarea aria-label={dialog==='rename'?'Panel label':'Linked agent names'} value={input} onChange={e=>setInput(e.target.value)}/></label>
      {dialog==='links'&&<p className="dim">Links do not grant permissions. Any eligible agent in this org can read or update the panel.</p>}
      <div className="custom-app-dialog-actions"><button type="button" onClick={()=>setDialog(null)}>Cancel</button><button type="button" className="primary" onClick={()=>void update(dialog==='rename'?{label:input}:{linked_agents:input.split(/[\n,]/).map(x=>x.trim().replace(/^@/, '')).filter(Boolean)}).then(()=>setDialog(null)).catch(()=>{})}>Save</button></div>
    </Dialog>}
    {dialog==='activity'&&<Dialog title="Panel activity" close={()=>setDialog(null)}><ol className="custom-app-activity">{events.map(e=><li key={e.seq}><time>{new Date(e.at).toLocaleString()}</time> {e.actor}: {e.name}<pre>{JSON.stringify(e.payload,null,2)}</pre></li>)}</ol></Dialog>}
    {dialog==='permissions'&&<AppPermissions slug={slug} app={app} close={()=>setDialog(null)}/>}
    {dialog==='delete'&&<Dialog title="Delete panel" close={()=>setDialog(null)}><p>Delete {panel.label} and its saved state?</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setDialog(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'panel_delete',panel:panel.id,expected_rev:latest.current.rev}).catch(e=>setError(String(e)))}>Delete panel</button></div></Dialog>}
  </section>
}

function PanelWindow({slug,panel,app}:{slug:string;panel:CustomPanel;app:CustomApp}){
  const anchor=useAnchor(slug,panel.id),latest=useRef(panel),outer=useRef<HTMLDivElement>(null);latest.current=panel
  if(panel.placement.mode==='canvas'&&!anchor)return null
  const p=panel.placement,k=key(slug,panel.id),world=p.mode==='canvas'
  const effective=world?panel:{...panel,placement:{...p,x:Math.max(8,Math.min(p.x,window.innerWidth-80)),y:Math.max(8,Math.min(p.y,window.innerHeight-40))}}
  return <div ref={outer} className={'custom-app-placeholder'+(world?' world':'')} style={world?undefined:{position:'fixed',left:effective.placement.x,top:effective.placement.y,width:p.width,height:p.height,zIndex:p.mode==='screen'?17:19}}>
    <MovableSurface org={slug} kind={'custom-app:'+panel.id} title={app.name+' · '+panel.label} anchor={world?anchor?.element:undefined}
      sourceBox={()=>{const r=outer.current?.querySelector('.custom-app-window')?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null}} exactSourceBox
      onDismiss={()=>{if(!windowExitStarted())void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:latest.current.rev,open:false}).catch(()=>{})}}
      onDetached={(detached,reason)=>{if(windowExitStarted()||reason==='close')return;const current=latest.current
        if(detached){if(current.placement.mode!=='popout')returns.set(k,{...current.placement});void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:current.rev,placement:{...current.placement,mode:'popout',anchor:null}}).catch(()=>{})}
        else if(current.placement.mode==='popout')void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:current.rev,placement:returns.get(k)??{...current.placement,mode:'float',anchor:null}}).catch(()=>{})
      }} minDimensions={{width:160,height:120}}>
      <PanelBody slug={slug} app={app} panel={effective} zoom={anchor?.zoom??1}/>
    </MovableSurface>
  </div>
}

export function AppsWorkspace({slug,onShowCanvas=()=>{}}:{slug:string;onShowCanvas?:()=>void}){
  const data=useApps(slug),current=useMenu(),[manage,setManage]=useState<CustomApp|null>(null),[imported,setImported]=useState<{bundle:AppBundle;owner:Document}|null>(null),[error,setError]=useState('')
  useEffect(()=>activateApps(slug),[slug])
  useEffect(()=>{const failure=(e:Event)=>{const d=(e as CustomEvent).detail;if(d?.slug===slug)setError(d.error)};window.addEventListener('custom-app-error',failure);return()=>window.removeEventListener('custom-app-error',failure)},[slug])
  return <>{current?.slug===slug&&<AppsMenu slug={slug} current={current} manage={setManage} importApp={(bundle,owner)=>setImported({bundle,owner})} onShowCanvas={onShowCanvas}/>}
    {data.panels.filter(p=>p.open).map(p=>{const app=data.apps.find(a=>a.id===p.app);return app?<PanelWindow key={p.id} slug={slug} panel={p} app={app}/>:null})}
    {error&&<div className="custom-app-global-error" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
    {manage&&createPortal(<div className="custom-app-management"><Dialog title={manage.name} close={()=>setManage(null)}><p>{manage.description}</p><p>Created by {manage.created_by}</p><AppExport key={manage.id} slug={slug} app={manage} owner={document}/><p>Deleting this app also deletes every saved panel and its state.</p><div className="custom-app-dialog-actions"><button type="button" onClick={()=>setManage(null)}>Cancel</button><button type="button" className="danger" onClick={()=>void changeApps(slug,{action:'app_delete',app:manage.id,expected_rev:manage.rev,delete_panels:true}).then(()=>setManage(null)).catch(e=>setError(String(e)))}>Delete app and panels</button></div></Dialog></div>,document.body)}
    {imported&&createPortal(<div className="custom-app-management"><Dialog title="Import app" close={()=>setImported(null)}><AppImport slug={slug} bundle={imported.bundle} close={()=>setImported(null)}/></Dialog></div>,imported.owner.body)}
  </>
}

function CanvasAnchor({slug,panel,point,zoom}:{slug:string;panel:CustomPanel;point:Point;zoom:number}){
  const node=useRef<HTMLDivElement|null>(null),currentZoom=useRef(zoom);currentZoom.current=zoom
  const ref=useCallback((element:HTMLDivElement|null)=>{node.current=element;putAnchor(slug,panel.id,element,currentZoom.current)},[slug,panel.id])
  useLayoutEffect(()=>{if(node.current)putAnchor(slug,panel.id,node.current,zoom)},[slug,panel.id,zoom])
  return <div ref={ref} className="custom-app-world-anchor" data-world-panel={panel.id} style={{left:point.x,top:point.y,width:panel.placement.width,height:panel.placement.height}}/>
}
export function AppsCanvasLayer({slug,zoom,viewport,nodePoint,focus,active=true}:{slug:string;zoom:number;viewport:WorldRect|null;nodePoint:(id:string)=>Point|undefined;focus:(point:Point)=>void;active?:boolean}){
  const data=useApps(slug)
  useEffect(()=>{canvas.set(slug,{center:(w,h)=>viewport?{x:viewport.x+(viewport.w-w)/2,y:viewport.y+(viewport.h-h)/2}:{x:100,y:100},focus});return()=>{canvas.delete(slug)}},[slug,viewport?.x,viewport?.y,viewport?.w,viewport?.h,focus])
  if(!active)return null
  return <>{data.panels.filter(p=>p.open&&p.placement.mode==='canvas').map(p=>{const anchor=p.placement.anchor?nodePoint(p.placement.anchor):undefined,point={x:p.placement.x+(anchor?.x??0),y:p.placement.y+(anchor?.y??0)}
    if(!intersectsViewport({...point,w:p.placement.width,h:p.placement.height},viewport))return null
    return zoom<.55?<button type="button" className="custom-app-mini" key={p.id} style={{left:point.x,top:point.y}} title={p.label} aria-label={`Show ${p.label}`} onPointerDown={e=>e.stopPropagation()} onClick={e=>{e.stopPropagation();focus(point)}}><AppsIcon/></button>:<CanvasAnchor key={p.id} slug={slug} panel={p} point={point} zoom={zoom}/>
  })}</>
}
