import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react'
import type {CSSProperties,PointerEvent as ReactPointerEvent,RefObject} from 'react'
import {createPortal} from 'react-dom'
import {AddIcon,AppsIcon,CloseIcon,PowerIcon,SettingsIcon,PinIcon} from '../../icons'
import PinOutlinedIcon from '@mui/icons-material/PushPinOutlined'
import {MovableSurface,PopoutButton,useSurface,useSurfaceDocument} from '../../popout'
import {desktop} from '../../desktop'
import {useContextMenu,type MenuEntry} from '../contextmenu'
import {windowExitStarted} from '../../windowlayout'
import {customAppsRequest} from '../../api'
import {activateApps,changeApps,createdAt,isRunning,loadAppsMenu,markAppsSeen,useApps} from './store'
import {samplePanels,usePanelCpu} from './runtime'
import {PanelHtml} from './host'
import {usePanelMotion,type PanelMotion} from './motion'
import {AppSettings,PanelSettings} from './settings'
import {AppDialog as Dialog} from './dialog'
import {PANEL_MIN,appPlacement,windowRect} from './placement'
import {appLinkTitle,panelLinkMenu,panelRunState} from './links'
import {pinSnapOn,useEsc} from '../shared'
import {APP_BUNDLE_MAX,AppImport,parseAppBundle} from './portable'
import type {AppBundle} from './portable'
import type {AppPlacement,CustomApp,CustomPanel} from './types'
import {canvasBox,pinLayerFor,pinSnapId,raisePinSurface,readPinSurfaces,useCanvasBox,usePinSurface} from '../pinspace'
import {revealDetachedPanel} from '../../windowlife'
import type {CanvasBox} from '../pinspace'
import {findPinSnap} from '../pinSnap'
import type {PinRect} from '../pins'
import './apps.css'

type Menu={slug:string;anchor:HTMLElement}|null
let menu:Menu=null
const menuSubs=new Set<()=>void>()
const returns=new Map<string,AppPlacement>()
/** A window pin's place in its org's pin layer, shared with pinned desks. */
type PinSlot={bounds:CanvasBox|null;z:number;key:string}
const key=(slug:string,id:string)=>slug+'\0'+id
/** USER 2026-10-27 (mffd8da23dc8f): the row of a panel that is already open and
 *  visible brings it to the front and focuses it. Each shown panel registers how
 *  it raises itself, as the shell's surfaces perform their own actions; hidden
 *  and stopped panels have none and open as before. */
const raisers=new Map<string,()=>void>()
/** Centered panels stack the way window pins do: the one shown or brought to the
 *  front last is on top and the others sit just under it (.custom-app-behind). */
const fronts=new Map<string,number>()
let frontSeq=0,frontVersion=0
const frontSubs=new Set<()=>void>()
function setFront(k:string,on:boolean){if(on)fronts.set(k,++frontSeq);else if(!fronts.delete(k))return;frontVersion++;for(const fn of frontSubs)fn()}
function useBehind(slug:string,k:string):boolean{
  useSyncExternalStore(fn=>{frontSubs.add(fn);return()=>frontSubs.delete(fn)},()=>frontVersion)
  const mine=fronts.get(k);if(mine===undefined)return false
  for(const [other,seq] of fronts)if(other!==k&&other.startsWith(slug+'\0')&&seq>mine)return true
  return false
}
/** Opens a saved panel, or the copy the engine picks for an app (its most recently
 *  used, or a first one), as the Apps list's rows do; panel and app mentions use it
 *  too. A copy that was already open and visible comes to the front and takes the
 *  focus; the request is the same panel_open, the use. Refusals reject. */
export async function openAppPanel(slug:string,target:{panel:string}|{app:string}):Promise<CustomPanel>{
  if('panel' in target){raisers.get(key(slug,target.panel))?.();return changeApps<CustomPanel>(slug,{action:'panel_open',panel:target.panel})}
  const shown=new Set(raisers.keys()),opened=await changeApps<CustomPanel>(slug,{action:'panel_open',app:target.app})
  if(shown.has(key(slug,opened.id)))raisers.get(key(slug,opened.id))?.()
  return opened
}
// The rows' hover text and panel menu are the app and panel LINKS', shared with
// @app:/@panel: mention chips (one link, one behaviour).
export {panelRunState}
const cpuText=(cpu:number|null|undefined,method:string|null|undefined)=>cpu===null||cpu===undefined?'':`${cpu<10?cpu.toFixed(1):Math.round(cpu)}% CPU${method==='shared process CPU'?' (shared)':''}`
function setMenu(value:Menu){menu=value;for(const fn of menuSubs)fn()}
function useMenu(){return useSyncExternalStore(fn=>{menuSubs.add(fn);return()=>menuSubs.delete(fn)},()=>menu)}
export function AppsButton({slug}:{slug:string}){
  const current=useMenu(),{newCount}=useApps(slug)
  return <button type="button" className={'iconbtn shell-action apps-button'+(newCount?' glow':'')} aria-label="Apps" title={newCount?`Apps · ${newCount} new`:'Apps'} aria-description={newCount?`${newCount} new apps`:undefined} aria-expanded={current?.slug===slug}
    onClick={e=>setMenu(current?.slug===slug?null:{slug,anchor:e.currentTarget})}><AppsIcon fontSize="inherit"/>{newCount>0&&<b className="eye-count asks">{newCount}</b>}</button>
}

function AppsMenu({slug,current,manage,managePanel,importApp}:{slug:string;current:NonNullable<Menu>;manage:(app:CustomApp)=>void;managePanel:(app:CustomApp,panel:CustomPanel)=>void;importApp:(bundle:AppBundle,owner:Document)=>void}){
  const data=useApps(slug),ref=useRef<HTMLDivElement>(null),owner=current.anchor.ownerDocument,cpu=usePanelCpu(slug),rowMenu=useContextMenu()
  const [style,setStyle]=useState<CSSProperties>({visibility:'hidden'})
  const [seenHere,setSeenHere]=useState<Set<string>>(()=>new Set()),pending=useRef(new Set<string>())
  useLayoutEffect(()=>{const win=owner.defaultView;if(!win||!ref.current)return;const a=current.anchor.getBoundingClientRect(),r=ref.current.getBoundingClientRect(),width=Math.min(320,win.innerWidth-16)
    setStyle({width,left:Math.max(8,Math.min(a.right-width,win.innerWidth-width-8)),top:Math.max(8,Math.min(a.bottom+6,win.innerHeight-r.height-8))})
  },[owner,current.anchor,data.apps.length,data.panels.length])
  // CPU is sampled only while this running list is open (user: CPU per panel).
  useEffect(()=>{const tick=()=>void samplePanels(slug);tick();const timer=setInterval(tick,3000);return()=>clearInterval(timer)},[slug])
  useEffect(()=>{void loadAppsMenu(slug);const pointer=(e:PointerEvent)=>{const target=e.target as Element|null;if(!ref.current?.contains(target)&&!current.anchor.contains(target)&&!target?.closest?.('.ctxmenu[role="menu"]'))setMenu(null)},keyboard=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMenu(null)}}
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
  const open=async(input:Record<string,unknown>)=>{setMenu(null);try{await changeApps<CustomPanel>(slug,input)}catch(e){window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(e)}}))}}
  // The saved rows keep their creation order, oldest first: opening, hiding and
  // power never move them (USER 2026-10-26 "Fixed order"). A click on the app row
  // opens the most recently used copy wherever it is listed, as the engine picks
  // one for panel_open with only the app (provisional, @coordinator-opus), or
  // creates one if none.
  const listed=(app:CustomApp)=>data.panels.filter(p=>p.app===app.id).sort((a,b)=>createdAt(a)-createdAt(b)||(a.id<b.id?-1:a.id>b.id?1:0))
  const used=(p:CustomPanel)=>Date.parse(p.used_at)||0
  const mostRecent=(rows:CustomPanel[])=>rows.reduce<CustomPanel|undefined>((best,p)=>!best||used(p)>used(best)||(used(p)===used(best)&&p.id>best.id)?p:best,undefined)
  // A visible panel's row, or an app row that resolves to one, also brings it to
  // the front; the click still records the use, so nothing else changes.
  const show=(target:{panel:string}|{app:string})=>{setMenu(null);openAppPanel(slug,target).catch(e=>window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(e)}})))}
  // Start running never shows a window; Power off stops and hides it. Power
  // changes send no revision: a running panel's own saves keep bumping it.
  const power=async(p:CustomPanel,action:'panel_start'|'panel_stop')=>{try{await changeApps(slug,{action,panel:p.id})}catch(e){window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(e)}}))}}
  const rowEntries=(p:CustomPanel):MenuEntry[]=>panelLinkMenu(slug,p)
  return createPortal(<div ref={ref} className="ctxmenu custom-apps-menu" role="dialog" aria-label="Apps" style={style}>
    <header><strong>Apps</strong><label className="custom-app-import-file">Import app<input type="file" aria-label="Import app" accept=".orgtree-app,.json,application/json" hidden onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;try{if(file.size>APP_BUNDLE_MAX)throw Error('App bundle exceeds 16 MiB.');const bundle=parseAppBundle(await file.text());setMenu(null);importApp(bundle,owner)}catch(error){window.dispatchEvent(new CustomEvent('custom-app-error',{detail:{slug,error:String(error)}}))}}}/></label><button type="button" onClick={()=>void loadAppsMenu(slug)}>Refresh</button></header>
    {data.error&&<p role="alert">{data.error}</p>}
    {!data.apps.length&&!data.loading&&<p className="dim">Your apps will appear here.</p>}
    {data.apps.map(app=>{const rows=listed(app),recent=mostRecent(rows);return <section key={app.id} className="custom-apps-menu-group">
      <div className="custom-apps-menu-app" data-new-app={app.is_new?app.id:undefined} onClick={()=>show(recent?{panel:recent.id}:{app:app.id})}><button type="button" className="custom-apps-open" title={appLinkTitle(app.name,recent?.label)}><AppsIcon/><span><b>{app.name}</b><small>{app.description}</small></span></button>
        {(app.is_new||seenHere.has(app.id))&&<b className="custom-app-new-label">New</b>}
        <button type="button" className="custom-apps-add" title="New panel" aria-label={`New panel for ${app.name}`} onClick={e=>{e.stopPropagation();void open({action:'panel_open',app:app.id,new:true})}}><AddIcon/></button>
        <button type="button" title={`App settings: ${app.name}`} aria-label={`Settings for ${app.name}`} onClick={e=>{e.stopPropagation();setMenu(null);manage(app)}}><SettingsIcon/></button></div>
      {/* User 2026-10-26: no Open/Closed word; the light alone shows state, named in the tooltip.
          The app's panels are their own group under it ("more visual delineation", provisional). */}
      {rows.length>0&&<div className="custom-apps-menu-panels" role="group" aria-label={`Panels of ${app.name}`}>{rows.map(p=>{const state=panelRunState(p),usage=isRunning(p)?cpuText(cpu.get(p.id)?.cpu,cpu.get(p.id)?.method):''
        return <div key={p.id} className="custom-apps-saved-row" onContextMenu={e=>rowMenu.open(e,()=>rowEntries(p))}><button type="button" className="custom-apps-saved" title={state.word} aria-label={p.label+', '+state.word.toLowerCase()} onClick={()=>show({panel:p.id})}><span className={'custom-app-dot'+(state.cls?' '+state.cls:'')} aria-hidden="true"/><span>{p.label}</span>{usage&&<small className="custom-app-cpu" title="Sampled CPU, one core = 100%">{usage}</small>}</button>
          {isRunning(p)&&<button type="button" className="custom-apps-saved-power" title={`Power off ${p.label}: stops it running`} aria-label={`Power off ${p.label}`} onClick={()=>void power(p,'panel_stop')}><PowerIcon/></button>}
          <button type="button" className="custom-apps-saved-gear" title={`Panel settings: ${p.label}`} aria-label={`Settings for ${p.label}`} onClick={()=>{setMenu(null);managePanel(app,p)}}><SettingsIcon/></button></div>})}</div>}
    </section>})}
    {data.appNext&&<button type="button" onClick={()=>void loadAppsMenu(slug,'apps')}>More apps</button>}
    {data.panelNext&&<button type="button" onClick={()=>void loadAppsMenu(slug,'panels')}>More saved panels</button>}
    {/* User 2026-10-27: panels are custom views for the user, not background
        programs, and run only while Orgtree is open, tray included (m49226c1da1fb, m281f01b7bf36, me7bdb85fd566). */}
    {data.panels.length>0&&<p className="dim custom-apps-note">Panels are custom views; they run only while Orgtree is open, tray included.</p>}
    {rowMenu.node}
  </div>,owner.body)
}

function PanelBody({slug,app,panel,shown,behind,layer,frame,motion}:{slug:string;app:CustomApp;panel:CustomPanel;shown:boolean;behind:boolean;layer:PinSlot|null;frame:RefObject<HTMLElement|null>;motion?:PanelMotion}){
  const surface=useSurface(),owner=useSurfaceDocument(),[settings,setSettings]=useState(false),[error,setError]=useState('')
  // Powered off and zooming out: already stopped, it takes no input.
  const stopping=motion==='stop'
  useLayoutEffect(()=>{frame.current?.toggleAttribute('inert',stopping)},[frame,stopping])
  const latest=useRef(panel);latest.current=panel
  const drag=useRef<{x:number;y:number;placement:AppPlacement;kind:'move'|'size'}|null>(null),[preview,setPreview]=useState<AppPlacement|null>(null),[free,setFree]=useState(false)
  const update=async(fields:Record<string,unknown>)=>{try{setError('');return await changeApps<CustomPanel>(slug,{action:'panel_update',panel:panel.id,expected_rev:latest.current.rev,...fields})}catch(e){setError(String(e));throw e}}
  // Hide closes the window and keeps the panel running; a popped-out window is
  // hidden natively, so its document and scripts survive. Power off stops it.
  // Hide is the header's far-right X (user 2026-10-26: an X instead of the crossed eye).
  const close=()=>{if(surface?.detached&&surface.name)void desktop()?.hidePopout?.(surface.name)?.catch(()=>{});void update({open:false}).catch(()=>{})}
  const powerOff=async()=>{try{setError('');await changeApps(slug,{action:'panel_stop',panel:panel.id})}catch(e){setError(String(e))}}
  const wasShown=useRef(shown)
  useEffect(()=>{if(shown&&!wasShown.current&&surface?.detached)surface.open();wasShown.current=shown},[shown,surface])
  // Only the front centered panel answers Esc: the others sit under its backdrop.
  useEsc(close,shown&&!stopping&&panel.placement.mode==='float'&&!surface?.detached&&!settings&&!behind,owner)
  // The Apps list's raise: a pop-out's own live window is restored and focused
  // (never reopened), a window pin rises above the other pinned windows, a
  // centered panel above the other centered panels. Then the panel's window
  // takes the focus, as a revealed pop-out does: Esc still hides a centered one
  // and Tab enters its content. The tabindex lasts only until it loses focus, so
  // clicks on the panel's chrome behave as before. Nothing closes, moves,
  // resizes or changes state.
  const raise=useRef(()=>{});raise.current=()=>{if(surface?.detached)revealDetachedPanel('custom-app:'+panel.id,slug);else if(layer)raisePinSurface(layer.key);else if(panel.placement.mode==='float')setFront(key(slug,panel.id),true)
    const win=frame.current;if(!win)return;if(!win.hasAttribute('tabindex')){win.tabIndex=-1;win.addEventListener('blur',()=>win.removeAttribute('tabindex'),{once:true})}win.focus({preventScroll:true})}
  useEffect(()=>{if(!shown||stopping)return;const k=key(slug,panel.id),fn=()=>raise.current();raisers.set(k,fn);return()=>{if(raisers.get(k)===fn)raisers.delete(k)}},[slug,panel.id,shown,stopping])
  // The pin pins the panel to the window where it is, at its size, like pinned
  // desks (user 2026-10-26: "i meant pin it to the window like other pinned
  // panels"); unpinning returns to the centered window. Canvas pins are gone.
  const pinned=panel.placement.mode==='window'
  const pin=()=>{const current=latest.current;void update({placement:appPlacement(current,current.placement.mode==='window'?'float':'window',frame.current?.getBoundingClientRect()??null,canvasBox(document,slug))}).catch(()=>{})}
  const geometry=preview??panel.placement,rect=layer?windowRect(geometry,layer.bounds):null
  const style:CSSProperties=surface?.detached?{width:'100%',height:'100%'}:rect&&layer?{position:'absolute',left:rect.x,top:rect.y,width:rect.w,height:rect.h,zIndex:layer.z}:{width:geometry.width,height:geometry.height}
  // Pinned desks' magnetism: edges of the canvas area and of other pinned windows; Shift places freely.
  const snap=(r:PinRect,kind:'move'|'size',off:boolean)=>layer&&!off&&pinSnapOn()?findPinSnap(layer.key,r,readPinSurfaces().filter(p=>p.org===slug).map(p=>({id:pinSnapId(p),rect:p.rect})),layer.bounds,kind==='size'?{edge:'se',minWidth:PANEL_MIN.width,minHeight:PANEL_MIN.height}:undefined):null
  const candidate=rect&&preview&&drag.current?snap(rect,drag.current.kind,free):null
  const start=(event:ReactPointerEvent<HTMLElement>,kind:'move'|'size')=>{if(surface?.detached||(kind==='move'&&!rect)||event.button!==0||(event.target as HTMLElement).closest('button,input,select'))return;event.preventDefault();event.stopPropagation();event.currentTarget.setPointerCapture(event.pointerId);if(layer)raisePinSurface(layer.key);drag.current={x:event.clientX,y:event.clientY,placement:rect?{...panel.placement,x:rect.x,y:rect.y,width:rect.w,height:rect.h}:{...panel.placement},kind}}
  const gesture=(d:NonNullable<typeof drag.current>,event:ReactPointerEvent<HTMLElement>):AppPlacement=>{const dx=event.clientX-d.x,dy=event.clientY-d.y;return d.kind==='move'?{...d.placement,x:d.placement.x+dx,y:d.placement.y+dy}:{...d.placement,width:Math.round(Math.max(160,Math.min(4096,d.placement.width+dx))),height:Math.round(Math.max(120,Math.min(4096,d.placement.height+dy)))}}
  const move=(event:ReactPointerEvent<HTMLElement>)=>{const d=drag.current;if(!d)return;event.stopPropagation();setFree(event.shiftKey);setPreview(gesture(d,event))}
  // One commit per gesture, from where the pointer ended; a window pin is
  // clamped into the canvas area and snapped, as pinned desks are.
  const end=(event:ReactPointerEvent<HTMLElement>)=>{const d=drag.current;if(!d)return;drag.current=null;setPreview(null);if(Math.hypot(event.clientX-d.x,event.clientY-d.y)<3)return
    const g=gesture(d,event);if(!layer){void update({placement:g}).catch(()=>{});return}
    const r=windowRect(g,layer.bounds),f=snap(r,d.kind,event.shiftKey)?.rect??r
    void update({placement:{...g,x:Math.round(f.x),y:Math.round(f.y),width:Math.round(f.w),height:Math.round(f.h)}}).catch(()=>{})}
  return <><section ref={frame} className="settings custom-app-window" data-custom-panel={panel.id} data-motion={motion} data-parked={!shown||undefined} data-detached={surface?.detached||undefined} data-centered={panel.placement.mode==='float'&&!surface?.detached||undefined} data-pinned={!!rect||undefined} style={style} onPointerDownCapture={layer?()=>raisePinSurface(layer.key):undefined} onPointerDown={e=>e.stopPropagation()} onWheel={e=>e.stopPropagation()} onKeyDown={e=>e.stopPropagation()}>
    <header className="modalpin-bar on custom-app-title" onPointerDown={e=>start(e,'move')} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null)}}>
      <AppsIcon/><strong className="modalpin-name" title={app.name+' · '+panel.label}>{app.name} · {panel.label}</strong>
      <button type="button" className="modalpin-btn" title="Panel settings" aria-label={'Settings for '+panel.label} onClick={()=>setSettings(true)}><SettingsIcon fontSize="inherit"/></button>
      <PopoutButton/>{!surface?.detached&&<button type="button" className={'modalpin-btn'+(pinned?' active':'')} title={pinned?'Unpin: back to the middle of the screen':'Pin to window: it stays put and can be dragged around'} aria-label={pinned?'Unpin':'Pin to window'} aria-pressed={pinned} onClick={pin}>{pinned?<PinIcon fontSize="inherit"/>:<PinOutlinedIcon fontSize="inherit"/>}</button>}
      <button type="button" className="modalpin-btn custom-app-power" title="Power off: stops the panel and closes the window" aria-label={'Power off '+panel.label} onClick={()=>void powerOff()}><PowerIcon fontSize="inherit"/></button>
      <button type="button" className="modalpin-btn" title="Hide: closes the window, keeps the panel running" aria-label={'Hide '+panel.label} onClick={close}><CloseIcon fontSize="inherit"/></button>
    </header>
    {error&&<div role="alert" className="custom-app-error">{error}</div>}{surface?.error&&<div role="alert">{surface.error}</div>}
    <PanelHtml slug={slug} app={app} panel={panel} visible={shown&&!stopping} stopping={stopping}/>
    {!surface?.detached&&<div className="custom-app-resize" aria-label="Resize panel" onPointerDown={e=>start(e,'size')} onPointerMove={move} onPointerUp={end} onPointerCancel={()=>{drag.current=null;setPreview(null)}}/>}
    {settings&&!stopping&&<PanelSettings slug={slug} app={app} panel={panel} close={()=>setSettings(false)}/>}
  </section>{candidate&&<div className="pin-snap-preview" role="status" style={{left:candidate.rect.x,top:candidate.rect.y,width:candidate.rect.w,height:candidate.rect.h}}><span>{candidate.snap.target===null?candidate.label:'Snap beside pinned window'} · Shift for free placement</span></div>}</>
}

function PanelWindow({slug,panel,app,motion}:{slug:string;panel:CustomPanel;app:CustomApp;motion?:PanelMotion}){
  const latest=useRef(panel),outer=useRef<HTMLDivElement>(null),frame=useRef<HTMLElement>(null),backdrop=useRef<boolean|null>(null);latest.current=panel
  const p=panel.placement,k=key(slug,panel.id),stopping=motion==='stop'
  // Visible => running is enforced by the caller; a hidden running copy stays
  // mounted, parked. A window pin lives in the org's pin layer with pinned
  // desks: their canvas-area coordinates, stacking and snapping.
  const shown=panel.open,parked=!shown,centered=p.mode==='float'&&shown,pinned=p.mode==='window'&&shown
  const bounds=useCanvasBox(document,pinned?slug:null)
  const layout=usePinSurface(pinned?slug:null,'custom-app:'+panel.id,pinned?windowRect(p,bounds):null,true)
  const effective=pinned?panel:{...panel,placement:{...p,x:Math.max(8,Math.min(p.x,window.innerWidth-80)),y:Math.max(8,Math.min(p.y,window.innerHeight-40))}}
  // React 18 has no inert prop: a parked panel takes no focus or input.
  useLayoutEffect(()=>{outer.current?.toggleAttribute('inert',parked)},[parked])
  // A centered panel enters the centered stack in front, as a new window pin
  // does, and leaves it when it is hidden, pinned or popped out.
  useLayoutEffect(()=>{if(!centered)return;setFront(k,true);return()=>setFront(k,false)},[centered,k])
  const behind=useBehind(slug,k)
  return <div ref={outer} className={parked?'custom-app-parked':centered?'overlay custom-app-centered'+(behind?' custom-app-behind':''):'custom-app-placeholder'+(pinned?' pinned':'')} data-motion={motion} aria-hidden={parked||undefined} style={parked?{width:p.width,height:p.height}:centered||pinned?undefined:{position:'fixed',left:effective.placement.x,top:effective.placement.y,width:p.width,height:p.height,zIndex:19}} onPointerDownCapture={e=>{backdrop.current=e.target===e.currentTarget}} onClick={e=>{if(centered&&!stopping&&e.target===e.currentTarget&&backdrop.current!==false)void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:latest.current.rev,open:false}).catch(()=>{});backdrop.current=null}}>
    <MovableSurface org={slug} kind={'custom-app:'+panel.id} title={app.name+' · '+panel.label} anchor={pinned?pinLayerFor(slug):undefined} parked={parked} preserveFrames
      sourceBox={()=>{const r=frame.current?.getBoundingClientRect();return r?{x:r.x,y:r.y,w:r.width,h:r.height}:null}} exactSourceBox
      onDismiss={()=>{if(!stopping&&!windowExitStarted())void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:latest.current.rev,open:false}).catch(()=>{})}}
      onDetached={(detached,reason)=>{if(stopping||windowExitStarted()||reason==='close')return;const current=latest.current
        if(detached){if(current.placement.mode!=='popout')returns.set(k,{...current.placement});void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:current.rev,placement:{...current.placement,mode:'popout'}}).catch(()=>{})}
        else if(current.placement.mode==='popout')void changeApps(slug,{action:'panel_update',panel:panel.id,expected_rev:current.rev,placement:returns.get(k)??{...current.placement,mode:'float'}}).catch(()=>{})
      }} minDimensions={{width:160,height:120}}>
      <PanelBody slug={slug} app={app} panel={effective} shown={shown} behind={centered&&behind} layer={pinned?{bounds,z:layout.z,key:layout.key}:null} frame={frame} motion={motion}/>
    </MovableSurface>
  </div>
}

export function AppsWorkspace({slug}:{slug:string}){
  const data=useApps(slug),current=useMenu(),[manage,setManage]=useState<{app:CustomApp;panel?:CustomPanel;owner:Document}|null>(null),[imported,setImported]=useState<{bundle:AppBundle;owner:Document}|null>(null),[error,setError]=useState('')
  useEffect(()=>activateApps(slug),[slug])
  // Running copies, plus a visible one that just stopped while it zooms out.
  const shown=usePanelMotion(data.panels,data.apps,data.loaded)
  useEffect(()=>{const failure=(e:Event)=>{const d=(e as CustomEvent).detail;if(d?.slug===slug)setError(d.error)};window.addEventListener('custom-app-error',failure);return()=>window.removeEventListener('custom-app-error',failure)},[slug])
  return <>{current?.slug===slug&&<AppsMenu slug={slug} current={current} manage={app=>setManage({app,owner:current.anchor.ownerDocument})} managePanel={(app,panel)=>setManage({app,panel,owner:current.anchor.ownerDocument})} importApp={(bundle,owner)=>setImported({bundle,owner})}/>}
    {shown.map(({panel,app,motion})=><PanelWindow key={panel.id} slug={slug} panel={panel} app={app} motion={motion}/>)}
    {error&&<div className="custom-app-global-error" role="alert">{error}<button onClick={()=>setError('')}>Dismiss</button></div>}
    {manage&&(manage.panel?<PanelSettings key={manage.panel.id} slug={slug} app={manage.app} panel={manage.panel} owner={manage.owner} close={()=>setManage(null)}/>:<AppSettings slug={slug} app={manage.app} owner={manage.owner} close={()=>setManage(null)}/>)}
    {imported&&<Dialog title="Import app" close={()=>setImported(null)} owner={imported.owner}><AppImport slug={slug} bundle={imported.bundle} close={()=>setImported(null)}/></Dialog>}
  </>
}
